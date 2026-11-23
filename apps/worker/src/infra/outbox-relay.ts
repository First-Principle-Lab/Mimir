import { getLogger, getPrismaClient } from "@mimir/backend-core";
import type { Queue } from "bullmq";
import {
  conversationTurns,
  factExtractionJobs,
  maintenanceJobs,
  retryPolicy,
  turnRetryPolicy,
} from "./queues.js";
import { pollLoop } from "./poll-loop.js";
import { agentJobId, agentJobs } from "../harness/agents.js";

const prisma = getPrismaClient();

export interface OutboxQueues {
  turns: Queue;
  facts: Queue;
  maintenance: Queue;
  agents?: Queue;
}

const defaultQueues = (): OutboxQueues => ({
  turns: conversationTurns,
  facts: factExtractionJobs,
  maintenance: maintenanceJobs,
  agents: agentJobs,
});

// Map one outbox row to the BullMQ job it stands for, or null when the row is
// malformed (it is then marked processed and skipped). jobIds make a re-polled
// row a BullMQ no-op. (BullMQ 6 forbids ':' in custom job IDs.)
function jobFor(
  row: { id: string; eventType: string; payload: unknown },
  q: OutboxQueues,
) {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  switch (row.eventType) {
    case "conversation_turn":
      // Same jobId the api's fast path uses, so a row the api already enqueued
      // is not run twice.
      if (typeof p.messageId !== "string" && typeof p.inputId !== "string")
        return null;
      return () =>
        q.turns.add("turn", p, {
          ...turnRetryPolicy,
          jobId: `turn-${p.wakeId ?? p.messageId ?? p.inputId}`,
        });
    case "delivery_ready":
      if (typeof p.userId !== "string") return null;
      return () =>
        q.maintenance.add("delivery-ready", p, {
          ...retryPolicy,
          jobId: `delivery-${row.id}`,
          removeOnComplete: 1000,
        });
    case "routine_sync":
      if (typeof p.routineId !== "string") return null;
      return () =>
        q.maintenance.add("routine-sync", p, {
          ...retryPolicy,
          jobId: `routine-sync-${row.id}`,
          removeOnComplete: 1000,
        });
    case "extract_facts": {
      if (typeof p.conversationId !== "string") return null;
      const windowMinute = Math.floor(
        new Date((p.windowEnd as string) ?? Date.now()).getTime() / 60_000,
      );
      return () =>
        q.facts.add(
          "extract",
          { conversationId: p.conversationId },
          { ...retryPolicy, jobId: `fact-${p.conversationId}-${windowMinute}` },
        );
    }
    case "github_hook_register":
      // Connect-time webhook registration: a one-off maintenance job that runs
      // now, not at the next daily sweep. Keyed by the outbox ROW id so a
      // reconnect after a disconnect is a fresh job.
      if (typeof p.userId !== "string") return null;
      return () =>
        q.maintenance.add(
          "github-hook-register",
          { userId: p.userId },
          { ...retryPolicy, jobId: `gh-hook-${row.id}` },
        );
    case "agent_run":
      // Same jobId as spawn_agent's fast path.
      if (typeof p.runId !== "string" || !q.agents) return null;
      return () =>
        q.agents!.add(
          "agent",
          { runId: p.runId },
          { ...retryPolicy, jobId: agentJobId(p.runId as string) },
        );
    default:
      return null;
  }
}

// Poll OutboxEvent for unprocessed rows, enqueue the real BullMQ job, then mark
// processedAt. Polling (not a stream) is what makes this crash-safe: a Redis
// outage loses nothing — the row stays unprocessed until the next tick.
export async function drainOutbox(
  queues: OutboxQueues = defaultQueues(),
  batchSize = 50,
): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: { processedAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
  let enqueued = 0;
  for (const row of rows) {
    const enqueue = jobFor(row, queues);
    if (!enqueue) {
      getLogger().warn(
        { outboxId: row.id, eventType: row.eventType },
        "outbox row has no handler or is malformed; skipping",
      );
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      });
      continue;
    }
    try {
      await enqueue();
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      });
      enqueued += 1;
      getLogger().info(
        { outboxId: row.id, eventType: row.eventType },
        "outbox row relayed",
      );
    } catch (e) {
      getLogger().error(
        { err: e, outboxId: row.id },
        "outbox relay failed; row left unprocessed for retry",
      );
    }
  }
  return enqueued;
}

// The relay loop: every few seconds, drain unprocessed rows. Returns a stop handle.
export function startOutboxRelay(intervalMs = 3000): () => void {
  return pollLoop(() => drainOutbox(), "outbox", intervalMs);
}
