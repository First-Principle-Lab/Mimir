import { randomBytes, randomUUID } from "node:crypto";
import { getConfig, getLogger, getPrismaClient, type InputJsonValue } from "@mimir/backend-core";
import { GMAIL_INTEGRATION, GOOGLE_CALENDAR_INTEGRATION, composioProvider, gmailProvider } from "@mimir/connection-provider";
import type { RequestFn } from "../http-rpc.js";
import { registerGmailWatch, type GmailTransport } from "./gmail.js";
import { registerCalendarWatch } from "../calendar/calendar-watch.js";

// 6.2.2 — Watch subscriptions expire (~7 days); this daily sweep re-registers
// watch() for every connected user so push keeps flowing.
//   Gmail: watch() is idempotent (re-registering returns the same watch), so no
//     expiry bookkeeping is needed — the sweep just refreshes on cadence.
//     Requires GOOGLE_PUBSUB_TOPIC.
//   Calendar: channels carry a {token, channelId, expiration}; re-register only
//     when the stored channel is missing or inside the renewal window. The token
//     persists across renewal (a straggler push from the old channel still
//     carries a token we issued), but verification keys on channelId, so those
//     pushes 401 — the 1-min poll covers anything a 401'd push would have
//     surfaced. Stops the superseded channel best-effort (it would expire anyway).
const prisma = getPrismaClient();

// Calendar channels expire ~7 days; renew once inside the final day.
const CALENDAR_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WatchRenewDeps {
  topic?: string;
  // Override the per-user Gmail transport (test seam). Defaults to the provider's
  // apiRequest — the same transport the read/send paths use.
  request?: (userId: string) => GmailTransport;
  // Override the per-user Google Calendar transport (test seam).
  calendarRequest?: (userId: string) => RequestFn;
  // The public watch address pushed to Google for calendar channels.
  address?: string;
  // Test seam for the near-expiry check; defaults to Date.now().
  now?: number;
}

export async function runWatchRenewal(deps: WatchRenewDeps = {}): Promise<number> {
  const cfg = getConfig();
  const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
  const address = deps.address ?? (webBase ? `${webBase}/webhooks/calendar` : "");
  const now = deps.now ?? Date.now();
  let renewed = 0;

  const topic = deps.topic ?? cfg.GOOGLE_PUBSUB_TOPIC;
  if (topic) {
    const provider = gmailProvider(cfg, prisma.integrationConnection, `${webBase}/api/v1/integrations/gmail/callback`);
    const request = deps.request ?? ((userId: string): GmailTransport => (path, opts) => provider.apiRequest(userId, path, opts));
    renewed += await renewGmail(request, topic);
  } else {
    getLogger().warn("gmail watch renewal skipped: GOOGLE_PUBSUB_TOPIC not configured");
  }

  if (address) {
    const provider = composioProvider(GOOGLE_CALENDAR_INTEGRATION, cfg, prisma.integrationConnection, `${webBase || "http://localhost"}/api/v1/integrations/googlecalendar/callback`);
    const request = deps.calendarRequest ?? ((userId: string): RequestFn => (path, opts) => provider.apiRequest(userId, path, opts));
    renewed += await renewCalendars(request, address, now);
  } else {
    getLogger().warn("calendar watch renewal skipped: neither PUBLIC_API_URL nor WEB_APP_URL configured");
  }

  return renewed;
}

async function renewGmail(request: (userId: string) => GmailTransport, topic: string): Promise<number> {
  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GMAIL_INTEGRATION, status: "connected" },
    select: { userId: true },
  });

  let renewed = 0;
  for (const { userId } of connections) {
    try {
      await registerGmailWatch(request(userId), topic);
      renewed += 1;
      getLogger().info({ userId }, "gmail watch re-registered");
    } catch (e) {
      // Missing/expired connection or a transient Gmail/cloud error — log and
      // move on; the sweep retries next run.
      getLogger().info({ err: e, userId }, "gmail watch renewal failed for user; continuing");
    }
  }
  return renewed;
}

interface CalendarWebhookMeta {
  token?: string;
  channelId?: string;
  resourceId?: string;
  expiration?: number;
}

async function renewCalendars(request: (userId: string) => RequestFn, address: string, now: number): Promise<number> {
  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GOOGLE_CALENDAR_INTEGRATION, status: "connected" },
    select: { id: true, userId: true, webhookMeta: true },
  });

  let renewed = 0;
  for (const conn of connections) {
    try {
      const meta = (conn.webhookMeta ?? {}) as CalendarWebhookMeta;
      // A channel is healthy only if one exists and is well inside its window.
      const expiresSoon = meta.expiration == null || meta.expiration - now < CALENDAR_RENEW_WINDOW_MS;
      if (meta.channelId && !expiresSoon) continue;
      const token = meta.token ?? `cal-${randomBytes(24).toString("hex")}`;
      const channelId = randomUUID();
      const channel = await registerCalendarWatch(request(conn.userId), { address, channelId, token });
      // Merge onto the existing blob so future webhookMeta fields survive renewal.
      const next: CalendarWebhookMeta = {
        ...((conn.webhookMeta ?? {}) as CalendarWebhookMeta),
        token,
        channelId,
        expiration: channel.expiration,
        resourceId: channel.resourceId,
      };
      await prisma.integrationConnection.update({
        where: { id: conn.id },
        data: { webhookMeta: next as unknown as InputJsonValue },
      });
      // Stop the superseded channel best-effort. A straggler push from it 401s
      // (verification in /webhooks/calendar keys on the stored channelId) and is
      // covered by the 1-min calendar poll instead of the expired channel.
      if (meta.channelId && meta.resourceId) {
        await request(conn.userId)("/channels/stop", {
          method: "POST",
          body: { id: meta.channelId, resourceId: meta.resourceId },
        }).catch(() => {});
      }
      renewed += 1;
      getLogger().info({ userId: conn.userId }, "calendar watch channel (re)registered");
    } catch (e) {
      getLogger().info({ err: e, userId: conn.userId }, "calendar watch renewal failed for user; continuing");
    }
  }
  return renewed;
}