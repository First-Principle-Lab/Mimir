import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.JWT_SECRET ??= "budget-test-secret";

const { budgetDay, budgetResetsAt, budgetStatus, classifySpend } =
  await import("./budget.js");
const { trackModelCall } = await import("./usage.js");
const { getPrismaClient } = await import("./prisma.js");

const prisma = getPrismaClient();
const userId = `budget-${randomUUID()}`;

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@test.local`,
      passwordHash: "x",
      dailyBudgetUsd: 0.01,
    },
  });
});

afterAll(async () => {
  await prisma.modelCallLog.deleteMany({ where: { userId } });
  await prisma.usageRecord.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("daily budget", () => {
  test("classifies spend against soft and hard limits", () => {
    expect(classifySpend(0, 5, 0.8)).toBe("ok");
    expect(classifySpend(3.99, 5, 0.8)).toBe("ok");
    expect(classifySpend(4, 5, 0.8)).toBe("soft");
    expect(classifySpend(5, 5, 0.8)).toBe("hard");
  });

  test("windows are UTC days", () => {
    const now = new Date("2026-11-24T23:59:59.000+05:30");
    expect(budgetDay(now).toISOString()).toBe("2026-11-24T00:00:00.000Z");
    expect(budgetResetsAt(now).toISOString()).toBe("2026-11-25T00:00:00.000Z");
  });

  test("every model call's exact cost adds up, crossing soft then hard", async () => {
    expect((await budgetStatus(userId)).state).toBe("ok");
    // Sub-cent calls: rounded cents would never reach the limit.
    for (let i = 0; i < 3; i++)
      await trackModelCall({ userId, useCase: "test", costUsd: 0.003 });
    const soft = await budgetStatus(userId);
    expect(soft.spentUsd).toBeCloseTo(0.009, 6);
    expect(soft.state).toBe("soft");
    await trackModelCall({ userId, useCase: "test", costUsd: 0.002 });
    const hard = await budgetStatus(userId);
    expect(hard.state).toBe("hard");
    expect(hard.limitUsd).toBe(0.01);
    expect(hard.resetsAt).toEqual(budgetResetsAt());
  });

  test("provider-reported cost on a call result counts too", async () => {
    const before = (await budgetStatus(userId)).spentUsd;
    await trackModelCall({
      userId,
      useCase: "fact_extraction",
      result: {
        content: "",
        model: "m",
        latencyMs: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        costUsd: 0.0005,
      },
    });
    expect((await budgetStatus(userId)).spentUsd).toBeCloseTo(
      before + 0.0005,
      6,
    );
  });

  test("concurrent calls atomically retain every sub-cent charge and log", async () => {
    const before = (await budgetStatus(userId)).spentUsd;
    await Promise.all(
      Array.from({ length: 16 }, () =>
        trackModelCall({ userId, useCase: "parallel-spend", costUsd: 0.0007 }),
      ),
    );
    expect((await budgetStatus(userId)).spentUsd).toBeCloseTo(
      before + 16 * 0.0007,
      8,
    );
    const calls = await prisma.modelCallLog.findMany({
      where: { userId, useCase: "parallel-spend" },
    });
    expect(calls).toHaveLength(16);
    expect(calls.every((c) => c.costUsd === 0.0007)).toBe(true);
  });
});
