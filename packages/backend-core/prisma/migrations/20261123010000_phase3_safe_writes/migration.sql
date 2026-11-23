ALTER TABLE "ActionAttempt" ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "arguments" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "finishedAt" TIMESTAMP(3);
UPDATE "ActionAttempt" SET "idempotencyKey" = 'legacy:' || "id";
ALTER TABLE "ActionAttempt" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "ActionAttempt_idempotencyKey_key" ON "ActionAttempt"("idempotencyKey");
CREATE TABLE "ActionApproval" (
  "id" TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "toolCallId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "arguments" JSONB NOT NULL,
  "argumentHash" TEXT NOT NULL,
  "risk" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ActionApproval_runId_toolCallId_key" ON "ActionApproval"("runId", "toolCallId");
CREATE INDEX "ActionApproval_status_expiresAt_idx" ON "ActionApproval"("status", "expiresAt");
CREATE TABLE "EmailDraft" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "EmailDraft_userId_conversationId_idx" ON "EmailDraft"("userId", "conversationId");
