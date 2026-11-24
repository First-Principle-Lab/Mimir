import type { ChatResult } from "@mimir/shared-types";
import { budgetDay, classifySpend } from "./budget.js";
import { getConfig } from "./config/config.js";
import { getLogger } from "./logger.js";
import { recordBudgetCrossing } from "./metrics.js";
import type { Prisma } from "./generated/prisma/client.js";
import { getPrismaClient } from "./prisma.js";
import { fetchGenerationCost } from "./openrouter.js";

const prisma = getPrismaClient();

// Usage accounting is best-effort: a telemetry write must never fail the
// primary path. Shared by the api (chat/classification) and the worker
// (agent_execution/agent_filter), so these live here rather than per-app.
export async function trackModelCall({
  userId,
  useCase,
  result,
  error,
  systemPromptHash,
  injectedBlocks,
  messageWindow,
  costUsd,
  costCents,
}: {
  userId: string;
  useCase: string;
  result?: ChatResult;
  error?: string;
  systemPromptHash?: string;
  injectedBlocks?: Array<{ type: string; refIds: string[] }>;
  messageWindow?: string[];
  // Known cost in USD (the pi harness gets it from the provider; OpenRouter
  // calls report it in usage). It is added to the user's daily budget.
  costUsd?: number;
  // Deprecated rounded form; prefer costUsd.
  costCents?: number;
}): Promise<string | null> {
  const spent = costUsd ?? result?.costUsd ?? (costCents ?? 0) / 100;
  try {
    const log = await prisma.$transaction(async (tx) => {
      const log = await tx.modelCallLog.create({
        data: {
          userId,
          useCase,
          model: result?.model ?? "unknown",
          actualModel: result?.actualModel,
          tokensUsed: result?.usage?.totalTokens ?? 0,
          promptTokens: result?.usage?.promptTokens,
          completionTokens: result?.usage?.completionTokens,
          cachedTokens: result?.cachedTokens,
          finishReason: result?.finishReason ?? "error",
          generationId: result?.generationId,
          costCents: costCents ?? Math.round(spent * 100),
          costUsd: spent,
          latencyMs: result?.latencyMs ?? 0,
          success: !!result && !error,
          systemPromptHash,
          injectedBlocks,
          messageWindow,
        },
      });
      if (spent > 0) await addSpend(tx, userId, spent);
      return log;
    });
    return log.id;
  } catch (e) {
    getLogger().error({ err: e }, "model call log write failed");
    return null;
  }
}

// Adds a model call's cost to the user's UTC-day total and records the moment
// the total crosses the soft or hard limit (once per day: only the call that
// crosses it sees the previous total below the line).
async function addSpend(
  db: Prisma.TransactionClient,
  userId: string,
  costUsd: number,
): Promise<void> {
  const date = budgetDay();
  const [row, user] = await Promise.all([
    db.usageRecord.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, costUsd },
      update: { costUsd: { increment: costUsd } },
      select: { costUsd: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { dailyBudgetUsd: true },
    }),
  ]);
  const limit = user?.dailyBudgetUsd ?? getConfig().USER_DAILY_BUDGET_USD;
  const before = classifySpend(row.costUsd - costUsd, limit);
  const after = classifySpend(row.costUsd, limit);
  if (after !== before && after !== "ok") {
    recordBudgetCrossing(after);
    getLogger().warn(
      { userId, spentUsd: row.costUsd, limitUsd: limit, state: after },
      "user crossed a daily budget limit",
    );
  }
}

export function backfillCost(generationId: string, logId: string): void {
  void fetchGenerationCost(generationId)
    .then((costCents) => {
      if (costCents > 0)
        return prisma.modelCallLog.update({
          where: { id: logId },
          data: { costCents },
        });
    })
    .catch((e) =>
      getLogger().warn({ err: e, logId }, "generation cost backfill failed"),
    );
}

export async function rollDailyUsage(
  userId: string,
  tokens: number,
): Promise<void> {
  if (tokens <= 0) return;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  try {
    await prisma.usageRecord.upsert({
      where: { userId_date: { userId, date: start } },
      create: { userId, date: start, tokensUsed: tokens },
      update: { tokensUsed: { increment: tokens } },
    });
  } catch (e) {
    getLogger().error({ err: e }, "usage rollup write failed");
  }
}
