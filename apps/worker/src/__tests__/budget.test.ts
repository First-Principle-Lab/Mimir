import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daily hard budget in the worker: turns, background agents and recovery,
// with pi's faux model (any unexpected model call fails the test).
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "budget-worker-test-secret";

const { AGENT_STALE_MS, budgetDay, budgetResetsAt, getPrismaClient } =
  await import("@mimir/backend-core");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } =
  await import("@earendil-works/pi-ai/compat");
const { setModelOverrideForTests } = await import("../harness/pi-runtime.js");
const {
  agentJobId,
  agentJobs,
  createAgentRun,
  findDefinition,
  recoverStaleAgents,
  runAgentJob,
} = await import("../harness/agents.js");
const { runTurn } = await import("../harness/turn.js");
const { runExtractForConversation } =
  await import("../agent/fact-extraction-run.js");
const { drainOutbox } = await import("../infra/outbox-relay.js");
const { conversationTurns, recoverHarnessWork } =
  await import("../infra/queues.js");
import type { Queue } from "bullmq";

const prisma = getPrismaClient();
const faux = registerFauxProvider({ provider: "mimir-budget-faux" });
const userId = `budget-${randomUUID()}`;
let conversationId: string;

async function spend(usd: number) {
  await prisma.usageRecord.upsert({
    where: { userId_date: { userId, date: budgetDay() } },
    create: { userId, date: budgetDay(), costUsd: usd },
    update: { costUsd: usd },
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-budget-faux-"));
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
      dailyBudgetUsd: 1,
    },
  });
  conversationId = (await prisma.conversation.create({ data: { userId } })).id;
});

beforeEach(async () => {
  faux.setResponses([]);
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.inboxInput.updateMany({
    where: { conversationId, status: { not: "consumed" } },
    data: { status: "consumed", consumedAt: new Date() },
  });
});

afterAll(async () => {
  setModelOverrideForTests(null);
  faux.unregister();
  const runs = await prisma.agentRun.findMany({
    where: { userId },
    select: { id: true },
  });
  for (const run of runs) await agentJobs.remove(agentJobId(run.id));
  await prisma.outboxEvent.deleteMany({
    where: {
      OR: [
        { payload: { path: ["conversationId"], equals: conversationId } },
        ...runs.map((r) => ({ payload: { path: ["runId"], equals: r.id } })),
      ],
    },
  });
  await prisma.actionAttempt.deleteMany({
    where: { runId: { in: runs.map((r) => r.id) } },
  });
  await prisma.delivery.deleteMany({ where: { conversationId } });
  await prisma.sessionEntry.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

async function userInput(text: string) {
  const message = await prisma.message.create({
    data: {
      conversationId,
      role: "user",
      content: text,
      clientMessageId: randomUUID(),
    },
  });
  await prisma.inboxInput.create({
    data: {
      conversationId,
      kind: "user",
      source: "user:http",
      messageId: message.id,
      dedupeKey: `user:${message.id}`,
      payload: { kind: "user", text },
    },
  });
  return message;
}

async function agentResult() {
  return prisma.inboxInput.create({
    data: {
      conversationId,
      kind: "agent_result",
      source: "agent:test",
      dedupeKey: `agent-result:${randomUUID()}`,
      payload: {
        kind: "agent_result",
        agentRunId: randomUUID(),
        status: "succeeded",
        text: "Found it.",
        proposedActions: [],
      },
    },
  });
}

const budgetWakes = () =>
  prisma.outboxEvent.findMany({
    where: {
      eventType: "conversation_turn",
      processedAt: null,
      payload: { path: ["conversationId"], equals: conversationId },
    },
  });

test("a user message accepted before the limit gets a fixed notice and no model call", async () => {
  const message = await userInput("Summarize my week");
  await spend(1);
  await runTurn({ conversationId, userId, messageId: message.id });
  const reply = await prisma.message.findFirstOrThrow({
    where: { parentMessageId: message.id, role: "assistant" },
  });
  expect(reply.content).toContain("today's usage limit");
  const run = await prisma.agentRun.findFirstOrThrow({
    where: { replyMessageId: reply.id },
  });
  expect(run).toMatchObject({ status: "budget_exceeded", steps: 0 });
  expect(await prisma.modelCallLog.count({ where: { userId } })).toBe(0);
});

test("background inputs wait for the next window with one delayed wake", async () => {
  const input = await agentResult();
  await spend(5);
  await prisma.outboxEvent.deleteMany({
    where: { payload: { path: ["conversationId"], equals: conversationId } },
  });
  await runTurn({ conversationId, userId, inputId: input.id });
  await runTurn({ conversationId, userId, inputId: input.id });
  expect(
    (await prisma.inboxInput.findUniqueOrThrow({ where: { id: input.id } }))
      .status,
  ).toBe("pending");
  const wakes = await budgetWakes();
  expect(wakes).toHaveLength(2);
  const payloads = wakes.map((w) => w.payload as Record<string, string>);
  // Both deferrals name the same job, so BullMQ keeps a single delayed wake.
  expect(new Set(payloads.map((p) => p.wakeId)).size).toBe(1);
  expect(payloads[0]!.delayUntil).toBe(budgetResetsAt().toISOString());

  const added: { name: string; opts: { jobId?: string; delay?: number } }[] =
    [];
  const fake = {
    add: async (name: string, _data: unknown, opts: never) => {
      added.push({ name, opts });
    },
  } as unknown as Queue;
  await drainOutbox({ turns: fake, facts: fake, maintenance: fake }, 500);
  const ours = added.filter(
    (a) => a.opts.jobId === `turn-${payloads[0]!.wakeId}`,
  );
  expect(ours).toHaveLength(2);
  const expected = budgetResetsAt().getTime() - Date.now();
  expect(ours[0]!.opts.delay).toBeGreaterThan(expected - 60_000);
  expect(ours[0]!.opts.delay).toBeLessThanOrEqual(expected + 1000);

  // Recovery does not wake a background input every minute meanwhile.
  await prisma.inboxInput.update({
    where: { id: input.id },
    data: { createdAt: new Date(Date.now() - 120_000) },
  });
  await recoverHarnessWork();
  const recovered = await conversationTurns.getJobs(["waiting", "delayed"]);
  expect(recovered.some((j) => j.data.inputId === input.id)).toBe(false);
});

test("an agent started over the limit pauses until the reset instead of failing", async () => {
  const parent = await prisma.agentRun.create({
    data: { conversationId, userId, trigger: "user" },
  });
  const run = await createAgentRun({
    parent,
    definition: (await findDefinition(userId, "researcher"))!,
    brief: { objective: "Look up the Cedar launch date" },
  });
  await spend(1);
  const moved: number[] = [];
  await expect(
    runAgentJob({
      data: { runId: run.id },
      moveToDelayed: async (at: number) => {
        moved.push(at);
      },
    }),
  ).rejects.toThrow();
  expect(moved).toEqual([budgetResetsAt().getTime()]);
  const paused = await prisma.agentRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  expect(paused.status).toBe("queued");
  expect(paused.resumeAt).toEqual(budgetResetsAt());
  // Not reported as a stale, interrupted run while it waits.
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { startedAt: new Date(Date.now() - 2 * AGENT_STALE_MS) },
  });
  await recoverStaleAgents();
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status,
  ).toBe("queued");
  expect(
    await prisma.inboxInput.count({
      where: { conversationId, dedupeKey: `agent-result:${run.id}` },
    }),
  ).toBe(0);
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "canceled" },
  });
});

