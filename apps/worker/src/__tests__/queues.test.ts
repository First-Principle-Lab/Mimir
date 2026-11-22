import { afterAll, describe, expect, test } from "bun:test";
import { Queue, Worker } from "bullmq";

// Config is validated at import time; set env before importing queues.js.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "queue-test-secret";

const { conversationTurns, factExtractionJobs, failedJobs, maintenanceJobs, maintenanceProcessor, removeObsoleteSchedulers, wireDlq } =
  await import("../infra/queues.js");

const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };

async function poll<T>(fn: () => Promise<T>, ok: (t: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error("poll timed out");
    await Bun.sleep(50);
  }
}

// Tests use throwaway queues: a live dev worker may own the real ones.
afterAll(async () => {
  await Promise.all([conversationTurns.close(), maintenanceJobs.close(), failedJobs.close(), factExtractionJobs.close()]);
}, 30_000);

describe("dead-letter queue", () => {
  test("a job that exhausts retries lands in failed-agent-jobs", async () => {
    const name = `test-failing-${Date.now()}`;
    const q = new Queue(name, { connection });
    const w = new Worker<{ n: number }, void, string>(name, async () => { throw new Error("boom"); }, { connection, concurrency: 1 });
    wireDlq(w);
    const before = (await failedJobs.getJobCounts("waiting")).waiting ?? 0;

    const job = await q.add("doomed", { n: 1 }, { attempts: 2, backoff: { type: "exponential", delay: 50 } });
    await poll(() => job.getState(), (s) => s === "failed");
    await poll(() => failedJobs.getJobCounts("waiting"), (c) => (c.waiting ?? 0) > before);

    await w.close();
    await q.close();
  });
});

describe("maintenance queue", () => {
  test("unknown job names complete as no-ops", async () => {
    const q = new Queue(`maintenance-test-${Date.now()}`, { connection });
    const w = new Worker(q.name, maintenanceProcessor, { connection });
    const job = await q.add("something-retired", {});
    await poll(() => job.getState(), (s) => s === "completed");
    await w.close();
    await q.close();
  });

  test("removeObsoleteSchedulers drops the old agent pipeline's schedulers and keeps the rest", async () => {
    const q = new Queue(`schedulers-test-${Date.now()}`, { connection });
    for (const id of ["trigger-tick", "mail-poll-sweep", "watch-renewal"]) {
      await q.upsertJobScheduler(id, { pattern: "0 0 1 1 *" }, { name: id });
    }
    await removeObsoleteSchedulers(q);
    const left = (await q.getJobSchedulers()).map((s) => s.key);
    expect(left).toEqual(["watch-renewal"]);
    await q.obliterate({ force: true });
    await q.close();
  });
});
