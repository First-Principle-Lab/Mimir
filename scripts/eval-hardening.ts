import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redis } from "ioredis";
import { io, type Socket } from "socket.io-client";
import { loadEnv } from "./_env.js";
import { appendRow, newRunId } from "./eval/lib.js";

// Phase 6 gate: concurrent multi-user load against two real API processes that
// share Redis (socket.io adapter, presence registry, pub/sub claims) and one
// worker running the production queues, job wrapper and harness processors,
// with every connection under the row-level-security role.
//
// Part 1 uses pi's faux model (with latency and an injected budget charge) to load chat,
// background-agent fan-out, watcher polling fan-out, budgets and instance
// failover. Part 2 repeats the core paths with actual model inference.
// Connected-account reads are synthetic; nothing external is touched.
//
//   bun scripts/eval-hardening.ts      (HARDENING_SCALE=2 doubles the load)
loadEnv();
for (const name of ["DATABASE_URL", "REDIS_URL"] as const) {
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(process.env[name] ?? "http://missing").hostname,
    )
  ) {
    console.error("GATE NOT RUN: local services required");
    process.exit(2);
  }
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("GATE NOT RUN: OPENROUTER_API_KEY missing (part 2 needs it)");
  process.exit(2);
}
// A dedicated Redis database: the suite uses production queue names.
const REDIS_DB = 9;
const redisUrl = new URL(process.env.REDIS_URL!);
redisUrl.pathname = `/${REDIS_DB}`;
process.env.REDIS_URL = redisUrl.toString();
process.env.DATABASE_RLS_ROLE = "mimir_rls";
for (const key of Object.keys(process.env))
  if (key.startsWith("OTEL_") || key.startsWith("VAPID_"))
    delete process.env[key];
process.env.OTEL_SDK_DISABLED = "true";
const SCALE = Number(process.env.HARDENING_SCALE ?? 1);
if (!Number.isInteger(SCALE) || SCALE < 1 || SCALE > 10) {
  console.error("HARDENING_SCALE must be an integer from 1 to 10");
  process.exit(64);
}

const marker = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
if (
  (await marker.dbsize()) > 0 &&
  !(await marker.exists("mimir-hardening-suite"))
) {
  console.error(
    `GATE NOT RUN: Redis db ${REDIS_DB} holds other data; refusing to flush it`,
  );
  process.exit(2);
}
await marker.flushdb();
await marker.set("mimir-hardening-suite", "1");

const core = await import("../packages/backend-core/src/index.js");
const {
  budgetDay,
  createPrismaClient,
  getConfig,
  getPrismaClient,
  rlsRoleStatements,
} = core;
const owner = createPrismaClient(process.env.DATABASE_URL!);
for (const sql of rlsRoleStatements("mimir_rls"))
  await owner.$executeRawUnsafe(sql);

const { Worker } = await import("bullmq");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } =
  await import("@earendil-works/pi-ai/compat");
const { setModelOverrideForTests } =
  await import("../apps/worker/src/harness/pi-runtime.js");
const {
  jobProcessor,
  conversationTurns,
  maintenanceJobs,
  maintenanceProcessor,
} = await import("../apps/worker/src/infra/queues.js");
const { startOutboxRelay } =
  await import("../apps/worker/src/infra/outbox-relay.js");
const { createTurnProcessor } =
  await import("../apps/worker/src/harness/turn.js");
const { agentJobs, createAgentProcessor } =
  await import("../apps/worker/src/harness/agents.js");
const { routineJobs, runRoutine } =
  await import("../apps/worker/src/routines/routines.js");
const { readToolsFor } = await import("../apps/worker/src/harness/tools.js");
const { signAccessToken } = await import("../apps/api/src/auth/tokens.js");
const { GMAIL_INTEGRATION } =
  await import("../packages/connection-provider/src/index.js");
import type { ToolSpec } from "../apps/worker/src/harness/tools.js";

const prisma = getPrismaClient();
const connection = { url: process.env.REDIS_URL!, maxRetriesPerRequest: null };
const runId = newRunId();
const users: string[] = [];
const children: ChildProcess[] = [];
const workers: InstanceType<typeof Worker>[] = [];
const sockets: Socket[] = [];
const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const logDir = mkdtempSync(join(tmpdir(), "mimir-hardening-"));

function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}
function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
}
const ms = (n: number) => Math.round(n);
async function waitUntil(
  ok: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(100);
  }
}

// ---- synthetic connected accounts -------------------------------------------
const mailboxes = new Map<
  string,
  { id: string; subject: string; body: string }[]
