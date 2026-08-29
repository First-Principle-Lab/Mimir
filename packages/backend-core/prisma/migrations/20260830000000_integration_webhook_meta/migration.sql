-- Inbound-webhook state for Calendar/GitHub connections, stored on the existing
-- IntegrationConnection row (no parallel table): googlecalendar keeps its watch
-- channel {token, channelId, expiration}; github keeps its registered repo hook
-- ids {hooks: [{repo, id, url}]}. Nullable — absent for providers that don't use
-- push (gmail/notion/etc) and for yet-unregistered connections.
ALTER TABLE "IntegrationConnection" ADD COLUMN "webhookMeta" JSONB;