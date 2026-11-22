import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "outbox-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { drainOutbox } = await import("../infra/outbox-relay.js");

const prisma = getPrismaClient();
const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };
// Throwaway queues, so a live dev worker can't consume what this test enqueues.
const suffix = Date.now();
const queues = {
  turns: new Queue(`outbox-turns-${suffix}`, { connection }),
  facts: new Queue(`outbox-facts-${suffix}`, { connection }),
  maintenance: new Queue(`outbox-maint-${suffix}`, { connection }),
};
const tag = randomUUID();
const rowIds: string[] = [];

async function row(eventType: string, payload: Record<string, unknown>) {
  const r = await prisma.outboxEvent.create({ data: { eventType, payload: { ...payload, tag } } });
  rowIds.push(r.id);
  return r;
}

// Other suites share the table, so only drain while our rows are the only unprocessed ones.
async function drainOurs() {
  await prisma.outboxEvent.updateMany({
    where: { processedAt: null, id: { notIn: rowIds } },
    data: { processedAt: new Date() },
  });
  return drainOutbox(queues);
}

afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { id: { in: rowIds } } });
  for (const q of Object.values(queues)) {
    await q.obliterate({ force: true });
    await q.close();
  }
});

describe("outbox relay", () => {
  test("conversation_turn rows go to the turn queue under the api's fast-path jobId", async () => {
    const messageId = randomUUID();
    const r = await row("conversation_turn", { conversationId: "c", userId: "u", messageId });
    expect(await drainOurs()).toBe(1);
    const job = await queues.turns.getJob(`turn-${messageId}`);
    expect(job?.data).toMatchObject({ messageId });
    expect((await prisma.outboxEvent.findUnique({ where: { id: r.id } }))?.processedAt).not.toBeNull();
  });

  test("an already-enqueued turn is not enqueued twice", async () => {
    const messageId = randomUUID();
    await queues.turns.add("turn", { messageId }, { jobId: `turn-${messageId}` });
    await row("conversation_turn", { conversationId: "c", userId: "u", messageId });
    await drainOurs();
    expect(await queues.turns.getJobCountByTypes("waiting", "delayed", "prioritized")).toBe(2); // this + the previous test's
  });

  test("extract_facts rows coalesce per conversation per minute", async () => {
    const windowEnd = new Date().toISOString();
    await row("extract_facts", { conversationId: "conv-x", windowEnd });
    await row("extract_facts", { conversationId: "conv-x", windowEnd });
    expect(await drainOurs()).toBe(2);
    expect(await queues.facts.getJobCountByTypes("waiting", "delayed", "prioritized")).toBe(1);
  });

  test("github_hook_register rows go to the maintenance queue", async () => {
    await row("github_hook_register", { userId: "u-1" });
    await drainOurs();
    const [job] = await queues.maintenance.getJobs(["waiting", "delayed", "prioritized"]);
    expect(job).toMatchObject({ name: "github-hook-register", data: { userId: "u-1" } });
  });

  test("malformed or retired rows are skipped and marked processed", async () => {
    const a = await row("conversation_turn", {}); // no messageId
    const b = await row("spawn_agent", { agentId: "old" }); // the deleted pipeline's event type
    expect(await drainOurs()).toBe(0);
    for (const r of [a, b]) {
      expect((await prisma.outboxEvent.findUnique({ where: { id: r.id } }))?.processedAt).not.toBeNull();
    }
  });
});