>();
const CEDAR = {
  id: "cedar-1",
  subject: "Cedar launch update",
  body: "The Cedar launch date moved to 1 December 2026. The launch budget of USD 40,000 is approved.",
};
let toolCalls = 0;
async function syntheticReads(userId: string): Promise<ToolSpec[]> {
  return (await readToolsFor(userId)).map((spec) => ({
    ...spec,
    execute: async (args: unknown) => {
      toolCalls += 1;
      await Bun.sleep(30); // provider round trip
      if (spec.name === "search_email") {
        const routineMailbox = (args as { mailbox?: string })?.mailbox;
        return { messages: mailboxes.get(routineMailbox ?? userId) ?? [CEDAR] };
      }
      return { results: [] };
    },
  }));
}

// ---- processes -----------------------------------------------------------
async function startApi(name: string, port: number): Promise<ChildProcess> {
  const log = openSync(join(logDir, `${name}.log`), "a");
  const child = spawn("bun", ["apps/api/src/server.ts"], {
    env: { ...process.env, PORT: String(port), MIMIR_INSTANCE_ID: name },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  children.push(child);
  await waitUntil(
    async () =>
      (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))
        ?.status === 200,
    `${name} health`,
    30_000,
  );
  return child;
}
const ports = [4600 + Math.floor(Math.random() * 300), 0];
ports[1] = ports[0]! + 1;
const bases = ports.map((p) => `http://127.0.0.1:${p}`);

// ---- faux model -------------------------------------------------------------
type Ctx = {
  systemPrompt?: string;
  messages: { role: string; content: unknown }[];
};
const textOf = (m: { content: unknown } | undefined) =>
  !m
    ? ""
    : typeof m.content === "string"
      ? m.content
      : (m.content as { type: string; text?: string }[])
          .map((c) => c.text ?? "")
          .join("");
let fauxCalls = 0;
const fauxLatency = { interaction: 200, agent: 1200 };
async function router(context: Ctx) {
  fauxCalls += 1;
  const worker = (context.systemPrompt ?? "").includes("# Your role");
  const runtimeTail = textOf(context.messages.at(-1));
  const messages = context.messages.filter(
    (m) =>
      !textOf(m).includes("<response_contract>") &&
      !textOf(m).startsWith("<user_profile>"),
  );
  const last = messages.at(-1);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = textOf(lastUser);
  await Bun.sleep(
    (worker ? fauxLatency.agent : fauxLatency.interaction) *
      (0.6 + Math.random() * 0.8),
  );
  if (worker)
    return fauxAssistantMessage([fauxText(`Findings: ${prompt.slice(0, 60)}`)]);
  const ambient = runtimeTail.includes("Mode: ambient");
  if (!runtimeTail.includes("<response_contract>"))
    return fauxAssistantMessage([
      fauxText("Preserve the user request and pending results."),
    ]);
  if (last?.role === "toolResult")
    return fauxAssistantMessage([
      fauxText(ambient ? "NO_REPLY" : "Started the background agents."),
    ]);
  if (ambient) {
    // Agent results are worth telling; watcher events in this suite are not.
    if (prompt.includes("agent_result") || prompt.includes("Findings:"))
      return fauxAssistantMessage(
        [
          fauxToolCall("send_to_user", {
            text: "A background agent finished its research.",
            urgency: "normal",
            reason_code: "task_completed",
          }),
        ],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage([fauxText("NO_REPLY")]);
  }
  const spawnCount = /\[spawn:(\d+)\]/.exec(prompt);
  if (spawnCount)
    return fauxAssistantMessage(
      Array.from({ length: Number(spawnCount[1]) }, (_, i) =>
        fauxToolCall("spawn_agent", {
          objective: `Research topic ${i + 1} for the load test`,
        }),
      ),
      { stopReason: "toolUse" },
    );
  const tag = /load-([0-9a-f-]{36})/.exec(prompt)?.[1] ?? "none";
  return fauxAssistantMessage([fauxText(`Got load-${tag}.`)]);
}

// ---- users and clients ----------------------------------------------------
interface LoadUser {
  id: string;
  conversationId: string;
  cookie: string;
  received: {
    messageId: string;
    content: string;
    conversationId: string;
    at: number;
  }[];
  foreign: number;
}
async function createUser(
  prefix: string,
  extra: { dailyBudgetUsd?: number } = {},
) {
  const id = `${prefix}-${randomUUID()}`;
  users.push(id);
  await owner.user.create({
    data: {
      id,
      email: `${id}@example.test`,
      passwordHash: "synthetic",
      timezone: "UTC",
      ...extra,
    },
  });
  const conversation = await owner.conversation.create({
    data: { userId: id },
  });
  await owner.integrationConnection.create({
    data: {
      userId: id,
      provider: GMAIL_INTEGRATION,
      connectionId: `synthetic-${randomUUID()}`,
      status: "connected",
    },
  });
  const user: LoadUser = {
    id,
    conversationId: conversation.id,
    cookie: `access_token=${await signAccessToken(id, getConfig().JWT_SECRET)}`,
    received: [],
    foreign: 0,
  };
  return user;
}
function connect(user: LoadUser, base: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(base, {
      transports: ["websocket"],
      extraHeaders: { Cookie: user.cookie },
      reconnection: false,
    });
    sockets.push(socket);
    socket.on(
      "new_message",
      (p: {
        conversationId: string;
        messageId: string;
        content: string;
        deliveryIds?: string[];
      }) => {
        if (p.conversationId !== user.conversationId) user.foreign += 1;
        user.received.push({
          messageId: p.messageId,
          content: p.content,
          conversationId: p.conversationId,
          at: Date.now(),
        });
        if (p.deliveryIds?.length) socket.emit("delivery_ack", p.deliveryIds);
      },
    );
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}
async function post(user: LoadUser, base: string, content: string) {
  const started = performance.now();
  const res = await fetch(`${base}/api/v1/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: user.cookie },
    body: JSON.stringify({
      conversationId: user.conversationId,
      content,
      clientMessageId: randomUUID(),
    }),
  });
  return { res, intakeMs: performance.now() - started, started: Date.now() };
}
const presence = (userId: string) =>
  marker.zcount(`user-sockets:${userId}`, Date.now(), "+inf");

// ---- worker ------------------------------------------------------------------
function startWorker() {
  const turnProcessor = createTurnProcessor({
    readTools: syntheticReads,
    agentQueue: agentJobs,
  });
  const agentProcessor = createAgentProcessor({ readTools: syntheticReads });
  workers.push(
    new Worker(
      conversationTurns.name,
      jobProcessor(conversationTurns.name, turnProcessor),
      { connection, concurrency: 20 },
    ),
    new Worker(
      agentJobs.name,
      jobProcessor(agentJobs.name, (job) =>
        agentProcessor(job as never, job.token),
      ),
      { connection, concurrency: 10 },
    ),
    new Worker(
      routineJobs.name,
      jobProcessor(routineJobs.name, (job) => runRoutine(job, syntheticReads)),
      { connection, concurrency: 10 },
    ),
    new Worker(
      maintenanceJobs.name,
      jobProcessor(maintenanceJobs.name, maintenanceProcessor),
      { connection, concurrency: 20 },
    ),
  );
  return startOutboxRelay(250);
}

let stopRelay: (() => void) | null = null;
let exitCode = 0;
const t0 = Date.now();
try {
  // Faux model supplies deterministic load; the budget section injects spend.
  const faux = registerFauxProvider({
    provider: "mimir-hardening-faux",
    models: [
      {
        id: "hardening-model",
        cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  });
  const dir = mkdtempSync(join(tmpdir(), "mimir-hardening-faux-"));
  const mr = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  const fm = faux.getModel();
  mr.registerProvider(fm.provider, {
    baseUrl: fm.baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      input: m.input,
      inputLimits: m.inputLimits,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      baseUrl: m.baseUrl,
    })),
  } as Parameters<typeof mr.registerProvider>[1]);
  setModelOverrideForTests({
    modelRuntime: mr,
    model: mr.getModel(fm.provider, fm.id)!,
  });
  faux.setResponses(Array.from({ length: 50_000 }, () => router as never));

  await Promise.all([
    startApi("api-a", ports[0]!),
    startApi("api-b", ports[1]!),
  ]);
  stopRelay = startWorker();
  await Promise.all(workers.map((w) => w.waitUntilReady()));

  // ---- A: concurrent chat across instances ----------------------------------
  const CHAT_USERS = 40 * SCALE;
  const PER_USER = 3;
  const chatUsers = await Promise.all(
    Array.from({ length: CHAT_USERS }, () => createUser("load-chat")),
  );
  // Socket on one instance, HTTP to the other: every reply crosses instances.
  await Promise.all(chatUsers.map((u, i) => connect(u, bases[i % 2]!)));
  const intake: number[] = [];
  const replyLatency: number[] = [];
  let refused = 0;
  const chatStart = Date.now();
  await Promise.all(
    chatUsers.map(async (u, i) => {
      for (let k = 0; k < PER_USER; k++) {
        const tag = randomUUID();
        const { res, intakeMs, started } = await post(
          u,
          bases[(i + 1) % 2]!,
          `load-${tag} hello`,
        );
        intake.push(intakeMs);
        if (res.status !== 202) {
          refused += 1;
          continue;
        }
        await waitUntil(
          () => u.received.some((r) => r.content.includes(tag)),
          `reply ${tag}`,
          90_000,
        );
        replyLatency.push(
          u.received.find((r) => r.content.includes(tag))!.at - started,
        );
      }
    }),
  );
  const chatSeconds = (Date.now() - chatStart) / 1000;
  const totalReplies = chatUsers.reduce((n, u) => n + u.received.length, 0);
  const duplicateDeliveries = chatUsers.reduce(
    (n, u) =>
      n + u.received.length - new Set(u.received.map((r) => r.messageId)).size,
    0,
  );
  const storedReplies = await owner.message.count({
    where: {
      conversationId: { in: chatUsers.map((u) => u.conversationId) },
      role: "assistant",
    },
  });
  const chat = {
    users: CHAT_USERS,
    messages: CHAT_USERS * PER_USER,
    seconds: chatSeconds,
    intakeP50: ms(pct(intake, 50)),
    intakeP95: ms(pct(intake, 95)),
    replyP50: ms(pct(replyLatency, 50)),
    replyP95: ms(pct(replyLatency, 95)),
  };
  console.log("chat load", chat);
  appendRow("hardening", runId, { part: "faux", scenario: "chat", ...chat });
  check("every chat message accepted", refused === 0, { refused });
  check(
    "one stored reply per message",
    storedReplies === CHAT_USERS * PER_USER,
    { storedReplies },
  );
  check(
    "every reply delivered once over the other instance",
    totalReplies === CHAT_USERS * PER_USER && duplicateDeliveries === 0,
    { totalReplies, duplicateDeliveries },
  );
  check(
    "no socket received another user's conversation",
    chatUsers.every((u) => u.foreign === 0),
  );
  check(
    "intake p95 under 1s under load",
    chat.intakeP95 < 1000,
    chat.intakeP95,
  );
  const foreign = await fetch(`${bases[0]}/api/v1/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: chatUsers[0]!.cookie,
    },
    body: JSON.stringify({
      conversationId: chatUsers[1]!.conversationId,
      content: "foreign write must be refused",
      clientMessageId: randomUUID(),
    }),
  });
  check(
    "RLS-backed HTTP intake refuses a foreign conversation",
    foreign.status === 404,
  );

  // ---- B: background agent fan-out ------------------------------------------
  const AGENT_USERS = 12 * SCALE;
  const PER_TASK = 5;
  const agentUsers = await Promise.all(
    Array.from({ length: AGENT_USERS }, () => createUser("load-agents")),
  );
  await Promise.all(agentUsers.map((u, i) => connect(u, bases[i % 2]!)));
  const agentStart = Date.now();
  let maxRunning = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const rows = await owner.agentRun.groupBy({
        by: ["userId"],
        where: {
          userId: { in: agentUsers.map((u) => u.id) },
          trigger: "agent",
          depth: 1,
          status: "running",
        },
        _count: true,
      });
      for (const r of rows) maxRunning = Math.max(maxRunning, r._count);
      await Bun.sleep(150);
    }
  })();
  const spawned = await Promise.all(
    agentUsers.map((u, i) =>
      post(u, bases[(i + 1) % 2]!, `[spawn:${PER_TASK}] research these`),
    ),
  );
  const agentRuns = () =>
    owner.agentRun.findMany({
      where: {
        userId: { in: agentUsers.map((u) => u.id) },
        trigger: "agent",
        depth: 1,
      },
      select: { status: true, userId: true, costUsd: true, id: true },
    });
  await waitUntil(
    async () => (await agentRuns()).length === AGENT_USERS * PER_TASK,
    "agents spawned",
    120_000,
  );
  const duringFanout = await Promise.all(
    chatUsers.slice(0, 8).map(async (u) => {
      const tag = randomUUID();
      const { res, started } = await post(
        u,
        bases[0]!,
        `load-${tag} chat while agents run`,
      );
      if (res.status !== 202) return false;
      await waitUntil(
        () => u.received.some((r) => r.content.includes(tag)),
        "chat during fanout",
        60_000,
      );
      return (
        u.received.find((r) => r.content.includes(tag))!.at - started < 10_000
      );
    }),
  );
  check(
    "chat remains responsive during background fan-out",
    duringFanout.every(Boolean),
  );
  await waitUntil(
    async () =>
      (await agentRuns()).every(
        (r) => !["queued", "running"].includes(r.status),
      ),
    "agents finished",
    300_000,
  );
  await waitUntil(
    async () =>
      (await owner.inboxInput.count({
        where: {
          conversationId: { in: agentUsers.map((u) => u.conversationId) },
          kind: "agent_result",
          status: { not: "consumed" },
        },
      })) === 0,
    "agent results consumed",
    180_000,
  );
  await waitUntil(
    () => agentUsers.every((u) => u.received.length >= 2),
    "agent updates delivered",
    120_000,
  );
  sampling = false;
  await sampler;
  const runs = await agentRuns();
  const resultInputs = await owner.inboxInput.count({
    where: {
      conversationId: { in: agentUsers.map((u) => u.conversationId) },
      kind: "agent_result",
    },
  });
  const agents = {
    users: AGENT_USERS,
    agents: runs.length,
    seconds: (Date.now() - agentStart) / 1000,
    maxRunningPerUser: maxRunning,
    succeeded: runs.filter((r) => r.status === "succeeded").length,
  };
  console.log("agent fan-out", agents);
  appendRow("hardening", runId, {
    part: "faux",
    scenario: "agents",
    ...agents,
  });
  check(
    "every spawn accepted",
    spawned.every((s) => s.res.status === 202),
  );
  check(
    "all background agents succeeded",
    agents.succeeded === AGENT_USERS * PER_TASK,
    agents.succeeded,
  );
  check(
    "per-user running limit held under fan-out",
    maxRunning <= 3 && maxRunning >= 2,
    maxRunning,
  );
  check("exactly one result posted per agent", resultInputs === runs.length, {
    resultInputs,
  });
  check(
    "agent updates reached every user",
    agentUsers.every((u) => u.foreign === 0 && u.received.length >= 2),
  );

  // ---- C: watcher polling fan-out -----------------------------------------
  const WATCH_USERS = 30 * SCALE;
  const PER_USER_WATCHERS = 10;
  const watchUsers = await Promise.all(
    Array.from({ length: WATCH_USERS }, () => createUser("load-watch")),
  );
  const routines: { id: string; mailbox: string; userId: string }[] = [];
  for (const u of watchUsers)
    for (let k = 0; k < PER_USER_WATCHERS; k++) {
      const mailbox = `${u.id}:${k}`;
      const routine = await owner.routine.create({
        data: {
          conversationId: u.conversationId,
          userId: u.id,
          instruction: "Tell me about new mail from the board",
          source: "gmail",
          query: {
            tool: "search_email",
            args: { query: "from:board", mailbox },
          },
          timing: { type: "interval", everyMs: 300_000 },
        },
      });
      routines.push({ id: routine.id, mailbox, userId: u.id });
      // 20% of watched mailboxes have something; the rest are empty.
      mailboxes.set(
        mailbox,
        k < 2
          ? [{ id: `m-${k}`, subject: "Board notes", body: "Agenda attached." }]
          : [],
      );
    }
  const wakes = () =>
    owner.inboxInput.count({
      where: {
        conversationId: { in: watchUsers.map((u) => u.conversationId) },
        kind: "event",
      },
    });
  async function fireAll(wave: string) {
    const before = toolCalls;
    const started = Date.now();
    await routineJobs.addBulk(
      routines.map((r) => ({
        name: "routine",
        data: { routineId: r.id },
        opts: { jobId: `load-${wave}-${r.id}`, removeOnComplete: true },
      })),
    );
    await waitUntil(
      async () =>
        (await routineJobs.getJobCounts("waiting", "active", "delayed"))
          .waiting +
          (await routineJobs.getJobCounts("active")).active ===
          0 && toolCalls - before >= routines.length,
      `wave ${wave}`,
      120_000,
    );
    return {
      seconds: (Date.now() - started) / 1000,
      checks: toolCalls - before,
    };
  }
  const wave1 = await fireAll("1");
  const afterWave1 = await wakes();
  const wave2 = await fireAll("2");
  const afterWave2 = await wakes();
  // A tenth of the empty mailboxes receive mail.
  const changed = routines.filter((_, i) => i % PER_USER_WATCHERS === 5);
  for (const r of changed)
    mailboxes.set(r.mailbox, [
      { id: "new", subject: "Board vote", body: "Vote on Friday." },
    ]);
  const wave3 = await fireAll("3");
  const afterWave3 = await wakes();
  await waitUntil(
    async () =>
      (await owner.inboxInput.count({
        where: {
          conversationId: { in: watchUsers.map((u) => u.conversationId) },
          kind: "event",
          status: { not: "consumed" },
        },
      })) === 0,
    "watcher wakes handled",
    180_000,
  );
  const polling = {
    watchers: routines.length,
    wave1Seconds: wave1.seconds,
    wave2Seconds: wave2.seconds,
    wave3Seconds: wave3.seconds,
    checksPerSecond: Math.round(
      routines.length / Math.max(wave2.seconds, 0.001),
    ),
    wakes: [afterWave1, afterWave2 - afterWave1, afterWave3 - afterWave2],
  };
  console.log("polling fan-out", polling);
  appendRow("hardening", runId, {
    part: "faux",
    scenario: "polling",
    ...polling,
  });
  check(
    "first sweep wakes only non-empty watchers",
    afterWave1 === WATCH_USERS * 2,
    afterWave1,
  );
  check(
    "unchanged sweep wakes nothing",
    afterWave2 === afterWave1,
    afterWave2 - afterWave1,
  );
  check(
    "changed sources wake exactly once each",
    afterWave3 - afterWave2 === changed.length,
    afterWave3 - afterWave2,
  );

  // ---- D: budgets under load -------------------------------------------------
  const spender = await createUser("load-budget", { dailyBudgetUsd: 0.000001 });
  await connect(spender, bases[0]!);
  const first = await post(spender, bases[1]!, `load-${randomUUID()} first`);
  await waitUntil(
    () => spender.received.length === 1,
    "budget user's first reply",
    60_000,
  );
  // pi's faux provider intentionally zeroes usage.cost; exercise the same
  // accounting entry point with a known synthetic charge. Part 2 checks real costs.
  await core.trackModelCall({
    userId: spender.id,
    useCase: "hardening-synthetic-cost",
    costUsd: 0.00036,
  });
  const spent = await owner.usageRecord.findUnique({
    where: { userId_date: { userId: spender.id, date: budgetDay() } },
  });
  const second = await post(spender, bases[0]!, `load-${randomUUID()} second`);
  const parent = await owner.agentRun.findFirstOrThrow({
    where: { userId: spender.id, trigger: "user" },
  });
  const pausedAgent = await owner.agentRun.create({
    data: {
      conversationId: spender.conversationId,
      userId: spender.id,
      trigger: "agent",
      status: "queued",
      depth: 1,
      parentRunId: parent.id,
      definitionId: (
        await owner.agentDefinition.findFirstOrThrow({
          where: { userId: null, name: "researcher" },
        })
      ).id,
      brief: { objective: "Look up the Cedar launch" },
    },
  });
  await owner.agentRun.update({
    where: { id: pausedAgent.id },
    data: { rootRunId: pausedAgent.id },
  });
  await agentJobs.add(
    "agent",
    { runId: pausedAgent.id },
    { jobId: `agent-${pausedAgent.id}` },
  );
  await waitUntil(
    async () =>
      !!(await owner.agentRun.findUnique({ where: { id: pausedAgent.id } }))
        ?.resumeAt,
    "agent paused",
    30_000,
  );
  const pausedJob = await agentJobs.getJob(`agent-${pausedAgent.id}`);
  check(
    "synthetic sub-cent spend is recorded",
    first.res.status === 202 && (spent?.costUsd ?? 0) > 0,
    spent?.costUsd,
  );
  check("hard budget refuses chat with 429", second.res.status === 429);
  check(
    "hard budget pauses background agents until reset",
    (await pausedJob?.isDelayed()) === true,
  );
  await owner.agentRun.update({
    where: { id: pausedAgent.id },
    data: { status: "canceled" },
  });
  await pausedJob?.remove();

  // ---- E: an instance leaves; the other carries its users ------------------------
  const movers = chatUsers.slice(0, 10);
  const moverSockets = sockets
    .filter((_s, i) => i < CHAT_USERS && i % 2 === 1)
    .slice(0, 5);
  const onB = chatUsers.filter((_, i) => i % 2 === 1).slice(0, 5);
  children[1]!.kill("SIGTERM");
  await waitUntil(() => children[1]!.exitCode !== null, "api-b exit", 15_000);
  const stale = (await Promise.all(onB.map((u) => presence(u.id)))).reduce(
    (a, b) => a + b,
    0,
  );
  for (const s of moverSockets) s.disconnect();
  await Promise.all(onB.map((u) => connect(u, bases[0]!)));
  const failover: number[] = [];
  await Promise.all(
    movers.map(async (u) => {
      const tag = randomUUID();
      const { res, started } = await post(
        u,
        bases[0]!,
        `load-${tag} after failover`,
      );
      if (res.status !== 202) return;
      await waitUntil(
        () => u.received.some((r) => r.content.includes(tag)),
        `failover reply ${tag}`,
        60_000,
      );
      failover.push(
        u.received.find((r) => r.content.includes(tag))!.at - started,
      );
    }),
  );
  check("a stopped instance drops its sockets from the registry", stale === 0, {
    stale,
  });
  check(
    "users keep chatting through the remaining instance",
    failover.length === movers.length,
    failover.length,
  );
  appendRow("hardening", runId, {
    part: "faux",
    scenario: "failover",
    replies: failover.length,
    replyP95: ms(pct(failover, 95)),
  });
  children[1] = await startApi("api-b", ports[1]!);

  const role = await prisma.$queryRawUnsafe<
    { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >(
    "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  check(
    "database client uses a role subject to RLS",
    role[0]?.current_user === "mimir_rls" &&
      !role[0]?.rolsuper &&
      !role[0]?.rolbypassrls,
  );
  const rlsUsers = await prisma.user.count({ where: { id: { in: users } } });
  check(
    "system scope can enumerate the suite users",
    rlsUsers === users.length,
  );
  console.log({ fauxCalls, toolCalls });

  // ---- Part 2: actual inference ------------------------------------------------
  setModelOverrideForTests(null);
  faux.unregister();
  const live = await Promise.all([
    createUser("live-math"),
    createUser("live-fact"),
    createUser("live-agent"),
    createUser("live-budget", { dailyBudgetUsd: 0.00001 }),
  ]);
  await Promise.all(live.map((u, i) => connect(u, bases[i % 2]!)));
  const asks = [
    {
      user: live[0]!,
      text: "What is 17 times 23? Answer with just the number.",
      expect: /391/,
    },
    {
      user: live[1]!,
      text: "In one short sentence: what is the capital of Japan?",
      expect: /tokyo/i,
    },
    {
      user: live[2]!,
      text: "Please research in the background what my inbox says about the Cedar launch, and report back when it's done.",
      expect: /./,
    },
    { user: live[3]!, text: "Say hello in five words or fewer.", expect: /./ },
  ];
  const liveStart = Date.now();
  const liveLatency: number[] = [];
  const posted = await Promise.all(
    asks.map((a, i) => post(a.user, bases[(i + 1) % 2]!, a.text)),
  );
  await Promise.all(
    asks.map(async (a, i) => {
      await waitUntil(
        () => a.user.received.length >= 1,
        `live reply ${i}`,
        120_000,
      );
      liveLatency.push(a.user.received[0]!.at - posted[i]!.started);
    }),
  );
  const replies = await Promise.all(
    live.map((u) =>
      owner.message.findFirst({
        where: { conversationId: u.conversationId, role: "assistant" },
        orderBy: { createdAt: "asc" },
      }),
    ),
  );
  check(
    "live: arithmetic answer",
    asks[0]!.expect.test(replies[0]?.content ?? ""),
    replies[0]?.content,
  );
  check(
    "live: factual answer",
    asks[1]!.expect.test(replies[1]?.content ?? ""),
    replies[1]?.content,
  );
  const liveAgent = await (async () => {
    await waitUntil(
      async () =>
        (await owner.agentRun.count({
          where: {
            userId: live[2]!.id,
            trigger: "agent",
            status: { notIn: ["queued", "running"] },
          },
        })) >= 1,
      "live agent finished",
      240_000,
    );
    await waitUntil(
      async () =>
        (await owner.inboxInput.count({
          where: {
            conversationId: live[2]!.conversationId,
            kind: "agent_result",
            status: "consumed",
          },
        })) >= 1,
      "live agent result handled",
      180_000,
    );
    return owner.agentRun.findFirst({
      where: { userId: live[2]!.id, trigger: "agent" },
    });
  })();
  check(
    "live: background agent ran and reported",
    liveAgent?.status === "succeeded",
    liveAgent?.status,
  );
  await waitUntil(
    () => live[2]!.received.length >= 2,
    "live agent update delivered",
    120_000,
  ).catch(() => {});
  const agentUpdate = await owner.message.findMany({
    where: { conversationId: live[2]!.conversationId, role: "assistant" },
    orderBy: { createdAt: "asc" },
  });
  check(
    "live: agent findings surfaced to the user",
    agentUpdate
      .slice(1)
      .some(
        (m) =>
          /december|1 dec/i.test(m.content) && /40[,.]?000/.test(m.content),
      ),
    agentUpdate.map((m) => m.content.slice(0, 160)),
  );
  const liveSpend = await owner.usageRecord.findMany({
    where: { userId: { in: live.map((u) => u.id) }, date: budgetDay() },
  });
  check(
    "live: real model spend recorded for every user",
    liveSpend.length === live.length && liveSpend.every((r) => r.costUsd > 0),
    liveSpend.map((r) => r.costUsd),
  );
  const overLimit = await post(live[3]!, bases[0]!, "And another one?");
  check(
    "live: hard budget refuses after real spend",
    overLimit.res.status === 429,
  );
  check(
    "live: each reply delivered once across instances",
    live.every(
      (u) =>
        u.foreign === 0 &&
        u.received.length === new Set(u.received.map((r) => r.messageId)).size,
    ),
  );
  appendRow("hardening", runId, {
    part: "live",
    scenario: "core",
    seconds: (Date.now() - liveStart) / 1000,
    replyP50: ms(pct(liveLatency, 50)),
    replyMax: ms(Math.max(...liveLatency)),
    replies: replies.map((r) => r?.content.slice(0, 200)),
    agentUpdate: agentUpdate.map((m) => m.content.slice(0, 300)),
    spendUsd: liveSpend.map((r) => r.costUsd),
  });
} catch (error) {
  exitCode = 1;
  check("suite completed", false, String(error));
} finally {
  stopRelay?.();
  for (const s of sockets) s.disconnect();
  await Promise.all(workers.map((w) => w.close()));
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  await Bun.sleep(500);
  // Owned rows first, then the users.
  const conversations = await owner.conversation.findMany({
    where: { userId: { in: users } },
    select: { id: true },
  });
  const ids = conversations.map((c) => c.id);
  const runIds = (
    await owner.agentRun.findMany({
      where: { userId: { in: users } },
      select: { id: true },
    })
  ).map((r) => r.id);
  await owner.outboxEvent.deleteMany({
    where: {
      OR: [
        ...ids.map((id) => ({
          payload: { path: ["conversationId"], equals: id },
        })),
        ...users.map((id) => ({ payload: { path: ["userId"], equals: id } })),
        ...runIds.map((id) => ({ payload: { path: ["runId"], equals: id } })),
      ],
    },
  });
  await owner.actionAttempt.deleteMany({ where: { runId: { in: runIds } } });
  await owner.deliveryReceipt.deleteMany({
    where: { delivery: { userId: { in: users } } },
  });
  await owner.delivery.deleteMany({ where: { userId: { in: users } } });
  await owner.routine.deleteMany({ where: { userId: { in: users } } });
  await owner.agentRun.deleteMany({ where: { userId: { in: users } } });
  await owner.sessionEntry.deleteMany({
    where: { conversationId: { in: ids } },
  });
  await owner.inboxInput.deleteMany({ where: { conversationId: { in: ids } } });
  await owner.toolArtifact.deleteMany({ where: { userId: { in: users } } });
  await owner.message.deleteMany({ where: { conversationId: { in: ids } } });
  await owner.extractedFact.deleteMany({ where: { userId: { in: users } } });
  await owner.conversation.deleteMany({ where: { userId: { in: users } } });
  for (const table of [
    "integrationConnection",
    "usageRecord",
    "modelCallLog",
    "analyticsEvent",
  ] as const)
    await (
      owner[table] as unknown as {
        deleteMany: (a: unknown) => Promise<unknown>;
      }
    ).deleteMany({ where: { userId: { in: users } } });
  await owner.user.deleteMany({ where: { id: { in: users } } });
  await marker.flushdb();
  await marker.quit();
  const failed = results.filter((r) => !r.ok);
  appendRow("hardening", runId, {
    part: "summary",
    checks: results.length,
    failed: failed.map((f) => f.check),
    seconds: (Date.now() - t0) / 1000,
    logs: logDir,
  });
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s (API logs: ${logDir})`,
  );
  if (failed.length) exitCode = 1;
  process.exit(exitCode);
}
