import {
  callOpenRouter,
  getConfig,
  getLogger,
  getPrismaClient,
  loadPrompt,
  trackModelCall,
} from "@mimir/backend-core";
import { GOOGLE_CALENDAR_INTEGRATION, composioProvider } from "@mimir/connection-provider";
import type { LlmMessage } from "@mimir/shared-types";
import { rpc, type RequestFn } from "../../../worker/src/integrations/http-rpc.js";

const prisma = getPrismaClient();

// Calendar event-creation gate (mirror of the email draft-confirm flow):
// nothing is written to the user's calendar until they confirm the proposed
// event in chat. The proposal is carried on the confirmation Message's
// toolCalls column — no schema change; the Message history is the audit trail.
export const CALENDAR_ACTION_TYPE = "googlecalendar.create_event";
export const CALENDAR_HINT_RE = /calendar|event|meeting|appointment|schedule|book (a|the|something)|invite|block (.* )?(off )?(on|for)/i;
export const CALENDAR_SUMMARY_MAX = 200;
export const CALENDAR_DESC_MAX = 20000;
// Cheap gate so the extra LLM call only runs on plausibly-calendar messages.
export function calendarActionHint(content: string): boolean {
  return CALENDAR_HINT_RE.test(content);
}

export interface CalendarEventDraft {
  summary: string;
  start: string; // ISO 8601 (dateTime)
  end: string;
  description?: string;
  location?: string;
}

export type CalendarActionProposal =
  | { intent: "create_event"; event: CalendarEventDraft }
  | { intent: "none" };

export type CalendarResolveIntent = "confirm" | "cancel" | "ambiguous" | "unrelated" | "edit";
export interface CalendarResolveResult {
  intent: CalendarResolveIntent;
  event?: CalendarEventDraft;
}

export interface PendingCalendarAction {
  messageId: string;
  event: CalendarEventDraft;
}

// Real connection state, not just "a row exists": heal a missing local row via
// the Composio sync probe first (same as the gmail/email connection check).
export function calendarProvider() {
  const cfg = getConfig();
  return composioProvider(
    GOOGLE_CALENDAR_INTEGRATION,
    cfg,
    prisma.integrationConnection,
    `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/googlecalendar/callback`,
  );
}

export async function isCalendarConnected(userId: string): Promise<boolean> {
  const provider = calendarProvider();
  let connection = await provider.getConnection(userId);
  if (!connection) {
    try {
      await provider.syncConnection(userId);
    } catch (e) {
      getLogger().warn({ err: e, userId }, "calendar reconciliation failed");
    }
    connection = await provider.getConnection(userId);
  }
  return connection != null && connection.status !== "expired";
}

export async function findPendingCalendarAction(conversationId: string): Promise<PendingCalendarAction | null> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "assistant", status: "complete" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const row of rows) {
    const t = row.toolCalls as { type?: string; status?: string; event?: CalendarEventDraft } | null;
    if (t && t.type === CALENDAR_ACTION_TYPE && t.status === "pending" && t.event) {
      return { messageId: row.id, event: t.event };
    }
  }
  return null;
}

export async function markCalendarAction(messageId: string, status: "executed" | "cancelled", extra: Record<string, unknown> = {}): Promise<void> {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { toolCalls: true } });
  const t = (row?.toolCalls ?? {}) as Record<string, unknown>;
  await prisma.message.update({ where: { id: messageId }, data: { toolCalls: { ...t, status, ...extra } } });
}

// A new proposal supersedes any older pending one in the same conversation.
export async function cancelPendingCalendarActions(conversationId: string): Promise<void> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "assistant", status: "complete" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const row of rows) {
    const t = row.toolCalls as { type?: string; status?: string } | null;
    if (t && t.type === CALENDAR_ACTION_TYPE && t.status === "pending") {
      await markCalendarAction(row.id, "cancelled");
    }
  }
}

const PROPOSE_SYSTEM = loadPrompt("calendar_propose.md");

export async function proposeCalendarAction(
  userId: string,
  history: LlmMessage[],
  connected: "connected" | "not_connected" = "connected",
): Promise<CalendarActionProposal> {
  let result;
  try {
    result = await callOpenRouter(
      [
        { role: "system", content: PROPOSE_SYSTEM },
        { role: "system", content: `User's Google Calendar connection status: ${connected}.` },
        ...history,
      ],
      { useCase: "calendar_proposal" },
    );
  } catch (e) {
    getLogger().error({ err: e }, "calendar proposal call failed; continuing without calendar action");
    await trackModelCall({ userId, useCase: "calendar_proposal", error: (e as Error)?.message ?? String(e) });
    return { intent: "none" };
  }
  await trackModelCall({ userId, useCase: "calendar_proposal", result });
  return parseCalendarAction(result.content);
}

export function parseCalendarAction(raw: string): CalendarActionProposal {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
      intent?: unknown;
      summary?: unknown;
      start?: unknown;
      end?: unknown;
      description?: unknown;
      location?: unknown;
    };
    if (json.intent !== "create_event") return { intent: "none" };
    const event: CalendarEventDraft = {
      summary: typeof json.summary === "string" ? json.summary.trim() : "",
      start: typeof json.start === "string" ? json.start.trim() : "",
      end: typeof json.end === "string" ? json.end.trim() : "",
      ...(typeof json.description === "string" && json.description ? { description: json.description } : {}),
      ...(typeof json.location === "string" && json.location ? { location: json.location } : {}),
    };
    return { intent: "create_event", event };
  } catch {
    return { intent: "none" };
  }
}

