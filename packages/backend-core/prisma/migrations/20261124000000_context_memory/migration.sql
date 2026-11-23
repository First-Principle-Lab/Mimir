ALTER TABLE "ExtractedFact" ADD COLUMN "memoryScope" TEXT NOT NULL DEFAULT 'conversation', ADD COLUMN "memoryAgentId" TEXT;
CREATE INDEX "ExtractedFact_userId_memoryScope_memoryAgentId_idx" ON "ExtractedFact"("userId", "memoryScope", "memoryAgentId");
CREATE TABLE "ToolArtifact" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "trust" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ToolArtifact_conversationId_createdAt_idx" ON "ToolArtifact"("conversationId", "createdAt");
