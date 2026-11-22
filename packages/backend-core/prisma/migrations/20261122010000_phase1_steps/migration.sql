CREATE TABLE "AgentStep" (
    "seq" BIGSERIAL PRIMARY KEY,
    "runId" TEXT NOT NULL REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AgentStep_runId_seq_idx" ON "AgentStep"("runId", "seq");
