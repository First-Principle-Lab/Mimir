import {
  budgetDay,
  CONVERSATION_TURNS,
  getConfig,
  getLogger,
  getPrismaClient,
  recordFailure,
  recordJob,
  registerGauge,
  runWithContext,
  withUserScope,
} from "@mimir/backend-core";
import {
  DelayedError,
  Queue,
  Worker,
  type Job,
  type JobsOptions,
} from "bullmq";
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
import {
  agentJobs,
  recoverStaleAgents,
  runAgentJob,
} from "../harness/agents.js";
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
// Reads may repeat; the action journal prevents interrupted writes from retrying.
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
  await recoverStaleAgents();
  const exhausted = await prisma.$queryRaw<{ id: string }[]>`
    SELECT u.id FROM "User" u
    LEFT JOIN "UsageRecord" usage ON usage."userId" = u.id AND usage.date = ${budgetDay()}
    WHERE COALESCE(usage."costUsd", 0) >= COALESCE(u."dailyBudgetUsd", ${cfg.USER_DAILY_BUDGET_USD})
  `;
  const inputs = await prisma.inboxInput.findMany({
    where: {
      status: { in: ["pending", "running"] },
      createdAt: { lt: new Date(Date.now() - 60_000) },
      // Filter before LIMIT so paused users cannot occupy the recovery batch
      // and starve another user's lost wake.
      OR: [
        { kind: "user" },
        { conversation: { userId: { notIn: exhausted.map((u) => u.id) } } },
      ],
    },
    include: { conversation: { select: { userId: true } } },
    take: 100,
    orderBy: { seq: "asc" },
  });
  // Background inputs of a user over the hard budget already have one delayed
  // wake per conversation (see runTurn); waking them every minute would only
  // defer again. User messages still get their budget notice.
  for (const input of inputs) {
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
  }
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
  worker.on("error", (err) => {
    recordFailure("queue", "worker_error");
    getLogger().error({ err, queue: worker.name }, "worker transport error");
  });
  worker.on("stalled", (jobId) => {
    recordFailure("queue", "stalled");
    getLogger().warn(
      { queue: worker.name, jobId },
      "stalled job will be retried",
    );
  });
  worker.on("failed", (job, err) => {
    // Guard against non-terminal 'failed' emissions (if any): only move a job
    // to the DLQ once its retries are actually exhausted.
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    recordFailure("queue", "dead_letter");
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

// Every worker job runs through this wrapper: log context, the user's RLS
// scope when the job names its user, and duration/lag/outcome metrics.
export function jobProcessor(
  queueName: string,
  processor: (job: Job, token?: string) => Promise<unknown>,
): (job: Job, token?: string) => Promise<unknown> {
  // Thread jobId through every log line in the job's lifecycle (the api does the
  // same for requestId). ALS carries it down the async chain.
  // A job that names its user runs under that user's RLS scope.
  const withContext = (job: Job, token?: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      runWithContext({ jobId: String(job.id), queue: queueName }, () => {
        const userId = (job.data as { userId?: unknown } | undefined)?.userId;
        const run = async () => {
          // Routine and extraction jobs carry an owned resource id instead
          // of userId. Resolve it in system scope, then restrict their work.
          if (typeof userId !== "string") {
            const data = job.data as {
              routineId?: string;
              conversationId?: string;
            };
            const prisma = getPrismaClient();
            const owner = data.routineId
              ? await prisma.routine.findUnique({
                  where: { id: data.routineId },
                  select: { userId: true },
                })
              : data.conversationId
                ? await prisma.conversation.findUnique({
                    where: { id: data.conversationId },
                    select: { userId: true },
                  })
                : null;
            if (owner)
              return withUserScope(owner.userId, () => processor(job, token));
          }
          return processor(job, token);
        };
        (typeof userId === "string" ? withUserScope(userId, run) : run()).then(
          resolve,
          reject,
        );
      });
    });
  const measured = async (job: Job, token?: string): Promise<unknown> => {
    const startedAt = Date.now();
    // Lag counts from when the job was due. A job a processor moved back to
    // delayed (debounce, busy, budget) has no reliable due time, so it is
    // left out rather than reported as hours late.
    const moved = (job.delay ?? 0) !== (job.opts.delay ?? 0);
    const lag = moved
      ? undefined
      : Math.max(0, startedAt - job.timestamp - (job.delay ?? 0)) / 1000;
    try {
      const result = await withContext(job, token);
      recordJob(queueName, "completed", (Date.now() - startedAt) / 1000, lag);
      return result;
    } catch (error) {
      recordJob(
        queueName,
        error instanceof DelayedError ? "delayed" : "failed",
        (Date.now() - startedAt) / 1000,
        lag,
      );
      throw error;
    }
  };
  return measured;
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
    // Per-user running limits are enforced inside the job.
    [agentJobs, runAgentJob, { concurrency: 10 }],
    [maintenanceJobs, maintenanceProcessor, { concurrency: 20 }],
    [factExtractionJobs, factExtractionProcessor, { concurrency: 4 }],
  ];

  const workers: Worker[] = [];
  for (const [queue, processor, workerOpts] of registrations) {
    const worker = new Worker(queue.name, jobProcessor(queue.name, processor), {
      connection,
      ...workerOpts,
    });
    wireDlq(worker);
    workers.push(worker);
  }
  registerWorkerGauges(registrations.map(([queue]) => queue));
  return workers;
}

let gaugesRegistered = false;
// Backlogs that alerting watches. Every worker instance reports the same
// shared values; alert rules take max() across instances.
export function registerWorkerGauges(queues: Queue[]): void {
  if (gaugesRegistered) return;
  gaugesRegistered = true;
  registerGauge(
    "mimir_queue_jobs",
    "BullMQ jobs by queue and state",
    async () => {
      const rows: Array<[number, { queue: string; state: string }]> = [];
      for (const queue of [...queues, failedJobs]) {
        const counts = await queue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
        );
        for (const [state, n] of Object.entries(counts))
          rows.push([n, { queue: queue.name, state }]);
      }
      return rows;
    },
  );
  const prisma = getPrismaClient();
  registerGauge(
    "mimir_outbox_backlog",
    "Outbox rows unrelayed for more than 30 seconds",
    async () => [
      [
        await prisma.outboxEvent.count({
          where: {
            processedAt: null,
            createdAt: { lt: new Date(Date.now() - 30_000) },
          },
        }),
        {},
      ],
    ],
  );
  registerGauge(
    "mimir_deliveries_overdue",
    "Deliveries due more than two minutes ago and still unsent",
    async () => [
      [
        await prisma.delivery.count({
          where: {
            status: { in: ["pending", "sending"] },
            availableAt: { lt: new Date(Date.now() - 120_000) },
          },
        }),
        {},
      ],
    ],
  );
}
