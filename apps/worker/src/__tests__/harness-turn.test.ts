import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end harness runs against real Postgres + Redis, with pi's scripted
// faux model instead of OpenRouter, so CI needs no key or network.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "harness-turn-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } =
  await import("@earendil-works/pi-ai/compat");
const { openSession, setModelOverrideForTests } =
  await import("../harness/pi-runtime.js");
const { ConversationBusyError, repliesByInput, runTurn, turnProcessor } =
  await import("../harness/turn.js");
const { redis } = await import("../infra/redis.js");

type Ctx = {
  messages: {
    role: string;
    content: unknown;
    isError?: boolean;
    sections?: Record<string, string | null>;
  }[];
};

const prisma = getPrismaClient();
const faux = registerFauxProvider({ provider: "mimir-faux" });
const userId = `harness-turn-${randomUUID()}`;
const conversationId = randomUUID();

// Each scripted response records the context the model was given.
const seen: Ctx[] = [];
const reply =
  (
    content: Parameters<typeof fauxAssistantMessage>[0],
    opts?: Parameters<typeof fauxAssistantMessage>[1],
  ) =>
  (context: Ctx) => {
    seen.push(structuredClone(context));
    return fauxAssistantMessage(content, opts);
  };

const textOf = (m: { content: unknown }) =>
  typeof m.content === "string"
    ? m.content
    : (m.content as { type: string; text?: string }[])
        .map((c) => c.text ?? "")
        .join("");

async function userMessage(content: string) {
  return prisma.message.create({
    data: {
      conversationId,
      role: "user",
      content,
      clientMessageId: randomUUID(),
    },
  });
}

