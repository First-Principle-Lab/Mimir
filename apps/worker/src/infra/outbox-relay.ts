import { getLogger, getPrismaClient } from "@mimir/backend-core";
import {
  agentJobs,
  agentTriggers,
  emailJobs,
  onceJobs,
  factExtractionJobs,
  retryPolicy,
} from "./queues.js";
import { pollLoop } from "./poll-loop.js";

const prisma = getPrismaClient();

// Poll OutboxEvent for unprocessed rows, enqueue the real BullMQ job, then mark
// processedAt. Polling (not a stream) is what makes this crash-safe: a Redis
// outage mid-spawn loses nothing — the row stays unprocessed until the next tick.
// jobId = outbox row id so BullMQ dedupes a re-polled row.
// (BullMQ 6 forbids ':' in custom job IDs, hence the '-' separator.)
// `queue`/`emailQueue`/`onceQueue`/`factQueue` are injectable so tests can hand in their own connections.
export async function drainOutbox(
  queue = agentJobs,
  emailQueue = emailJobs,
  onceQueue = onceJobs,
  factQueue = factExtractionJobs,
  triggerQueue = agentTriggers,
  batchSize = 50,
): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: { processedAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
  let enqueued = 0;
  for (const row of rows) {
    if (row.eventType === "email_send") {
      try {
        await emailQueue.add("send", row.payload, {
          ...retryPolicy,
          jobId: `outbox-${row.id}`,
        });
        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
        enqueued += 1;
        getLogger().info(
          { outboxId: row.id },
          "email send outbox row relayed to email-jobs",
        );
      } catch (e) {
        getLogger().error(
          { err: e, outboxId: row.id },
          "email send outbox relay failed; row left unprocessed for retry",
        );
      }
      continue;
    }
    if (row.eventType === "one_shot") {
      try {
        await onceQueue.add("execute", row.payload, {
          ...retryPolicy,
          jobId: `outbox-${row.id}`,
        });
        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
        enqueued += 1;
        getLogger().info(
          { outboxId: row.id },
          "one-shot outbox row relayed to agent-once",
        );
      } catch (e) {
        getLogger().error(
          { err: e, outboxId: row.id },
          "one-shot outbox relay failed; row left unprocessed for retry",
        );
      }
      continue;
    }
    if (row.eventType === "extract_facts") {
      const p = row.payload as { conversationId?: string };
      if (!p.conversationId) {
        getLogger().warn(
          { outboxId: row.id },
          "extract_facts outbox row missing conversationId; skipping",
        );
        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
        continue;
      }
      try {
        const windowMinute = Math.floor(
          new Date(
            (p as { windowEnd?: string }).windowEnd ?? Date.now(),
          ).getTime() / 60_000,
        );
        await factQueue.add(
          "extract",
          { conversationId: p.conversationId },
          { ...retryPolicy, jobId: `fact-${p.conversationId}-${windowMinute}` },
        );
        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
        enqueued += 1;
        getLogger().info(
          { outboxId: row.id, conversationId: p.conversationId },
          "extract_facts outbox row relayed to fact-extraction",
        );
      } catch (e) {
        getLogger().error(
          { err: e, outboxId: row.id },
          "extract_facts outbox relay failed; row left unprocessed for retry",
        );
      }
      continue;
    }
    if (row.eventType === "github_hook_register") {
      const p = row.payload as { userId?: string };
      if (!p.userId) {
        getLogger().warn({ outboxId: row.id }, "github_hook_register outbox row missing userId; skipping");
        await prisma.outboxEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
        continue;
      }
      try {
        // Connect-time webhook registration: a one-off agent-triggers job that
        // runs immediately (not at the next daily sweep). Keyed by the outbox
        // ROW id (not the user) so a re-connect after disconnect is a fresh job
        // that actually runs, and spread retryPolicy like every other branch so
        // a transient GitHub error retries instead of silently deferring to the
        // daily sweep.
        await triggerQueue.add("github-hook-register", { userId: p.userId }, { ...retryPolicy, jobId: `gh-hook-${row.id}` });
        await prisma.outboxEvent.update({ where: { id: row.id }, data: { processedAt: new Date() } });
        enqueued += 1;
        getLogger().info({ outboxId: row.id, userId: p.userId }, "github hook register outbox row relayed to agent-triggers");
      } catch (e) {
        getLogger().error({ err: e, outboxId: row.id }, "github hook register relay failed; row left unprocessed for retry");
      }
      continue;
    }
    const payload = row.payload as {
      agentId?: string;
      trigger?: string;
      context?: unknown;
    };
    if (!payload.agentId) {
      getLogger().warn(
        { outboxId: row.id, eventType: row.eventType },
        "outbox row missing agentId; skipping",
      );
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      });
      continue;
    }
    try {
      await queue.add(
        "execute",
        {
          agentId: payload.agentId,
          trigger: payload.trigger ?? "user_message",
          context: payload.context,
        },
        { ...retryPolicy, jobId: `outbox-${row.id}` },
      );
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      });
      enqueued += 1;
      getLogger().info(
        { outboxId: row.id, agentId: payload.agentId },
        "outbox row relayed to agent-jobs",
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
