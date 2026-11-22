-- Phase 1 (pi harness): drop the old classifier/agent pipeline's tables and add
-- the pi session journal (SessionEntry) and per-run records (AgentRun).
-- Destructive on purpose: agents, triggers, plans, reflections, surfaced-mail
-- dedup and narrative summaries belong to the deleted agent logic.

-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentEvent" DROP CONSTRAINT "AgentEvent_agentId_fkey";

-- DropForeignKey
ALTER TABLE "ConversationSummary" DROP CONSTRAINT "ConversationSummary_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Plan" DROP CONSTRAINT "Plan_agentId_fkey";

-- DropForeignKey
ALTER TABLE "ReflectionEvent" DROP CONSTRAINT "ReflectionEvent_agentId_fkey";

-- DropForeignKey
ALTER TABLE "SurfacedMail" DROP CONSTRAINT "SurfacedMail_userId_fkey";

-- DropForeignKey
ALTER TABLE "Trigger" DROP CONSTRAINT "Trigger_agentId_fkey";

-- DropTable
DROP TABLE "Agent";

-- DropTable
DROP TABLE "AgentEvent";

-- DropTable
DROP TABLE "ConversationSummary";

-- DropTable
DROP TABLE "Plan";

-- DropTable
DROP TABLE "ReflectionEvent";

-- DropTable
DROP TABLE "SurfacedMail";

-- DropTable
DROP TABLE "Trigger";

-- DropEnum
DROP TYPE "AgentComplexity";

-- DropEnum
DROP TYPE "AgentStatus";

-- CreateTable
CREATE TABLE "SessionEntry" (
    "seq" BIGSERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "parentEntryId" TEXT,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "SessionEntry_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "inputMessageId" TEXT,
    "replyMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "model" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionEntry_conversationId_seq_idx" ON "SessionEntry"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SessionEntry_conversationId_entryId_key" ON "SessionEntry"("conversationId", "entryId");

-- CreateIndex
CREATE INDEX "AgentRun_conversationId_startedAt_idx" ON "AgentRun"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_inputMessageId_key" ON "AgentRun"("inputMessageId");

-- AddForeignKey
ALTER TABLE "SessionEntry" ADD CONSTRAINT "SessionEntry_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