test("an agent that reaches the limit mid-run pauses before its next tool", async () => {
  const parent = await prisma.agentRun.create({
    data: { conversationId, userId, trigger: "user" },
  });
  const run = await createAgentRun({
    parent,
    definition: (await findDefinition(userId, "researcher"))!,
    brief: { objective: "Look up the Cedar launch date" },
  });
  faux.setResponses([
    // The spend lands while the model is answering, as a parallel task's would.
    async () => {
      await spend(2);
      return fauxAssistantMessage(
        [
          fauxToolCall("propose_action", {
            tool: "email_send",
            arguments: { draftId: "d" },
            reason: "r",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("should not run")]),
  ]);
  const moved: number[] = [];
  await expect(
    runAgentJob({
      data: { runId: run.id },
      moveToDelayed: async (at: number) => {
        moved.push(at);
      },
    }),
  ).rejects.toThrow();
  expect(moved).toEqual([budgetResetsAt().getTime()]);
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status,
  ).toBe("queued");
  expect(
    await prisma.actionAttempt.count({
      where: { runId: run.id, toolName: "propose_action" },
    }),
  ).toBe(0);
  expect(
    await prisma.inboxInput.count({
      where: { conversationId, dedupeKey: `agent-result:${run.id}` },
    }),
  ).toBe(0);
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "canceled" },
  });
});

test("an interaction turn cannot run a tool or another model call after crossing the daily limit", async () => {
  const message = await userInput("Research this in the background");
  faux.setResponses([
    async () => {
      await spend(2);
      return fauxAssistantMessage(
        [
          fauxToolCall("spawn_agent", {
            objective: "Research the Cedar launch",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("This continuation must not run")]),
  ]);
  await runTurn({ conversationId, userId, messageId: message.id });
  const reply = await prisma.message.findFirstOrThrow({
    where: { parentMessageId: message.id },
  });
  expect(reply.content).toContain("today's usage limit");
  const run = await prisma.agentRun.findFirstOrThrow({
    where: { inputMessageId: message.id },
  });
  expect(run.status).toBe("budget_exceeded");
  expect(
    await prisma.actionAttempt.count({
      where: { runId: run.id, toolName: "spawn_agent" },
    }),
  ).toBe(0);
  // pi may emit a synthetic error message when the guard refuses a call;
  // the provider's second scripted response never appears in the journal.
  const entries = await prisma.sessionEntry.findMany({
    where: { conversationId },
  });
  expect(JSON.stringify(entries.map((e) => e.data))).not.toContain(
    "This continuation must not run",
  );
});

test("memory ingestion keeps its watermark when the daily budget is exhausted", async () => {
  await userInput("Remember that the Cedar launch is in December");
  await spend(2);
  const before = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });
  const calls = await prisma.modelCallLog.count({ where: { userId } });
  expect(await runExtractForConversation(conversationId, "message")).toBeNull();
  const after = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });
  expect(after.lastExtractedAt).toEqual(before.lastExtractedAt);
  expect(await prisma.modelCallLog.count({ where: { userId } })).toBe(calls);
});