const RESOLVE_SYSTEM = (event: CalendarEventDraft) =>
  loadPrompt("calendar_resolve.md")
    .replaceAll("{summary}", event.summary)
    .replaceAll("{start}", event.start)
    .replaceAll("{end}", event.end)
    .replaceAll("{description}", event.description ?? "")
    .replaceAll("{location}", event.location ?? "");

export async function resolvePendingCalendarAction(
  userId: string,
  content: string,
  event: CalendarEventDraft,
): Promise<CalendarResolveResult> {
  let result;
  try {
    result = await callOpenRouter(
      [
        { role: "system", content: RESOLVE_SYSTEM(event) },
        { role: "user", content },
      ],
      { useCase: "calendar_resolve" },
    );
  } catch (e) {
    getLogger().warn({ err: e }, "calendar resolve call failed; treating as ambiguous");
    await trackModelCall({ userId, useCase: "calendar_resolve", error: (e as Error)?.message ?? String(e) });
    return { intent: "ambiguous" };
  }
  await trackModelCall({ userId, useCase: "calendar_resolve", result });
  return parseCalendarResolve(result.content, event);
}

export function parseCalendarResolve(raw: string, fallback: CalendarEventDraft): CalendarResolveResult {
  try {
    const json = JSON.parse(raw.replace(/```json|```/g, "").trim()) as {
      intent?: unknown;
      summary?: unknown;
      start?: unknown;
      end?: unknown;
      description?: unknown;
      location?: unknown;
    };
    const intent = json.intent;
    if (intent === "confirm" || intent === "cancel" || intent === "unrelated") return { intent };
    if (intent === "edit") {
      return {
        intent: "edit",
        event: {
          summary: typeof json.summary === "string" && json.summary.trim() ? json.summary.trim() : fallback.summary,
          start: typeof json.start === "string" ? json.start.trim() : fallback.start,
          end: typeof json.end === "string" ? json.end.trim() : fallback.end,
          ...(typeof json.description === "string" && json.description
            ? { description: json.description.trim() }
            : fallback.description
              ? { description: fallback.description }
              : {}),
          ...(typeof json.location === "string" && json.location
            ? { location: json.location.trim() }
            : fallback.location
              ? { location: fallback.location }
              : {}),
        },
      };
    }
    return { intent: "ambiguous" };
  } catch {
    return { intent: "ambiguous" };
  }
}

// The actual write — only ever called after the user confirms.
export async function createCalendarEvent(userId: string, event: CalendarEventDraft): Promise<{ id: string; htmlLink?: string }> {
  const provider = calendarProvider();
  const request: RequestFn = (path, opts) => provider.apiRequest(userId, path, opts);
  const created = await rpc<{ id?: string; htmlLink?: string }>(request, "/calendars/primary/events", {
    method: "POST",
    body: {
      summary: event.summary,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      ...(event.description ? { description: event.description } : {}),
      ...(event.location ? { location: event.location } : {}),
    },
  });
  if (!created.id) throw new Error("calendar event creation returned no id");
  return { id: created.id, htmlLink: created.htmlLink };
}

// Same fail-fast handling as gmail: an expired token flips the connection row
// so the UI offers reconnect. The pending action is kept so the user can
// confirm again after reconnecting.
export async function markCalendarExpired(userId: string): Promise<void> {
  await prisma.integrationConnection.updateMany({
    where: { userId, provider: GOOGLE_CALENDAR_INTEGRATION },
    data: { status: "expired" },
  });
}

// Human-readable proposal block for the confirmation message. start/end are
// posted to Google as-is (naive local wall-clock ISO, interpreted by the
// calendar's own timezone), so the display formats those SAME components back
// out — the shown time can never drift from what will actually be created.
function isoParts(iso: string): { y: number; mo: number; d: number; h: number; mi: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]! };
}

function formatWhen(start: string, end: string): string {
  const s = isoParts(start);
  if (!s) return `When: ${start || "?"}`;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })
    .format(new Date(Date.UTC(s.y, s.mo - 1, s.d)));
  const time = (p: typeof s) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })
      .format(new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)));
  const t1 = time(s);
  const e = isoParts(end);
  return `${t1}${e ? ` – ${time(e)}` : ""} · ${date}`;
}

export function renderCalendarEvent(e: CalendarEventDraft): string {
  const lines = [e.summary];
  if (e.start) lines.push(`When: ${formatWhen(e.start, e.end)}`);
  if (e.location) lines.push(`Where: ${e.location}`);
  if (e.description) lines.push(`Notes: ${e.description}`);
  return lines.join("\n");
}

// Basic sanity gate for the two fields Google Calendar requires. start/end must
// parse as dates; summary must be non-empty.
export function isCalendarEventActionable(e: CalendarEventDraft): boolean {
  return Boolean(
    e.summary.trim() &&
      Number.isFinite(Date.parse(e.start)) &&
      Number.isFinite(Date.parse(e.end)),
  );
}