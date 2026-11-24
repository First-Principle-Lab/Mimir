import { getConfig, getLogger, version } from "@mimir/backend-core";
import {
  removeObsoleteSchedulers,
  scheduleConnectionCanary,
  scheduleFactExtractionSweep,
  scheduleGithubHookSweep,
  scheduleWatchRenewal,
  scheduleHarnessRecovery,
  startWorkers,
} from "./infra/queues.js";
import { startOutboxRelay } from "./infra/outbox-relay.js";
import { startRoutineWebhooks } from "./routines/webhooks.js";

getConfig();
const workers = startWorkers();
const stopRelay = startOutboxRelay();
const stopWebhooks = startRoutineWebhooks();
void scheduleHarnessRecovery().catch((e) =>
  getLogger().error({ err: e }, "failed to schedule harness recovery"),
);
void removeObsoleteSchedulers().catch((e) =>
  getLogger().error({ err: e }, "failed to remove obsolete schedulers"),
);
void scheduleGithubHookSweep().catch((e) =>
  getLogger().error({ err: e }, "failed to schedule github hook sweep"),
);
void scheduleWatchRenewal().catch((e) =>
  getLogger().error({ err: e }, "failed to schedule watch renewal"),
);
void scheduleConnectionCanary().catch((e) =>
  getLogger().error({ err: e }, "failed to schedule connection canary"),
);
void scheduleFactExtractionSweep().catch((e) =>
  getLogger().error({ err: e }, "failed to schedule fact extraction sweep"),
);

getLogger().info({ version }, "@mimir/worker ready");

// Render sends SIGTERM before replacing the worker. Stop taking jobs and let
// running ones finish; anything still running at the deadline is stalled and
// retried by another worker (turn and agent journals make retries safe).
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    getLogger().info({ signal }, "worker shutting down");
    stopRelay();
    stopWebhooks();
    void Promise.all(workers.map((w) => w.close()))
      .catch((err) => getLogger().error({ err }, "worker shutdown failed"))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 25_000).unref();
  });
