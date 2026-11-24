-- Phase 6: per-user spend limits, budget-paused agents and row-level security.

-- Exact daily spend per user. ModelCallLog.costCents is rounded per call, so
-- cheap calls would never add up to a limit.
ALTER TABLE "ModelCallLog" ADD COLUMN "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "UsageRecord" ADD COLUMN "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
-- Per-user override of the deployment's daily budget (NULL = default).
ALTER TABLE "User" ADD COLUMN "dailyBudgetUsd" DOUBLE PRECISION;
-- A background agent paused by the hard budget resumes at this time; stale
-- recovery measures from it instead of the original start.
ALTER TABLE "AgentRun" ADD COLUMN "resumeAt" TIMESTAMP(3);

-- Row-level security. The application sets mimir.user_id on every pooled
-- connection it checks out: the authenticated user's id inside a request or a
-- user-bound job, or '' for system work (sweeps, relays, recovery, migrations).
-- With a user set, only that user's rows are visible or writable. This backstops
-- the application's own ownership filters; it is not the only check.
CREATE OR REPLACE FUNCTION mimir_rls_user() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('mimir.user_id', true), '') $$;

DO $$
DECLARE
  t text;
BEGIN
  -- Tables with their own userId column.
  FOREACH t IN ARRAY ARRAY[
    'Conversation', 'ExtractedFact', 'ToolArtifact', 'AgentRun', 'Delivery',
    'Routine', 'EmailDraft', 'McpServer', 'IntegrationConnection',
    'PushSubscription', 'UsageRecord', 'AnalyticsEvent', 'ModelCallLog',
    'RefreshToken'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY mimir_owner ON %I USING (mimir_rls_user() IS NULL OR "userId" = mimir_rls_user()) WITH CHECK (mimir_rls_user() IS NULL OR "userId" = mimir_rls_user())',
      t);
  END LOOP;

  -- Tables owned through their conversation.
  FOREACH t IN ARRAY ARRAY['Message', 'SessionEntry', 'InboxInput'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY mimir_owner ON %I USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = %I."conversationId" AND c."userId" = mimir_rls_user())) WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = %I."conversationId" AND c."userId" = mimir_rls_user()))',
      t, t, t);
  END LOOP;

  -- Tables owned through their run.
  FOREACH t IN ARRAY ARRAY['ActionAttempt', 'ActionApproval', 'AgentMessage', 'AgentStep'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY mimir_owner ON %I USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "AgentRun" r WHERE r.id = %I."runId" AND r."userId" = mimir_rls_user())) WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "AgentRun" r WHERE r.id = %I."runId" AND r."userId" = mimir_rls_user()))',
      t, t, t);
  END LOOP;

  -- Tables owned through their routine.
  FOREACH t IN ARRAY ARRAY['RoutineObservation', 'RoutineScratch'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY mimir_owner ON %I USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Routine" r WHERE r.id = %I."routineId" AND r."userId" = mimir_rls_user())) WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Routine" r WHERE r.id = %I."routineId" AND r."userId" = mimir_rls_user()))',
      t, t, t);
  END LOOP;
END $$;

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY mimir_owner ON "User"
  USING (mimir_rls_user() IS NULL OR id = mimir_rls_user())
  WITH CHECK (mimir_rls_user() IS NULL OR id = mimir_rls_user());

ALTER TABLE "DeliveryReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY mimir_owner ON "DeliveryReceipt"
  USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Delivery" d WHERE d.id = "DeliveryReceipt"."deliveryId" AND d."userId" = mimir_rls_user()))
  WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Delivery" d WHERE d.id = "DeliveryReceipt"."deliveryId" AND d."userId" = mimir_rls_user()));

ALTER TABLE "FactRelation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FactRelation" FORCE ROW LEVEL SECURITY;
CREATE POLICY mimir_owner ON "FactRelation"
  USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "ExtractedFact" f WHERE f.id = "FactRelation"."sourceFactId" AND f."userId" = mimir_rls_user()))
  WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "ExtractedFact" f WHERE f.id = "FactRelation"."sourceFactId" AND f."userId" = mimir_rls_user()));

-- Built-in agent definitions (userId NULL) are readable by every user but
-- writable only by system work.
ALTER TABLE "AgentDefinition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentDefinition" FORCE ROW LEVEL SECURITY;
CREATE POLICY mimir_read ON "AgentDefinition" FOR SELECT
  USING (mimir_rls_user() IS NULL OR "userId" IS NULL OR "userId" = mimir_rls_user());
CREATE POLICY mimir_owner ON "AgentDefinition"
  USING (mimir_rls_user() IS NULL OR "userId" = mimir_rls_user())
  WITH CHECK (mimir_rls_user() IS NULL OR "userId" = mimir_rls_user());

-- A userId must also agree with the conversation's owner: foreign keys alone
-- bypass RLS checks on the referenced row.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ExtractedFact', 'ToolArtifact', 'AgentRun', 'Delivery', 'Routine', 'EmailDraft'] LOOP
    EXECUTE format('CREATE POLICY mimir_conversation_owner ON %I AS RESTRICTIVE USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = %I."conversationId" AND c."userId" = mimir_rls_user())) WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = %I."conversationId" AND c."userId" = mimir_rls_user()))', t, t, t);
  END LOOP;
END $$;
CREATE POLICY mimir_target_owner ON "FactRelation" AS RESTRICTIVE
  USING (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "ExtractedFact" f WHERE f.id = "FactRelation"."targetFactId" AND f."userId" = mimir_rls_user()))
  WITH CHECK (mimir_rls_user() IS NULL OR EXISTS (SELECT 1 FROM "ExtractedFact" f WHERE f.id = "FactRelation"."targetFactId" AND f."userId" = mimir_rls_user()));
