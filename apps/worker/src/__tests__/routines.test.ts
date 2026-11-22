import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "routine-tests";
const { getPrismaClient } = await import("@mimir/backend-core");
const { runRoutine, syncRoutine, channelReadTool, scheduleTool } =
  await import("../routines/routines.js");
const prisma = getPrismaClient();
const userId = randomUUID();
const queue = new Queue(`routine-tests-${randomUUID()}`, {
  connection: { url: process.env.REDIS_URL },
});
let conversationId: string;
beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "synthetic",
    },
  });
  conversationId = (await prisma.conversation.create({ data: { userId } })).id;
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  if (!conversationId) return;
  await prisma.outboxEvent.deleteMany({
    where: { payload: { path: ["conversationId"], equals: conversationId } },
  });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.user.delete({ where: { id: userId } });
});
test("watcher pre-wake gate, immutable reads and duplicate suppression survive repeat jobs", async () => {
  const routine = await prisma.routine.create({
    data: {
      conversationId,
      userId,
      instruction: "Tell me about urgent invoices",
      source: "gmail",
      query: { tool: "search_email", args: { query: "subject:invoice" } },
      timing: { type: "interval", everyMs: 60_000 },
    },
  });
  const base = (await import("../harness/tools.js")).memorySearchSpec;
  let data = { messages: [] as { subject: string }[] };
  const tools = async () => [
    { ...base, name: "search_email", execute: async () => data },
  ];
  const job = {
    id: "one",
    timestamp: Date.now(),
    data: { routineId: routine.id },
  };
  await runRoutine(job, tools);
  expect(await prisma.inboxInput.count({ where: { conversationId } })).toBe(0);
  data = { messages: [{ subject: "Urgent invoice" }] };
  await runRoutine(job, tools);
  await runRoutine({ ...job, id: "two" }, tools);
  const inputs = await prisma.inboxInput.findMany({
    where: { conversationId },
  });
  expect(inputs).toHaveLength(1);
  expect(JSON.stringify(inputs[0]!.payload)).not.toContain("Urgent invoice");
  expect(
    (
      await prisma.routineScratch.findUniqueOrThrow({
        where: { routineId: routine.id },
      })
    ).lastToldKey,
  ).toBeNull();
  const payload = inputs[0]!.payload as { routineId: string; key: string };
  const read = channelReadTool({ userId, conversationId, inputs });
  expect(
    JSON.stringify(await read.execute(payload, { userId, conversationId })),
  ).toContain("Urgent invoice");
  await expect(
    channelReadTool({ userId: "someone-else", conversationId, inputs }).execute(
      payload,
      { userId, conversationId },
    ),
  ).resolves.toBeNull();
  data = { messages: [{ subject: "Different invoice" }] };
  await runRoutine({ ...job, id: "three" }, tools);
  expect(
    JSON.stringify(await read.execute(payload, { userId, conversationId })),
  ).toContain("Urgent invoice");
  expect(
    await prisma.routineObservation.count({ where: { routineId: routine.id } }),
  ).toBe(2);
});
test("durable schedule synchronization is idempotent and disable removes its scheduler", async () => {
  const r = await prisma.routine.create({
    data: {
      conversationId,
      userId,
      instruction: "Stretch",
      source: "schedule",
      query: {},
      timing: { type: "cron", cron: "0 9 * * *", timezone: "Asia/Kolkata" },
    },
  });
  await syncRoutine(r.id, queue);
  await syncRoutine(r.id, queue);
  expect(await queue.getJobSchedulersCount()).toBe(1);
  await prisma.routine.update({
    where: { id: r.id },
    data: { status: "disabled" },
  });
  await syncRoutine(r.id, queue);
  expect(await queue.getJobSchedulersCount()).toBe(0);
  const once = await prisma.routine.create({
    data: {
      conversationId,
      userId,
      instruction: "One reminder",
      source: "schedule",
      query: {},
      timing: { type: "once", at: new Date(Date.now() + 120000).toISOString() },
    },
  });
  await syncRoutine(once.id, queue);
  const timestamp = (await queue.getJob(`once-${once.id}`))!.timestamp;
  await syncRoutine(once.id, queue);
  expect((await queue.getJob(`once-${once.id}`))!.timestamp).toBe(timestamp);
});

test("verified calendar webhook hints dispatch only that owner's routines", async () => {
  const { drainRoutineWebhooks } = await import("../routines/webhooks.js");
  const r = await prisma.routine.create({
    data: {
      conversationId,
      userId,
      instruction: "Watch events",
      source: "googlecalendar",
      query: {},
      timing: { type: "interval", everyMs: 60000 },
    },
  });
  const event = await prisma.webhookEvent.create({
    data: {
      provider: "googlecalendar",
      externalId: randomUUID(),
      rawPayload: { ownerUserId: userId },
    },
  });
  const foreign = await prisma.webhookEvent.create({
    data: {
      provider: "googlecalendar",
      externalId: randomUUID(),
      rawPayload: { ownerUserId: "foreign-user" },
    },
  });
  try {
    expect(await drainRoutineWebhooks(queue, [event.id, foreign.id])).toBe(1);
    expect(await queue.getJob(`hook-${event.id}-${r.id}`)).not.toBeNull();
    expect(await queue.getJob(`hook-${foreign.id}-${r.id}`)).toBeUndefined();
  } finally {
    await prisma.webhookEvent.deleteMany({
      where: { id: { in: [event.id, foreign.id] } },
    });
  }
});
test("idle wakes once per period of inactivity and routine management is owner-scoped", async () => {
  const r = await prisma.routine.create({
    data: {
      conversationId,
      userId,
      instruction: "Check in",
      source: "schedule",
      query: {},
      timing: { type: "idle", everyMs: 60000 },
      createdAt: new Date(Date.now() - 120000),
    },
  });
  const before = await prisma.inboxInput.count({ where: { conversationId } });
  await runRoutine({
    data: { routineId: r.id },
    id: "idle-one",
    timestamp: Date.now(),
  });
  await runRoutine({
    data: { routineId: r.id },
    id: "idle-two",
    timestamp: Date.now(),
  });
  expect(await prisma.inboxInput.count({ where: { conversationId } })).toBe(
    before + 1,
  );
  const foreign = scheduleTool({
    userId: "foreign",
    conversationId,
    runId: "test",
    assertOwned: async () => {},
  });
  await expect(
    foreign.execute(
      { action: "disable", id: r.id },
      { userId, conversationId },
    ),
  ).rejects.toThrow("Routine not found");
});
