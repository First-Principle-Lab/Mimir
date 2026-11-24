import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.JWT_SECRET ??= "db-scope-test-secret";

const { createPrismaClient, getPrismaClient } = await import("./prisma.js");
const { rlsRoleStatements, unbatchedUniqueWhere, withUserScope } =
  await import("./db-scope.js");

// The local and CI database user is a superuser, which ignores RLS, so this
// client switches each connection to a restricted role, as production does
// when DATABASE_RLS_ROLE is set.
const ROLE = "mimir_rls";
const owner = getPrismaClient();
const app = createPrismaClient(process.env.DATABASE_URL!, ROLE);
const a = `rls-a-${randomUUID()}`;
const b = `rls-b-${randomUUID()}`;
const convA = randomUUID();
const convB = randomUUID();
let runB = "";

beforeAll(async () => {
  for (const sql of rlsRoleStatements(ROLE)) await owner.$executeRawUnsafe(sql);
  for (const id of [a, b])
    await owner.user.create({
      data: { id, email: `${id}@test.local`, passwordHash: "x" },
    });
  await owner.conversation.create({ data: { id: convA, userId: a } });
  await owner.conversation.create({ data: { id: convB, userId: b } });
  await owner.message.createMany({
    data: [
      { conversationId: convA, role: "user", content: "a's secret" },
      { conversationId: convB, role: "user", content: "b's secret" },
    ],
  });
  runB = (
    await owner.agentRun.create({
      data: { conversationId: convB, userId: b, trigger: "user" },
    })
  ).id;
  await owner.agentStep.create({
    data: { runId: runB, kind: "message_end", data: {} },
  });
  await owner.usageRecord.create({
    data: { userId: a, date: new Date("2026-01-01T00:00:00Z"), costUsd: 1 },
  });
});

afterAll(async () => {
  await owner.agentStep.deleteMany({ where: { runId: runB } });
  await owner.agentRun.deleteMany({ where: { userId: { in: [a, b] } } });
  await owner.message.deleteMany({
    where: { conversationId: { in: [convA, convB] } },
  });
  await owner.conversation.deleteMany({ where: { userId: { in: [a, b] } } });
  await owner.usageRecord.deleteMany({ where: { userId: { in: [a, b] } } });
  await owner.agentDefinition.deleteMany({ where: { userId: { in: [a, b] } } });
  await owner.user.deleteMany({ where: { id: { in: [a, b] } } });
  await app.$disconnect();
});

describe("row-level security", () => {
  test("a user scope sees only that user's rows, even without a filter", async () => {
    await withUserScope(a, async () => {
      const conversations = await app.conversation.findMany({
        where: { id: { in: [convA, convB] } },
      });
      expect(conversations.map((c) => c.id)).toEqual([convA]);
      const messages = await app.message.findMany({
        where: { conversationId: { in: [convA, convB] } },
      });
      expect(messages.map((m) => m.content)).toEqual(["a's secret"]);
      // Owned through the run: b's journal is invisible to a.
      expect(await app.agentStep.count({ where: { runId: runB } })).toBe(0);
      expect(
        await app.user.findMany({ where: { id: { in: [a, b] } } }),
      ).toEqual([expect.objectContaining({ id: a })]);
    });
  });

  test("writes into another user's rows are refused", async () => {
    await withUserScope(a, async () => {
      const updated = await app.conversation.updateMany({
        where: { id: convB },
        data: { lastExtractedAt: new Date() },
      });
      expect(updated.count).toBe(0);
      await expect(
        withUserScope(a, () =>
          app.agentRun.create({
            data: { userId: a, conversationId: convB, trigger: "user" },
          }),
        ),
      ).rejects.toThrow();
      // PrismaPromises are lazy thenables; await them inside a real promise.
      await expect(
        (async () =>
          app.message.create({
            data: { conversationId: convB, role: "user", content: "injected" },
          }))(),
      ).rejects.toThrow();
      await expect(
        (async () =>
          app.agentDefinition.create({
            data: {
              id: randomUUID(),
              userId: b,
              name: "x",
              description: "x",
              prompt: "x",
              tools: [],
              maxSteps: 1,
              maxUsd: 0.01,
              timeoutSec: 1,
            },
          }))(),
      ).rejects.toThrow();
    });
    expect(await owner.message.count({ where: { content: "injected" } })).toBe(
      0,
    );
  });

  test("system work outside any user scope sees every user", async () => {
    const conversations = await app.conversation.findMany({
      where: { id: { in: [convA, convB] } },
    });
    expect(conversations).toHaveLength(2);
  });

  test("production connections refuse a role that bypasses RLS", async () => {
    const unsafe = createPrismaClient(
      process.env.DATABASE_URL!,
      undefined,
      true,
    );
    try {
      await expect(
        Promise.resolve(unsafe.$queryRawUnsafe("SELECT 1")),
      ).rejects.toThrow("bypasses RLS");
    } finally {
      await unsafe.$disconnect();
    }
  });

  test("shared definitions are readable but a tenant cannot edit them", async () => {
    await withUserScope(a, async () => {
      const shared = await app.agentDefinition.findFirstOrThrow({
        where: { userId: null },
      });
      expect(
        (
          await app.agentDefinition.updateMany({
            where: { id: shared.id },
            data: { prompt: "overwrite" },
          })
        ).count,
      ).toBe(0);
    });
  });

  test("concurrent unique lookups from different users keep their own scope", async () => {
    // Issued in the same tick, Prisma would batch these into one query run
    // under the first caller's scope: b's own lookup came back empty.
    const [aSeesB, bSeesB] = await Promise.all([
      withUserScope(a, () => app.user.findUnique({ where: { id: b } })),
      withUserScope(b, () => app.user.findUnique({ where: { id: b } })),
    ]);
    expect(aSeesB).toBeNull();
    expect(bSeesB?.id).toBe(b);
    const usage = await withUserScope(a, () =>
      app.usageRecord.findUnique({
        where: {
          userId_date: { userId: a, date: new Date("2026-01-01T00:00:00Z") },
        },
      }),
    );
    expect(usage?.costUsd).toBe(1);
  });

  test("unique lookups inside a transaction stay on its connection", async () => {
    await withUserScope(a, async () => {
      const seen = await app.$transaction(async (tx) => {
        const m = await tx.message.create({
          data: { conversationId: convA, role: "user", content: "in tx" },
        });
        return tx.message.findUnique({ where: { id: m.id } });
      });
      expect(seen?.content).toBe("in tx");
      const [batched] = await app.$transaction([
        app.user.findUnique({ where: { id: a } }),
      ]);
      expect(batched?.id).toBe(a);
    });
  });
});

describe("unbatchedUniqueWhere", () => {
  test("flattens compound unique keys and leaves other filters alone", () => {
    const date = new Date();
    expect(
      unbatchedUniqueWhere({
        userId_date: { userId: "u", date },
        id: "x",
      }),
    ).toEqual({ userId: "u", date, id: "x" });
    expect(unbatchedUniqueWhere({ created_at: { gte: date } })).toEqual({
      created_at: { gte: date },
    });
  });
});
