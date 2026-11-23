ALTER TABLE "EmailDraft" ADD CONSTRAINT "EmailDraft_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
