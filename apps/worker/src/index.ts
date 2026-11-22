import { getConfig, getLogger, version } from "@mimir/backend-core";
import {
  removeObsoleteSchedulers,
  scheduleConnectionCanary,
  scheduleFactExtractionSweep,
  scheduleGithubHookSweep,
  scheduleWatchRenewal,
  startWorkers,
} from "./infra/queues.js";
import { startOutboxRelay } from "./infra/outbox-relay.js";

getConfig();
startWorkers();
startOutboxRelay();
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
