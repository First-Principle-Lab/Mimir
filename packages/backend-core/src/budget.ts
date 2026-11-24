import { getConfig } from "./config/config.js";
import { getPrismaClient } from "./prisma.js";

// Per-user daily model budget. Every model call adds its cost to the user's
// UsageRecord for the UTC day (trackModelCall); callers read the state here.
// Soft: the user is warned. Hard: chat intake refuses new messages, ambient
// turns wait and background agents pause until the next UTC day.
export type BudgetState = "ok" | "soft" | "hard";

export interface BudgetStatus {
  state: BudgetState;
  spentUsd: number;
  limitUsd: number;
  softUsd: number;
  resetsAt: Date;
}

export function budgetDay(now = new Date()): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export function budgetResetsAt(now = new Date()): Date {
  return new Date(budgetDay(now).getTime() + 86_400_000);
}

export function classifySpend(
  spentUsd: number,
  limitUsd: number,
  softRatio = getConfig().USER_BUDGET_SOFT_RATIO,
): BudgetState {
  if (spentUsd >= limitUsd) return "hard";
  if (spentUsd >= limitUsd * softRatio) return "soft";
  return "ok";
}

export async function budgetStatus(
  userId: string,
  now = new Date(),
): Promise<BudgetStatus> {
  const prisma = getPrismaClient();
  const cfg = getConfig();
  const [user, usage] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { dailyBudgetUsd: true },
    }),
    prisma.usageRecord.findUnique({
      where: { userId_date: { userId, date: budgetDay(now) } },
      select: { costUsd: true },
    }),
  ]);
  const limitUsd = user?.dailyBudgetUsd ?? cfg.USER_DAILY_BUDGET_USD;
  const spentUsd = usage?.costUsd ?? 0;
  return {
    state: classifySpend(spentUsd, limitUsd, cfg.USER_BUDGET_SOFT_RATIO),
    spentUsd,
    limitUsd,
    softUsd: limitUsd * cfg.USER_BUDGET_SOFT_RATIO,
    resetsAt: budgetResetsAt(now),
  };
}

// The wire shape the API and web client share.
export function budgetView(status: BudgetStatus) {
  return {
    state: status.state,
    spentUsd: Number(status.spentUsd.toFixed(4)),
    limitUsd: status.limitUsd,
    resetsAt: status.resetsAt.toISOString(),
  };
}
