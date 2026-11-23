import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "memory-ingestion-test-secret";
const {
  configureMemoryProvider,
  LegacyMemoryProvider,
  getPrismaClient,
  MemoryGateway,
} = await import("@mimir/backend-core");
const { runExtractForConversation } =
  await import("../agent/fact-extraction-run.js");
import type { MemoryTranscriptBatch } from "@mimir/backend-core";
const prisma = getPrismaClient();
const userId = "ingest-test-" + randomUUID();
const conversationId = randomUUID();
const end = new Date(Date.now() - 1000);
beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: userId,
      email: userId + "@example.test",
      passwordHash: "synthetic",
    },
  });
  await prisma.conversation.create({ data: { id: conversationId, userId } });
  await prisma.message.createMany({
    data: [
      {
        conversationId,
        role: "user",
        content: "My review day is Tuesday.",
        createdAt: new Date(end.getTime() - 2),
      },
      {
        conversationId,
        role: "assistant",
        content: "Noted.",
        createdAt: new Date(end.getTime() - 1),
      },
      {
        conversationId,
        role: "user",
        content: "api_key=synthetic-canary-0123456789",
        createdAt: end,
      },
    ],
  });
});
afterAll(async () => {
  configureMemoryProvider(new LegacyMemoryProvider());
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.user.delete({ where: { id: userId } });
});
test("failed provider ingestion preserves watermark; retry is scoped, filtered and idempotent", async () => {
  const batches: MemoryTranscriptBatch[] = [];
  let fail = true;
  const provider = Object.assign(new LegacyMemoryProvider(async () => []), {
    ingest: async (_ns: unknown, batch: MemoryTranscriptBatch) => {
      batches.push(batch);
      if (fail) throw new Error("index unavailable");
      return { inserted: 1, superseded: 0 };
    },
  });
  // A trial adapter, deliberately not a LegacyMemoryProvider instance.
  const trial = {
    id: "trial",
    version: "test",
    ingest: provider.ingest,
    search: provider.search.bind(provider),
    remember: provider.remember.bind(provider),
    forget: provider.forget.bind(provider),
    conversationSearch: provider.conversationSearch.bind(provider),
    export: provider.export.bind(provider),
  };
  configureMemoryProvider(trial);
  await expect(
    runExtractForConversation(conversationId, "message", end),
  ).rejects.toThrow("index unavailable");
  expect(
    (
      await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      })
    ).lastExtractedAt,
  ).toBeNull();
  fail = false;
  const result = await runExtractForConversation(
    conversationId,
    "message",
    end,
  );
  expect(result?.inserted).toBe(1);
  expect(batches[0]!.idempotencyKey).toBe(batches[1]!.idempotencyKey);
  expect(batches[1]!.messages.map((m) => m.content)).toEqual([
    "My review day is Tuesday.",
    "Noted.",
  ]);
  expect(
    (
      await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      })
    ).lastExtractedAt,
  ).toEqual(end);
  await expect(
    new MemoryGateway(trial).ingest(
      { userId: "another-user", conversationId },
      new Date(0),
      end,
    ),
  ).rejects.toThrow("access denied");
  const unsupported = { ...trial, ingest: undefined };
  await expect(
    new MemoryGateway(unsupported).ingest(
      { userId, conversationId },
      new Date(0),
      end,
    ),
  ).rejects.toThrow("does not support");
});
