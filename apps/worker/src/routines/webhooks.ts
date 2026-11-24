import { getLogger, getPrismaClient, recordFailure } from "@mimir/backend-core";
import {
  GMAIL_INTEGRATION,
  GITHUB_INTEGRATION,
} from "@mimir/connection-provider";
import { routineJobs } from "./routines.js";
import { pollLoop } from "../infra/poll-loop.js";
import type { Queue } from "bullmq";

const prisma = getPrismaClient();
// Webhooks are hints to re-read the owner's configured read query. Raw bodies
// never become model instructions. Polling remains the fallback for Gmail
// accounts whose mailbox differs from the login address.
export async function drainRoutineWebhooks(
  queue: Queue = routineJobs,
  eventIds?: string[],
): Promise<number> {
  const events = await prisma.webhookEvent.findMany({
    where: { processedAt: null, ...(eventIds ? { id: { in: eventIds } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let count = 0;
  for (const event of events) {
    try {
      const raw = event.rawPayload as Record<string, unknown>;
      let userIds: string[] = [];
      if (
        event.provider === "googlecalendar" &&
        typeof raw.ownerUserId === "string"
      )
        userIds = [raw.ownerUserId];
      if (event.provider === "gmail" && typeof raw.emailAddress === "string")
        userIds = (
          await prisma.integrationConnection.findMany({
            where: {
              provider: GMAIL_INTEGRATION,
              status: "connected",
              user: {
                email: { equals: raw.emailAddress, mode: "insensitive" },
              },
            },
            select: { userId: true },
          })
        ).map((c) => c.userId);
      if (event.provider === "github") {
        const repo = (raw.repository as { full_name?: string } | undefined)
          ?.full_name;
        if (repo)
          userIds = (
            await prisma.integrationConnection.findMany({
              where: { provider: GITHUB_INTEGRATION, status: "connected" },
              select: { userId: true, webhookMeta: true },
            })
          )
            .filter((c) =>
              (
                (c.webhookMeta as { hooks?: { repo: string }[] } | null)
                  ?.hooks ?? []
              ).some((h) => h.repo === repo),
            )
            .map((c) => c.userId);
      }
      const routines = await prisma.routine.findMany({
        where: {
          source: event.provider,
          userId: { in: userIds },
          status: "active",
        },
        select: { id: true },
      });
      for (const routine of routines)
        await queue.add(
          "routine",
          { routineId: routine.id },
          {
            jobId: `hook-${event.id}-${routine.id}`,
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: 1000,
          },
        );
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      count += routines.length;
    } catch (error) {
      recordFailure("webhooks", "routine_dispatch");
      getLogger().warn(
        { err: error, eventId: event.id },
        "routine webhook dispatch failed; will retry",
      );
    }
  }
  return count;
}
export function startRoutineWebhooks(): () => void {
  return pollLoop(() => drainRoutineWebhooks(), "routine webhooks", 3000);
}
