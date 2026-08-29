import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError, GOOGLE_CALENDAR_INTEGRATION, composioProvider } from "@mimir/connection-provider";
import type { Redis } from "ioredis";
import { triageVerdict, type TriageVerdict } from "../../agent/triage.js";
import { ownerConversation } from "../../infra/mail-poll.js";
import { newMessagePayload, publishUserEvent, redis } from "../../infra/redis.js";
import type { RequestFn } from "../http-rpc.js";
import { fetchCalendarEvents, type CalendarEvent } from "./calendar.js";

const prisma = getPrismaClient();

// The Calendar monitor: a fixed-cadence sweep over every connected calendar that
// surfaces new/changed/cancelled events and invites the triage judge deems worth
// seeing — the same detect -> judge -> surface-into-thread shape as
// pollImportantMail and the github monitor (github-poll.ts). updatedMin window
// covers the cadence gap so no change is missed between ticks; the webhook push
// (calendar-watch) is a parallel fast path, and both feed the same Redis dedup.

const SURFACED_KEY = (userId: string) => `cal-surfaced:${userId}`;
// A "noise" verdict is held in a short-TTL set and re-judged after
// CAL_NOISE_TTL_SECONDS instead of one triage call per event per sweep forever —
// same semantics as the github monitor's noise cooldown.
const NOISE_KEY = (userId: string) => `cal-noise:${userId}`;
const CAL_NOISE_TTL_SECONDS = 24 * 60 * 60;

// How far back updatedMin reaches each tick. Must comfortably exceed the poll
// cadence so a delayed tick still sees everything; 60 min costs one API call per
// user per tick and only events changed INSIDE the window are returned.
// ponytail: single fixed window + maxResults cap (no cursor) — a burst of >50
// changed events in an hour returns only the 50 freshest (orderBy: updated) and
// the rest age out of the window unseened. That's a bulk-import-shaped edge
// only; pageToken paging or a per-user updatedMin cursor is the upgrade if it
// ever matters. Redis-only dedup additionally re-surfaces once on a flush; a
// Postgres claim row (like SurfacedMail) is the upgrade.
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const MAX_EVENTS = 50;

function defaultRequestFor(userId: string): RequestFn {
  const cfg = getConfig();
  const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
  const provider = composioProvider(GOOGLE_CALENDAR_INTEGRATION, cfg, prisma.integrationConnection, `${webBase}/api/v1/integrations/googlecalendar/callback`);
  return (path, opts) => provider.apiRequest(userId, path, opts);
}

function renderEvent(e: CalendarEvent): string {
  const head = [`${e.summary || "(untitled event)"}`, e.status ? `Status: ${e.status}` : ""].filter(Boolean);
  if (e.start) head.push(`Start: ${e.start}`);
  if (e.end) head.push(`End: ${e.end}`);
  if (e.location) head.push(`Location: ${e.location}`);
  if (e.organizer) head.push(`Organizer: ${e.organizer}`);
  if (e.attendees?.length) head.push(`Attendees: ${e.attendees.join(", ")}`);
  head.push(`Updated: ${e.updatedAt ?? "?"}`);
  return head.join("\n");
}

async function isNoiseCooldown(cache: Redis, userId: string, key: string): Promise<boolean> {
  return (await cache.sismember(NOISE_KEY(userId), key)) === 1;
}

async function markNoise(cache: Redis, userId: string, key: string, ttlSeconds: number): Promise<void> {
  const redisKey = NOISE_KEY(userId);
  await cache.sadd(redisKey, key);
  if ((await cache.ttl(redisKey)) === -1) {
    await cache.expire(redisKey, ttlSeconds);
  }
}

export interface CalendarPollDeps {
  cache?: Redis;
  // The triage judge; tests inject a deterministic one. Production default is
  // triageVerdict with the calendar monitor prompt (kind "googlecalendar").
  judge?: (userId: string, content: string, kind?: string) => Promise<TriageVerdict>;
  publish?: typeof publishUserEvent;
  // The per-user provider transport; tests inject a fake one.
  requestFor?: (userId: string) => RequestFn;
  // Re-judge window for noise verdicts. Injectable for tests; defaults to 24h.
  noiseTtlSeconds?: number;
  // updatedMin lookback window in ms. Injectable for tests; defaults to 60 min.
  windowMs?: number;
  // Test seam for the window boundary; defaults to Date.now().
  now?: number;
}

// Sweep all connected calendars for events changed in the window. Returns the
// number surfaced this tick. Best-effort per user — one user's failure must not
// block the rest of the sweep.
export async function pollCalendarActivity(deps: CalendarPollDeps = {}): Promise<number> {
  const cache = deps.cache ?? redis;
  const judge = deps.judge ?? triageVerdict;
  const publish = deps.publish ?? publishUserEvent;
  const requestFor = deps.requestFor ?? defaultRequestFor;
  const noiseTtlSeconds = deps.noiseTtlSeconds ?? CAL_NOISE_TTL_SECONDS;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? Date.now();

  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GOOGLE_CALENDAR_INTEGRATION, status: "connected" },
    select: { userId: true },
  });
  if (connections.length === 0) return 0;

  let surfaced = 0;
  for (const { userId } of connections) {
    try {
      const request = requestFor(userId);
      const events = await fetchCalendarEvents(request, {
        updatedMin: new Date(now - windowMs).toISOString(),
        maxResults: MAX_EVENTS,
      });
      for (const event of events) {
        // Key on event id + revision stamp so a changed event is re-judged once
        // (new updatedAt) but an unchanged re-poll is a skip.
        const key = `${event.id}:${event.updatedAt ?? ""}`;
        if (await cache.sismember(SURFACED_KEY(userId), key)) continue;
        if (await isNoiseCooldown(cache, userId, key)) continue;
        const verdict = await judge(userId, renderEvent(event), "googlecalendar");
        // A judge failure (error flag) is NOT a verdict: don't claim the event
        // so the next sweep retries it instead of permanently dropping it.
        if (verdict.error) continue;
        if (!verdict.surface) {
          await markNoise(cache, userId, key, noiseTtlSeconds);
          continue;
        }
        const conversationId = await ownerConversation(userId);
        const message = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: `Calendar: ${renderEvent(event)}\n\n${verdict.rationale ?? ""}`.trim(),
            status: "complete",
          },
        });
        surfaced += 1;
        getLogger().info({ userId, eventId: event.id, category: verdict.category }, "calendar event surfaced");
        try {
          await publish(userId, "new_message", newMessagePayload(conversationId, message));
        } catch (publishErr) {
          getLogger().error({ err: publishErr, userId }, "calendar publish failed (message already written)");
        }
        // Claim AFTER the durable write: if message.create fails (transient
        // DB error), the event stays unclaimed and is retried next sweep.
        await cache.sadd(SURFACED_KEY(userId), key);
      }
    } catch (e) {
      getLogger().error({ err: e, userId }, "calendar poll failed for user; continuing sweep");
      // A dead connection must flip the local row so the UI stops claiming
      // "connected" — mirrors the mail/github poll fail-fast flip.
      if (e instanceof ConnectionError) {
        await prisma.integrationConnection.updateMany({
          where: { userId, provider: GOOGLE_CALENDAR_INTEGRATION },
          data: { status: "expired" },
        });
        getLogger().info({ userId }, "calendar connection marked expired from poll failure");
      }
    }
  }
  return surfaced;
}