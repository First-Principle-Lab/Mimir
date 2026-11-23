CREATE TABLE "AgentDefinition" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "tools" JSONB NOT NULL,
  "modelRole" TEXT NOT NULL DEFAULT 'subagent',
  "memoryScope" TEXT NOT NULL DEFAULT 'conversation',
  "canSpawn" BOOLEAN NOT NULL DEFAULT false,
  "maxSteps" INTEGER NOT NULL,
  "maxUsd" DOUBLE PRECISION NOT NULL,
  "timeoutSec" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentDefinition_userId_name_key" ON "AgentDefinition"("userId", "name");

ALTER TABLE "AgentRun" ADD COLUMN "parentRunId" TEXT,
  ADD COLUMN "rootRunId" TEXT,
  ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "definitionId" TEXT,
  ADD COLUMN "brief" JSONB,
  ADD COLUMN "result" JSONB,
  ADD COLUMN "budgetUsd" DOUBLE PRECISION;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_definitionId_fkey"
  FOREIGN KEY ("definitionId") REFERENCES "AgentDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");
CREATE INDEX "AgentRun_rootRunId_idx" ON "AgentRun"("rootRunId");
CREATE INDEX "AgentRun_userId_trigger_status_idx" ON "AgentRun"("userId", "trigger", "status");

CREATE TABLE "AgentMessage" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentMessage_runId_consumedAt_idx" ON "AgentMessage"("runId", "consumedAt");
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Built-in definitions. Users get their own rows later (named bots).
INSERT INTO "AgentDefinition" ("id", "userId", "name", "description", "prompt", "tools", "canSpawn", "maxSteps", "maxUsd", "timeoutSec") VALUES
  ('builtin-researcher', NULL, 'researcher',
   'Background worker for multi-step lookups across connected accounts, remembered facts and the web. Can split independent reads across focused helpers. Returns a summary and proposed actions.',
   'Work through the brief with the read tools. Hand listed items, and independent parts that need several steps each, to focused helpers with delegate, and combine their reports into one summary. Do single lookups yourself, in parallel when they are independent.',
   '["*"]', true, 24, 0.2, 600),
  ('builtin-reader', NULL, 'reader',
   'Focused leaf worker for one lookup or one item of a fan-out. Cannot delegate.',
   'Do exactly the one lookup in the brief and report what you found. Keep it short.',
   '["*"]', false, 12, 0.05, 240);
