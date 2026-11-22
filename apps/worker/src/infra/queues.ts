import {
  CONVERSATION_TURNS,
  getConfig,
  getLogger,
  getPrismaClient,
  runWithContext,
} from "@mimir/backend-core";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import {
  runStaleFactExtractionSweep,
  runExtractForConversation,
} from "../agent/fact-extraction-run.js";
import { turnProcessor } from "../harness/turn.js";
import {
  githubRequestFor,
  registerGithubWebhooksForUser,
  runGithubHookSweep,
} from "../integrations/github/github-webhooks.js";
import { runWatchRenewal } from "../integrations/gmail/watch-renewal.js";
import { runConnectionCanary } from "../integrations/connection-canary.js";
import { routineJobs, runRoutine, syncRoutine } from "../routines/routines.js";
import { publishUserEvent } from "./redis.js";

// Queue name kept from the old pipeline so its existing job schedulers in Redis
// stay addressable (and removable, see removeObsoleteSchedulers).
export const MAINTENANCE = "agent-triggers";
export const FAILED_JOBS = "failed-agent-jobs";
export const FACT_EXTRACTION = "fact-extraction";

const cfg = getConfig();
const connection = { url: cfg.REDIS_URL, maxRetriesPerRequest: null };

export const retryPolicy: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
};

// A turn is interactive: retry a crashed or busy attempt quickly, a few times.
// Re-running is safe while every tool is read-only (Phase 1).
export const turnRetryPolicy: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
};

export const conversationTurns = new Queue(CONVERSATION_TURNS, { connection });
export const maintenanceJobs = new Queue(MAINTENANCE, { connection });
export const failedJobs = new Queue(FAILED_JOBS, { connection });
export const factExtractionJobs = new Queue(FACT_EXTRACTION, { connection });

async function noop(job: Job): Promise<void> {
  getLogger().info(
    { queue: job.queueName, id: job.id, data: job.data },
    "job processed (no-op)",
  );
}

// Schedulers registered by the deleted agent pipeline. Their jobs would now
// land in the no-op branch every minute, so drop them at boot.
const OBSOLETE_SCHEDULERS = [
  "dormancy-sweep",
  "mail-poll-sweep",
  "github-poll-sweep",
  "calendar-poll-sweep",
  "trigger-tick",
];

export async function removeObsoleteSchedulers(
  queue = maintenanceJobs,
): Promise<void> {
  for (const id of OBSOLETE_SCHEDULERS) await queue.removeJobScheduler(id);
}

// Daily github repo-webhook self-heal sweep — re-registers hooks for any
// connected github account whose connect-time registration was missed (api
// restart around the outbox drain). The scheduled job never blocks a fresh
// connection: connect-time enqueues a one-off github-hook-register job too.
export async function scheduleGithubHookSweep(): Promise<void> {
  await maintenanceJobs.upsertJobScheduler(
    "github-hook-sweep",
    { pattern: "0 1 * * *", immediately: false },
    { name: "github-hook-sweep", data: { githubHooks: true } },
  );
}

// Daily gmail watch renewal sweep — re-registers watches nearing expiry.
export async function scheduleWatchRenewal(): Promise<void> {
  await maintenanceJobs.upsertJobScheduler(
    "watch-renewal",
    { pattern: "0 2 * * *", immediately: false },
    { name: "watch-renewal", data: { renew: true } },
  );
}

// Daily connection canary — exercises gmail apiRequest so a silent break in
// the provider's proxy transport is caught by a job, not a user.
export async function scheduleConnectionCanary(): Promise<void> {
  await maintenanceJobs.upsertJobScheduler(
    "connection-canary",
    { pattern: "0 4 * * *", immediately: false },
    { name: "connection-canary", data: { canary: true } },
  );
}

export async function scheduleFactExtractionSweep(): Promise<void> {
  await maintenanceJobs.upsertJobScheduler(
    "fact-extraction-sweep",
    { pattern: cfg.FACT_SWEEP_CRON, immediately: false },
    { name: "fact-extraction-sweep", data: { facts: true } },
  );
}