async function replyTo(messageId: string) {
  return prisma.message.findMany({
    where: { parentMessageId: messageId, role: "assistant" },
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-faux-"));
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

  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@test.local`,
      passwordHash: "x",
      timezone: "Asia/Kolkata",
    },
  });
  await prisma.conversation.create({ data: { id: conversationId, userId } });
  await prisma.message.createMany({
    data: [
      {
        conversationId,
        role: "user",
        content: "My old project is Cedar.",
        createdAt: new Date(Date.now() - 2000),
      },
      {
        conversationId,
        role: "assistant",
        content: "Cedar, got it.",
        createdAt: new Date(Date.now() - 1000),
      },
    ],
  });
});

afterAll(async () => {
  setModelOverrideForTests(null);
  faux.unregister();
  await prisma.agentRun.deleteMany({ where: { conversationId } });
  await prisma.sessionEntry.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.outboxEvent.deleteMany({
    where: { payload: { path: ["conversationId"], equals: conversationId } },
  });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("runTurn", () => {
  test("a run that loses its lock cannot persist or deliver its final answer", async () => {
    const other = await prisma.conversation.create({ data: { userId } });
    const key = `harness-lock:${other.id}`;
    try {
      faux.setResponses([
        async () => {
          await redis.set(key, "replacement-worker", "PX", 10000);
          return fauxAssistantMessage([
            fauxText("Stale reply must never be delivered."),
          ]);
        },
      ]);
      const input = await prisma.message.create({
        data: {
          conversationId: other.id,
          role: "user",
          content: "lock-loss test",
        },
      });
      await expect(
        runTurn({ conversationId: other.id, userId, messageId: input.id }),
      ).rejects.toBeInstanceOf(ConversationBusyError);
      expect(await replyTo(input.id)).toHaveLength(0);
      expect(await redis.get(key)).toBe("replacement-worker");
      const entries = await prisma.sessionEntry.findMany({
        where: { conversationId: other.id },
      });
      expect(JSON.stringify(entries.map((e) => e.data))).not.toContain(
        "Stale reply must never be delivered",
      );
    } finally {
      await redis.del(key);
      await prisma.agentRun.deleteMany({ where: { conversationId: other.id } });
      await prisma.message.deleteMany({ where: { conversationId: other.id } });
      await prisma.conversation.delete({ where: { id: other.id } });
    }
  });

  test("concurrent SessionHost opens reserve the conversation before SDK initialization", async () => {
    const { SessionHost } = await import("../harness/session-host.js");
    const host = new SessionHost();
    const opts = {
      entries: [],
      specs: [],
      ctx: { userId, conversationId },
      runtimeContext: () => "context",
    };
    const first = host.open(conversationId, opts);
    try {
      await expect(host.open(conversationId, opts)).rejects.toThrow(
        "already has an active session",
      );
      await first;
    } finally {
      host.evict(conversationId);
    }
  });
  test("a user turn cannot silently finish with NO_REPLY", async () => {
    // Keep this independent so it doesn't create the main conversation's pi
    // journal before the legacy-history bootstrap test.
    const other = await prisma.conversation.create({ data: { userId } });
    try {
      faux.setResponses([reply([fauxText("NO_REPLY")])]);
      const input = await prisma.message.create({
        data: {
          conversationId: other.id,
          role: "user",
          content: "please answer this",
        },
      });
      await runTurn({ conversationId: other.id, userId, messageId: input.id });
      expect((await replyTo(input.id))[0]!.content).toContain(
        "Mind trying again?",
      );
      expect(
        await prisma.agentRun.findUnique({
          where: { inputMessageId: input.id },
        }),
      ).toMatchObject({ status: "failed" });
    } finally {
      await prisma.agentRun.deleteMany({ where: { conversationId: other.id } });
      await prisma.message.deleteMany({ where: { conversationId: other.id } });
      await prisma.conversation.delete({ where: { id: other.id } });
    }
  });
  test("the headless SDK can bind a host confirmation callback", async () => {
    const session = await openSession({
      entries: [],
      specs: [],
      ctx: { userId, conversationId },
      runtimeContext: () => "context",
    });
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        confirm: async () => false,
      },
    });
    try {
      expect(session.extensionRunner.hasUI()).toBe(true);
      expect(
        await session.extensionRunner
          .getUIContext()
          .confirm("Send?", "Preview"),
      ).toBe(false);
      expect(session.getActiveToolNames()).toEqual(["tool_search"]);
    } finally {
      session.dispose();
    }
  });

  test("busy turns are delayed without exhausting their failure attempts", async () => {
    const { Queue, QueueEvents, Worker } = await import("bullmq");
    const connection = {
      url: process.env.REDIS_URL!,
      maxRetriesPerRequest: null,
    };
    const queue = new Queue(`harness-lock-test-${randomUUID()}`, {
      connection,
    });
    const events = new QueueEvents(queue.name, { connection });
    await events.waitUntilReady();
    const input = await userMessage("queued during another run");
    faux.setResponses([reply([fauxText("Queued reply.")])]);
    await redis.set(
      `harness-lock:${conversationId}`,
      "another-worker",
      "PX",
      300,
    );
    const worker = new Worker(queue.name, turnProcessor, { connection });
    try {
      const job = await queue.add(
        "turn",
        { conversationId, userId, messageId: input.id },
        { attempts: 1 },
      );
      await job.waitUntilFinished(events, 10000);
      expect((await queue.getJob(job.id!))!.attemptsMade).toBe(1);
      expect(await replyTo(input.id)).toHaveLength(1);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.del(`harness-lock:${conversationId}`);
    }
  }, 15000);

  test("answers a user message, journals the session and records the run", async () => {
    seen.length = 0;
    faux.setResponses([reply([fauxText("Hey! Noted: you like teal.")])]);
    const input = await userMessage("hi, my favourite colour is teal");

    await runTurn({ conversationId, userId, messageId: input.id });

    const replies = await replyTo(input.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toBe("Hey! Noted: you like teal.");
    const run = await prisma.agentRun.findUnique({
      where: { inputMessageId: input.id },
    });
    expect(run).toMatchObject({
      status: "succeeded",
      replyMessageId: replies[0]!.id,
      steps: 1,
      toolCalls: 0,
    });
    expect(
      await prisma.sessionEntry.count({ where: { conversationId } }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.agentStep.count({
        where: { runId: run!.id, kind: "message_end" },
      }),
    ).toBeGreaterThan(0);

    // The model saw the static persona (pi sends it as system-message sections)
    // plus the runtime context right before the message.
    const system = seen[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.sections?.preamble).toContain("You are Mimir");
    const texts = seen[0]!.messages
      .filter((m) => m.role === "user")
      .map(textOf);
    expect(texts.at(-2)).toContain("<runtime_context>");
    expect(texts.at(-2)).toContain("Asia/Kolkata");
    expect(texts.at(-1)).toBe("hi, my favourite colour is teal");
    expect(seen[0]!.messages.map(textOf).join("\n")).toContain(
      "My old project is Cedar.",
    );
  });

  test("a retried job doesn't answer twice", async () => {
    const input = await prisma.message.findFirstOrThrow({
      where: { conversationId, content: "hi, my favourite colour is teal" },
    });
    faux.setResponses([reply([fauxText("should not be used")])]);
    await runTurn({ conversationId, userId, messageId: input.id });
    expect(await replyTo(input.id)).toHaveLength(1);
    faux.setResponses([]);
  });

  test("rejects a turn with a different owner", async () => {
    const input = await userMessage("private message");
    await runTurn({
      conversationId,
      userId: "someone-else",
      messageId: input.id,
    });
    expect(await replyTo(input.id)).toHaveLength(0);
    expect(
      await prisma.agentRun.findUnique({ where: { inputMessageId: input.id } }),
    ).toBeNull();
  });

  test("a locked conversation can be retried after the active turn finishes", async () => {
    const input = await userMessage("wait for the active turn");
    await redis.set(
      `harness-lock:${conversationId}`,
      "another-worker",
      "PX",
      10000,
    );
    try {
      await expect(
        runTurn({ conversationId, userId, messageId: input.id }),
      ).rejects.toBeInstanceOf(ConversationBusyError);
      expect(await replyTo(input.id)).toHaveLength(0);
    } finally {
      await redis.del(`harness-lock:${conversationId}`);
    }
    faux.setResponses([reply([fauxText("Ready now.")])]);
    await runTurn({ conversationId, userId, messageId: input.id });
    expect((await replyTo(input.id))[0]!.content).toBe("Ready now.");
  });

  test("rehydrates the conversation from stored entries on the next turn", async () => {
    seen.length = 0;
    faux.setResponses([reply([fauxText("Teal, obviously.")])]);
    const input = await userMessage("what's my favourite colour?");

    await runTurn({ conversationId, userId, messageId: input.id });

    expect((await replyTo(input.id))[0]!.content).toBe("Teal, obviously.");
    const history = seen[0]!.messages.map(textOf).join("\n");
    expect(history).toContain("hi, my favourite colour is teal");
    expect(history).toContain("Hey! Noted: you like teal.");
    // Runtime context from the earlier turn was never stored, so it appears once.
    expect(history.match(/<runtime_context>/g)).toHaveLength(1);
  });

  test("runs read tools and refuses tools it doesn't have", async () => {
    seen.length = 0;
    faux.setResponses([
      reply(
        [
          fauxToolCall("memory_search", { query: "colour" }),
          fauxToolCall("send_email", { to: "bob@example.com" }),
        ],
        { stopReason: "toolUse" },
      ),
      reply([fauxText("I can't send email yet.")]),
    ]);
    const input = await userMessage("email bob my favourite colour");

    await runTurn({ conversationId, userId, messageId: input.id });

    expect((await replyTo(input.id))[0]!.content).toBe(
      "I can't send email yet.",
    );
    const results = seen[1]!.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.some((r) => textOf(r).includes('"facts"'))).toBe(true);
    // pi itself refuses a tool that isn't registered; Mimir's gate is the backstop.
    const blocked = results.find((r) =>
      textOf(r).includes("send_email not found"),
    );
    expect(blocked?.isError).toBe(true);
    const run = await prisma.agentRun.findUnique({
      where: { inputMessageId: input.id },
    });
    expect(run).toMatchObject({ status: "succeeded", steps: 2 });
  });

  test("an empty model reply becomes a fallback message and a failed run", async () => {
    faux.setResponses([reply([])]);
    const input = await userMessage("...");

    await runTurn({ conversationId, userId, messageId: input.id });

    const replies = await replyTo(input.id);
    expect(replies[0]!.content).toContain("Mind trying again?");
    expect(replies[0]!.errorDetail).toEqual({ reason: "no_reply" });
    expect(
      await prisma.agentRun.findUnique({ where: { inputMessageId: input.id } }),
    ).toMatchObject({ status: "failed" });
  });

  test("a conversation locked by another process is retried, not run twice", async () => {
    const input = await userMessage("are you busy?");
    await redis.set(
      `harness-lock:${conversationId}`,
      "someone-else",
      "PX",
      5000,
    );
    try {
      await expect(
        runTurn({ conversationId, userId, messageId: input.id }),
      ).rejects.toBeInstanceOf(ConversationBusyError);
      expect(await replyTo(input.id)).toHaveLength(0);
    } finally {
      await redis.del(`harness-lock:${conversationId}`);
    }
  });
});

describe("repliesByInput", () => {
  const user = (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const assistant = (text: string) => ({
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
  });

  test("pairs each input with the last assistant text before the next input", () => {
    const messages = [
      user("old"),
      assistant("old reply"),
      user("a"),
      assistant("thinking…"),
      { role: "toolResult", content: [] },
      assistant("answer a"),
      user("b"),
      assistant("answer b"),
    ];
    expect(repliesByInput(messages, 2, 2)).toEqual(["answer a", "answer b"]);
  });

  test("an input with no assistant text gets an empty reply", () => {
    expect(repliesByInput([user("a"), assistant("")], 0, 1)).toEqual([""]);
    expect(repliesByInput([], 0, 2)).toEqual(["", ""]);
  });
});
