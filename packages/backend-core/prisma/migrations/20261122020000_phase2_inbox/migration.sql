-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notificationPreferences" JSONB;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "replyToMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "inboxInputId" TEXT;

-- CreateTable
CREATE TABLE "InboxInput" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "runId" TEXT,
    "replyMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "InboxInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "ambient" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryReceipt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "timing" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineObservation" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutineObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineScratch" (
    "routineId" TEXT NOT NULL,
    "fingerprint" TEXT,
    "checkedAt" TIMESTAMP(3),
    "lastToldKey" TEXT,
    "notes" JSONB,

    CONSTRAINT "RoutineScratch_pkey" PRIMARY KEY ("routineId")
);

-- CreateTable
CREATE TABLE "ActionAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxInput_seq_key" ON "InboxInput"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "InboxInput_messageId_key" ON "InboxInput"("messageId");

-- CreateIndex
CREATE INDEX "InboxInput_conversationId_status_seq_idx" ON "InboxInput"("conversationId", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "InboxInput_conversationId_dedupeKey_key" ON "InboxInput"("conversationId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_messageId_key" ON "Delivery"("messageId");

-- CreateIndex
CREATE INDEX "Delivery_status_availableAt_idx" ON "Delivery"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReceipt_deliveryId_channel_key" ON "DeliveryReceipt"("deliveryId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "RoutineObservation_routineId_key_key" ON "RoutineObservation"("routineId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ActionAttempt_runId_toolCallId_key" ON "ActionAttempt"("runId", "toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_inboxInputId_key" ON "AgentRun"("inboxInputId");

-- AddForeignKey
ALTER TABLE "InboxInput" ADD CONSTRAINT "InboxInput_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReceipt" ADD CONSTRAINT "DeliveryReceipt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineObservation" ADD CONSTRAINT "RoutineObservation_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineScratch" ADD CONSTRAINT "RoutineScratch_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