export async function scheduleHarnessRecovery(): Promise<void> {
  await maintenanceJobs.upsertJobScheduler(
    "harness-recovery",
    { every: 60_000 },
    { name: "harness-recovery", data: {} },
  );
}
export async function recoverHarnessWork(): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.actionApproval.updateMany({
    where: { status: "pending", expiresAt: { lte: new Date() } },
    data: { status: "expired" },
  });
  await prisma.agentRun.updateMany({
    where: {
      status: "waiting_human",
      approvals: {
        none: { status: { in: ["pending", "approved", "executing"] } },
      },
    },
    data: { status: "interrupted", finishedAt: new Date() },
  });
  const inputs = await prisma.inboxInput.findMany({
    where: {
      status: { in: ["pending", "running"] },
      createdAt: { lt: new Date(Date.now() - 60_000) },
    },
    include: { conversation: { select: { userId: true } } },
    take: 100,
    orderBy: { seq: "asc" },
  });
  for (const input of inputs)
    await conversationTurns.add(
      "turn",
      {
        conversationId: input.conversationId,
        userId: input.conversation.userId,
        inputId: input.id,
      },
      {
        ...turnRetryPolicy,
        jobId: `recovery-${input.id}-${Math.floor(Date.now() / 60_000)}`,
      },
    );
  const routines = await prisma.routine.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const routine of routines) await syncRoutine(routine.id);
}

// Maintenance processor: integration upkeep and the fact-extraction sweep.
// Exported so tests can exercise it on a throwaway queue.
export async function maintenanceProcessor(job: Job): Promise<void> {
  switch (job.name) {
    case "harness-recovery":
      await recoverHarnessWork();
      return;
    case "routine-sync":
      await syncRoutine(job.data.routineId);
      return;
    case "delivery-ready":
      await publishUserEvent(job.data.userId, "delivery_ready", {});
      return;
    case "github-hook-sweep":
      await runGithubHookSweep();
      return;
    case "github-hook-register":
      // One-off from the connect-time outbox row: register hooks for exactly
      // this user right now, not at the next daily sweep.
      {
        const { userId } = (job.data ?? {}) as { userId?: string };
        if (userId)
          await registerGithubWebhooksForUser(githubRequestFor, userId);
      }
      return;
    case "watch-renewal":
      await runWatchRenewal();
      return;
    case "connection-canary":
      await runConnectionCanary();
      return;
    case "fact-extraction-sweep":
      await runStaleFactExtractionSweep();
      return;
    default:
      return noop(job);
  }
}

export async function factExtractionProcessor(job: Job): Promise<void> {
  const { conversationId } = (job.data ?? {}) as { conversationId?: string };
  if (!conversationId) {
    getLogger().warn(
      { id: job.id },
      "fact-extraction job missing conversationId",
    );
    return;
  }
  await runExtractForConversation(conversationId, "message");
}

export function wireDlq<D, R, N extends string>(worker: Worker<D, R, N>): void {
  worker.on("failed", (job, err) => {
    // Guard against non-terminal 'failed' emissions (if any): only move a job
    // to the DLQ once its retries are actually exhausted.
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    failedJobs
      .add("failed", {
        queue: worker.name,
        jobId: job.id,
        data: job.data,
        error: String(err),
        failedAt: new Date().toISOString(),
      })
      .catch((addErr) =>
        getLogger().error(
          { queue: worker.name, id: job.id, addErr },
          "failed to move job to DLQ",
        ),
      );
    getLogger().error(
      { queue: worker.name, id: job.id, err },
      "job exhausted retries, moved to DLQ",
    );
  });
}

export function startWorkers(): Worker[] {
  const registrations: Array<
    [
      Queue,
      (job: Job, token?: string) => Promise<unknown>,
      { concurrency?: number },
    ]
  > = [
    // Turns for different conversations run in parallel; the harness itself
    // serializes turns within one conversation.
    [conversationTurns, turnProcessor, { concurrency: 20 }],
    [routineJobs, (job) => runRoutine(job), { concurrency: 10 }],
    [maintenanceJobs, maintenanceProcessor, { concurrency: 20 }],
    [factExtractionJobs, factExtractionProcessor, { concurrency: 4 }],
  ];

  const workers: Worker[] = [];
  for (const [queue, processor, workerOpts] of registrations) {
    // Thread jobId through every log line in the job's lifecycle (the api does the
    // same for requestId). ALS carries it down the async chain.
    const withContext = (job: Job, token?: string): Promise<unknown> =>
      new Promise((resolve, reject) => {
        runWithContext({ jobId: String(job.id), queue: queue.name }, () => {
          processor(job, token).then(resolve, reject);
        });
      });
    const worker = new Worker(queue.name, withContext, {
      connection,
      ...workerOpts,
    });
    wireDlq(worker);
    workers.push(worker);
  }
  return workers;
}
