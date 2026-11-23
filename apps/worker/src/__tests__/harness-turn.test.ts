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
    // plus the volatile runtime tail after the recent messages.
    const system = seen[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.sections?.preamble).toContain("You are Mimir");
    const texts = seen[0]!.messages
      .filter((m) => m.role === "user")
      .map(textOf);
    expect(texts.at(-1)).toContain("<runtime_context>");
    expect(texts.at(-1)).toContain("Asia/Kolkata");
    expect(texts.at(-2)).toBe("hi, my favourite colour is teal");
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

  test("a provider error is recorded as a model error with its message", async () => {
    const failure = () =>
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "403 Key limit exceeded (total limit)",
      });
    faux.setResponses([failure, failure, failure, failure, failure, failure]);
    const input = await userMessage("anything");
    await runTurn({ conversationId, userId, messageId: input.id });
    const run = await prisma.agentRun.findUniqueOrThrow({
      where: { inputMessageId: input.id },
    });
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      reason: "model_error",
      message: expect.stringContaining("Key limit exceeded"),
    });
    faux.setResponses([]);
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

describe("Phase Two inbox and response rules", () => {
  async function isolated(work: (id: string) => Promise<void>) {
    const c = await prisma.conversation.create({ data: { userId } });
    try {
      await work(c.id);
    } finally {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["conversationId"], equals: c.id } },
      });
      await prisma.message.deleteMany({ where: { conversationId: c.id } });
      await prisma.conversation.delete({ where: { id: c.id } });
    }
  }
  async function input(id: string, text: string, control?: "stop") {
    const message = await prisma.message.create({
      data: { conversationId: id, role: "user", content: text },
    });
    const row = await prisma.inboxInput.create({
      data: {
        conversationId: id,
        kind: "user",
        source: "user:test",
        messageId: message.id,
        dedupeKey: message.id,
        payload: { kind: "user", text, ...(control ? { control } : {}) },
        createdAt: new Date(Date.now() - 2000),
      },
    });
    return { message, row };
  }
  test("a burst gets one answer linked to every input and replay does no inference", async () =>
    isolated(async (id) => {
      const a = await input(id, "what is 2 plus 2?");
      const b = await input(id, "also what is 3 plus 3?");
      faux.setResponses([reply([fauxText("4 and 6.")])]);
      await runTurn({ conversationId: id, userId, messageId: b.message.id });
      const messages = await prisma.message.findMany({
        where: { conversationId: id, role: "assistant" },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.replyToMessageIds).toEqual([
        a.message.id,
        b.message.id,
      ]);
      expect(
        await prisma.inboxInput.count({
          where: { conversationId: id, status: "consumed" },
        }),
      ).toBe(2);
      await runTurn({ conversationId: id, userId, messageId: a.message.id });
      expect(
        await prisma.agentRun.count({ where: { conversationId: id } }),
      ).toBe(1);
    }));
  test("an empty chat answer gets exactly one recovery attempt", async () =>
    isolated(async (id) => {
      const a = await input(id, "answer please");
      faux.setResponses([reply([]), reply([fauxText("Recovered answer.")])]);
      await runTurn({ conversationId: id, userId, messageId: a.message.id });
      expect((await replyTo(a.message.id))[0]!.content).toBe(
        "Recovered answer.",
      );
      expect(
        (
          await prisma.agentRun.findUniqueOrThrow({
            where: { inputMessageId: a.message.id },
          })
        ).steps,
      ).toBe(2);
    }));
  test("nothing-new agent results remain silent with no delivery or deltas", async () =>
    isolated(async (id) => {
      const { postInbox } = await import("@mimir/backend-core");
      const inputId = await postInbox({
        conversationId: id,
        userId,
        source: "worker:test",
        dedupeKey: "nothing-new",
        payload: {
          kind: "agent_result",
          agentRunId: "child",
          status: "succeeded",
          text: "No changes.",
        },
      });
      faux.setResponses([reply([fauxText("NO_REPLY")])]);
      await runTurn({ conversationId: id, userId, inputId });
      expect(
        await prisma.message.count({ where: { conversationId: id } }),
      ).toBe(0);
      expect(
        await prisma.delivery.count({ where: { conversationId: id } }),
      ).toBe(0);
      expect(
        (await prisma.inboxInput.findUniqueOrThrow({ where: { id: inputId } }))
          .status,
      ).toBe("consumed");
    }));
  test("ambient prose gets one nudge; only the notification tool reaches delivery", async () =>
    isolated(async (id) => {
      const { postInbox } = await import("@mimir/backend-core");
      const inputId = await postInbox({
        conversationId: id,
        userId,
        source: "worker:test",
        dedupeKey: "completed",
        payload: {
          kind: "agent_result",
          agentRunId: "child",
          status: "succeeded",
          text: "Requested research complete: answer 42.",
        },
      });
      faux.setResponses([
        reply([fauxText("Research done.")]),
        reply(
          [
            fauxToolCall("send_to_user", {
              text: "The answer is 42.",
              urgency: "normal",
              reason_code: "task_completed",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        reply([fauxText("NO_REPLY")]),
      ]);
      await runTurn({ conversationId: id, userId, inputId });
      expect(
        (await prisma.message.findMany({ where: { conversationId: id } })).map(
          (m) => m.content,
        ),
      ).toEqual(["The answer is 42."]);
      expect(
        await prisma.delivery.count({
          where: { conversationId: id, ambient: true },
        }),
      ).toBe(1);
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { inboxInputId: inputId },
      });
      expect(
        await prisma.actionAttempt.count({
          where: {
            runId: run.id,
            toolName: "send_to_user",
            status: "succeeded",
          },
        }),
      ).toBe(1);
    }));
  test("new user corrections steer at the tool boundary", async () =>
    isolated(async (id) => {
      const a = await input(id, "read the slow source");
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      seen.length = 0;
      faux.setResponses([
        reply([fauxToolCall("slow_read", {})], { stopReason: "toolUse" }),
        reply([fauxText("Applied your correction.")]),
      ]);
      const running = runTurn(
        { conversationId: id, userId, messageId: a.message.id },
        {
          readTools: async () => [
            {
              name: "slow_read",
              label: "Slow read",
              description: "Read source",
              parameters: { type: "object", properties: {} },
              risk: "read_private",
              sideEffect: "none",
              idempotent: true,
              provenance: "test",
              resultTrust: "untrusted",
              outputMaxChars: 1000,
              execute: async () => {
                entered();
                await held;
                return "result";
              },
            },
          ],
        },
      );
      await started;
      const b = await input(id, "Correction: use the updated value.");
      await Bun.sleep(250);
      release();
      await running;
      expect(seen.at(-1)!.messages.map(textOf).join("\n")).toContain(
        "Correction: use the updated value.",
      );
      const answer = (
        await prisma.message.findMany({
          where: { conversationId: id, role: "assistant" },
        })
      )[0]!;
      expect(answer.replyToMessageIds).toEqual([a.message.id, b.message.id]);
    }));
  test("stop aborts a blocked tool and settles every covered user input", async () =>
    isolated(async (id) => {
      const a = await input(id, "read the blocked source");
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      faux.setResponses([
        reply([fauxToolCall("blocked_read", {})], { stopReason: "toolUse" }),
      ]);
      const running = runTurn(
        { conversationId: id, userId, messageId: a.message.id },
        {
          readTools: async () => [
            {
              name: "blocked_read",
              label: "Blocked read",
              description: "Read source",
              parameters: { type: "object", properties: {} },
              risk: "read_private",
              sideEffect: "none",
              idempotent: true,
              provenance: "test",
              resultTrust: "untrusted",
              outputMaxChars: 1000,
              execute: async () => {
                entered();
                return new Promise(() => {});
              },
            },
          ],
        },
      );
      await started;
      const stop = await input(id, "stop", "stop");
      await running;
      const answer = (await replyTo(a.message.id))[0]!;
      expect(answer.content).toBe("Stopped.");
      expect(answer.replyToMessageIds).toContain(stop.message.id);
      expect(
        (
          await prisma.agentRun.findUniqueOrThrow({
            where: { inputMessageId: a.message.id },
          })
        ).status,
      ).toBe("interrupted");
    }));
  test("a user-prioritized ambient job leaves a durable wake for its pending result", async () =>
    isolated(async (id) => {
      const { postInbox } = await import("@mimir/backend-core");
      const inputId = await postInbox({
        conversationId: id,
        userId,
        source: "worker:test",
        dedupeKey: "pending-result",
        payload: {
          kind: "agent_result",
          agentRunId: "child",
          status: "succeeded",
          text: "Nothing new.",
        },
      });
      await input(id, "hello");
      faux.setResponses([
        reply([fauxText("Hi.")]),
        reply([fauxText("NO_REPLY")]),
      ]);
      await runTurn({ conversationId: id, userId, inputId });
      expect(
        (await prisma.inboxInput.findUniqueOrThrow({ where: { id: inputId } }))
          .status,
      ).toBe("pending");
      const wake = await prisma.outboxEvent.findFirst({
        where: {
          eventType: "conversation_turn",
          payload: { path: ["inputId"], equals: inputId },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(wake!.payload).toHaveProperty("wakeId");
      await runTurn({ conversationId: id, userId, inputId });
      expect(
        (await prisma.inboxInput.findUniqueOrThrow({ where: { id: inputId } }))
          .status,
      ).toBe("consumed");
    }));
  test("canceled routine fires do not wake the model", async () =>
    isolated(async (id) => {
      const { postInbox } = await import("@mimir/backend-core");
      const routine = await prisma.routine.create({
        data: {
          conversationId: id,
          userId,
          instruction: "Canceled reminder",
          source: "schedule",
          query: {},
          timing: { type: "interval", everyMs: 60000 },
          status: "disabled",
        },
      });
      const inputId = await postInbox({
        conversationId: id,
        userId,
        source: "routine:test",
        dedupeKey: "canceled",
        payload: {
          kind: "routine_fire",
          routineId: routine.id,
          key: "once",
          instruction: routine.instruction,
        },
      });
      faux.setResponses([]);
      await runTurn({ conversationId: id, userId, inputId });
      expect(
        await prisma.agentRun.count({ where: { conversationId: id } }),
      ).toBe(0);
      expect(
        (await prisma.inboxInput.findUniqueOrThrow({ where: { id: inputId } }))
          .status,
      ).toBe("consumed");
    }));
  test("a retained Phase One job reuses its existing run and committed reply", async () =>
    isolated(async (id) => {
      const message = await prisma.message.create({
        data: {
          conversationId: id,
          role: "user",
          content: "old completed input",
        },
      });
      const answer = await prisma.message.create({
        data: {
          conversationId: id,
          role: "assistant",
          parentMessageId: message.id,
          content: "Already answered.",
        },
      });
      const run = await prisma.agentRun.create({
        data: {
          userId,
          conversationId: id,
          trigger: "user_message",
          inputMessageId: message.id,
          replyMessageId: answer.id,
          status: "succeeded",
        },
      });
      faux.setResponses([]);
      await runTurn({ conversationId: id, userId, messageId: message.id });
      expect(
        await prisma.agentRun.count({ where: { conversationId: id } }),
      ).toBe(1);
      expect(
        await prisma.inboxInput.findUniqueOrThrow({
          where: { messageId: message.id },
        }),
      ).toMatchObject({
        status: "consumed",
        runId: run.id,
        replyMessageId: answer.id,
      });
    }));
  test("a tool-registry setup failure still settles the user reply contract", async () =>
    isolated(async (id) => {
      const a = await input(id, "please answer");
      await runTurn(
        { conversationId: id, userId, messageId: a.message.id },
        {
          readTools: async () => {
            throw new Error("synthetic registry outage");
          },
        },
      );
      expect((await replyTo(a.message.id))[0]!.content).toContain(
        "Mind trying again?",
      );
      expect(
        (
          await prisma.inboxInput.findUniqueOrThrow({
            where: { messageId: a.message.id },
          })
        ).status,
      ).toBe("consumed");
    }));
  test("schedule writes a durable routine and an action-attempt row before promising it", async () =>
    isolated(async (id) => {
      const a = await input(id, "remind me later");
      faux.setResponses([
        reply(
          [
            fauxToolCall("schedule", {
              action: "add",
              instruction: "Remind me to stretch",
              timing: {
                type: "once",
                at: new Date(Date.now() + 60_000).toISOString(),
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        reply([fauxText("I'll remind you to stretch.")]),
      ]);
      await runTurn({ conversationId: id, userId, messageId: a.message.id });
      expect(
        await prisma.routine.count({ where: { conversationId: id } }),
      ).toBe(1);
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { inputMessageId: a.message.id },
      });
      expect(
        await prisma.actionAttempt.count({
          where: { runId: run.id, toolName: "schedule", status: "succeeded" },
        }),
      ).toBe(1);
    }));

  test("Phase Three pauses for a card and resumes the same run without replaying the side effect", async () =>
    isolated(async (id) => {
      const a = await input(id, "Post this issue");
      let calls = 0;
      const spec: import("../harness/tools.js").ToolSpec = {
        name: "test_post_issue",
        label: "Post issue",
        description: "Synthetic fixture",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        risk: "communicate_external",
        sideEffect: "irreversible",
        idempotent: false,
        provenance: "test:post",
        resultTrust: "untrusted",
        outputMaxChars: 1000,
        execute: async (args) => {
          calls++;
          return { posted: args };
        },
      };
      const options = { readTools: async () => [spec] };
      faux.setResponses([
        reply([fauxToolCall("test_post_issue", { title: "Reviewed title" })], {
          stopReason: "toolUse",
        }),
        reply([fauxText("Review the action card.")]),
      ]);
      await runTurn(
        { conversationId: id, userId, messageId: a.message.id },
        options,
      );
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { inputMessageId: a.message.id },
      });
      expect(run.status).toBe("waiting_human");
      expect(calls).toBe(0);
      const approval = await prisma.actionApproval.findFirstOrThrow({
        where: { runId: run.id },
      });
      await prisma.actionApproval.update({
        where: { id: approval.id },
        data: { status: "approved" },
      });
      const answer = await prisma.inboxInput.create({
        data: {
          conversationId: id,
          kind: "approval_answer",
          source: "user:approval-card",
          dedupeKey: approval.id,
          payload: {
            kind: "approval_answer",
            approvalId: approval.id,
            approved: true,
          },
        },
      });
      faux.setResponses([reply([fauxText("Posted the reviewed issue.")])]);
      await runTurn(
        { conversationId: id, userId, inputId: answer.id },
        options,
      );
      expect(calls).toBe(1);
      expect(
        (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }))
          .steps,
      ).toBe(3);
      expect(
        await prisma.agentRun.count({ where: { conversationId: id } }),
      ).toBe(1);
      expect(
        (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
      ).toBe("succeeded");
      expect(
        (
          await prisma.actionApproval.findUniqueOrThrow({
            where: { id: approval.id },
          })
        ).status,
      ).toBe("succeeded");
      expect(
        (
          await prisma.inboxInput.findUniqueOrThrow({
            where: { id: answer.id },
          })
        ).status,
      ).toBe("consumed");
      await runTurn(
        { conversationId: id, userId, inputId: answer.id },
        options,
      );
      expect(calls).toBe(1);
      await prisma.actionAttempt.deleteMany({ where: { runId: run.id } });
    }));
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

test("runTurn delivers and journals its answer after pre-prompt compaction", async () => {
  const c = await prisma.conversation.create({ data: { userId } });
  try {
    await prisma.message.createMany({
      data: Array.from({ length: 48 }, (_, i) => ({
        conversationId: c.id,
        role: i % 2 ? "assistant" : "user",
        content: "Transient exercise with no durable user details. ".repeat(
          100,
        ),
        createdAt: new Date(Date.now() - (50 - i) * 1000),
      })),
    });
    const message = await prisma.message.create({
      data: {
        conversationId: c.id,
        role: "user",
        content: "What is 17 + 25?",
      },
    });
    faux.setResponses([
      reply([
        fauxText(
          "Previous exercises are transient. Answer the current arithmetic question.",
        ),
      ]),
      reply([fauxText("42")]),
    ]);
    await runTurn(
      { userId, conversationId: c.id, messageId: message.id },
      { readTools: async () => [] },
    );
    const run = await prisma.agentRun.findFirstOrThrow({
      where: { inputMessageId: message.id },
    });
    expect(run.status).toBe("succeeded");
    expect((await replyTo(message.id)).map((m) => m.content)).toEqual(["42"]);
    expect(
      await prisma.sessionEntry.count({
        where: { conversationId: c.id, type: "compaction" },
      }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.agentStep.count({
        where: { runId: run.id, kind: "message_end" },
      }),
    ).toBeGreaterThan(0);
  } finally {
    await prisma.agentRun.deleteMany({ where: { conversationId: c.id } });
    await prisma.outboxEvent.deleteMany({
      where: { payload: { path: ["conversationId"], equals: c.id } },
    });
    await prisma.message.deleteMany({ where: { conversationId: c.id } });
    await prisma.conversation.delete({ where: { id: c.id } });
  }
});

test("compaction can exhaust a budget without starting another model call", async () => {
  let exhausted = false;
  let calls = 0;
  faux.setResponses([
    () => {
      calls++;
      return fauxAssistantMessage([
        fauxText("Summary of transient exercises."),
      ]);
    },
    () => {
      calls++;
      return fauxAssistantMessage([fauxText("This call must not run.")]);
    },
  ]);
  const session = await openSession({
    entries: [],
    specs: [],
    ctx: { userId, conversationId },
    contextWindow: 4096,
    history: Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "Transient exercise. ".repeat(30),
      createdAt: new Date(i + 1),
    })),
    systemPrompt: "Synthetic budget test",
    runtimeContext: () => "",
    onCompactionUsage: () => {
      exhausted = true;
    },
    assertCanPrompt: () => {
      if (exhausted) throw new Error("budget exhausted");
    },
  });
  try {
    await expect(session.prompt("Continue the task")).rejects.toThrow(
      "budget exhausted",
    );
    expect(calls).toBe(1);
  } finally {
    session.dispose();
  }
});

test("zero-usage legacy history compacts through pi and reloads its checkpoint", async () => {
  const history = Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "Transient example. ".repeat(30),
    createdAt: new Date(i + 1),
  }));
  history[0]!.content = "Preserve exact project code COMET-482.";
  faux.setResponses([
    reply([
      fauxText(
        "The user needs project code COMET-482. Other exercises are transient.",
      ),
    ]),
    reply([fauxText("COMET-482")]),
    reply([fauxText("COMET-482")]),
  ]);
  let session = await openSession({
    entries: [],
    history,
    specs: [],
    ctx: { userId, conversationId },
    contextWindow: 4096,
    systemPrompt: "Answer using the supplied project details.",
    runtimeContext: () => "Synthetic runtime tail",
  });
  try {
    await session.prompt("What project code did I give?");
    await session.waitForIdle();
    const entries = session.sessionManager.getEntries();
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(entries.filter((e) => e.type === "message").length).toBeGreaterThan(
      80,
    );
    session.dispose();
    session = await openSession({
      entries,
      specs: [],
      ctx: { userId, conversationId },
      contextWindow: 4096,
      systemPrompt: "Answer using the supplied project details.",
      runtimeContext: () => "A new runtime tail",
    });
    await session.prompt("Repeat that code.");
    await session.waitForIdle();
    expect(JSON.stringify(session.messages)).toContain("COMET-482");
    expect(
      session.sessionManager
        .getEntries()
        .filter((e) => e.type === "compaction"),
    ).toHaveLength(1);
  } finally {
    session.dispose();
  }
});
