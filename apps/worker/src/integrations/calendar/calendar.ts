import { getConfig, getPrismaClient } from "@mimir/backend-core";
import {
  ConnectionError,
  ProviderError,
  GOOGLE_CALENDAR_INTEGRATION,
  composioProvider,
} from "@mimir/connection-provider";
import { ToolError, type Task } from "@mimir/tasks";
import { z } from "zod";
import { rpc, type RequestFn } from "../http-rpc.js";

const prisma = getPrismaClient();

// Google Calendar read tasks (5.6), read-only: list + get events on the user's
// connected Calendar. Writes (create/update/delete) are deliberately not exposed
// yet — they need the user-confirmation gate before they land on someone's
// calendar, same principle as the email draft-confirm flow. Routes through the
// shared Composio proxyExecute transport (apiRequest), so no token ever touches
// this app.

export interface CalendarEvent {
  id: string;
  summary: string;
  location?: string;
  start?: string;
  end?: string;
  htmlLink?: string;
  // updatedAt: event revision stamp (RFC3339) — the monitor's change cursor.
  // status: "confirmed" | "tentative" | "cancelled" — cancellation is a distinct
  // event worth surfacing, surfaced via the poll like any other change.
  updatedAt?: string;
  status?: string;
  organizer?: string;
  attendees?: string[];
}

interface RawCalendarEvent {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
  updated?: string;
  status?: string;
  organizer?: { email?: string; self?: boolean };
  attendees?: { email?: string; self?: boolean }[];
}

function flattenEvent(e: RawCalendarEvent): CalendarEvent {
  return {
    id: e.id ?? "",
    summary: e.summary ?? "",
    ...(e.location ? { location: e.location } : {}),
    // start/end are either {dateTime} or {date} (timed vs all-day); flatten
    // to whichever string the API gave us.
    ...(e.start ? { start: e.start.dateTime ?? e.start.date ?? "" } : {}),
    ...(e.end ? { end: e.end.dateTime ?? e.end.date ?? "" } : {}),
    ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
    ...(e.updated ? { updatedAt: e.updated } : {}),
    ...(e.status ? { status: e.status } : {}),
    // organizer/attendees are only meaningful for the monitor's change-triaging
    // (who added/changed this, do I need to respond) — pass through raw.
    ...(e.organizer?.email ? { organizer: e.organizer.email } : {}),
    ...(e.attendees?.length
      ? { attendees: e.attendees.map((a) => a.email ?? "").filter(Boolean) }
      : {}),
  };
}

// Split from the task so the REST layer is unit-testable with a fake transport.
// The Composio googlecalendar proxy strips the /calendar/v3 prefix, so endpoint
// paths here start at /calendars... (verified live): /users/me/calendarList and
// /calendars/{id}/events both return 200.
export async function fetchCalendarEvents(
  request: RequestFn,
  opts: {
    calendarId?: string;
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
    updatedMin?: string;
  },
): Promise<CalendarEvent[]> {
  const calendarId = opts.calendarId?.trim() || "primary";
  const events = await rpc<{ items?: RawCalendarEvent[] }>(
    request,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      query: {
        ...(opts.timeMin ? { timeMin: opts.timeMin } : {}),
        ...(opts.timeMax ? { timeMax: opts.timeMax } : {}),
        ...(opts.updatedMin ? { updatedMin: opts.updatedMin } : {}),
        singleEvents: "true",
        // The monitor's updatedMin scans want the most-recently-changed events
        // first (a >maxResults change burst keeps the freshest); the interactive
        // list tool wants calendar order (startTime).
        orderBy: opts.updatedMin ? "updated" : "startTime",
        maxResults: opts.maxResults ?? 10,
      },
    },
  );
  return (events.items ?? []).map(flattenEvent);
}

export async function fetchCalendarEvent(
  request: RequestFn,
  eventId: string,
  calendarId?: string,
): Promise<CalendarEvent> {
  const id = calendarId?.trim() || "primary";
  const event = await rpc<RawCalendarEvent>(
    request,
    `/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}`,
  );
  return flattenEvent(event);
}

export function calendarListEventsTask(): Task {
  return {
    kind: "task",
    name: "calendar_list_events",
    description:
      "List events on the user's connected Google Calendar, optionally within a time window. Returns event summaries with start/end times. Use this to answer what's scheduled and when there is headroom; events are read-only.",
    inputSchema: z.object({
      calendarId: z
        .string()
        .optional()
        .describe("Calendar id; defaults to the user's primary calendar"),
      timeMin: z
        .string()
        .optional()
        .describe(
          "ISO 8601 start with the user's local UTC offset. For a whole day, use local midnight at its start. Defaults to now",
        ),
      timeMax: z
        .string()
        .optional()
        .describe(
          "Exclusive ISO 8601 end with the user's local UTC offset. For a whole day, use midnight at the start of the NEXT local day, not 23:59:59",
        ),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Max events to return (default 10)"),
    }),
    execute: async (input, ctx) => {
      const { calendarId, timeMin, timeMax, maxResults } = input as {
        calendarId?: string;
        timeMin?: string;
        timeMax?: string;
        maxResults?: number;
      };
      const cfg = getConfig();
      const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
      const provider = composioProvider(
        GOOGLE_CALENDAR_INTEGRATION,
        cfg,
        prisma.integrationConnection,
        `${webBase}/api/v1/integrations/googlecalendar/callback`,
      );
      const request: RequestFn = (path, opts) =>
        provider.apiRequest(ctx.userId, path, opts);
      try {
        const events = await fetchCalendarEvents(request, {
          calendarId,
          timeMin,
          timeMax,
          maxResults,
        });
        return { provider: "googlecalendar", events };
      } catch (e) {
        if (e instanceof ConnectionError)
          throw new ToolError("connection", e.message);
        if (e instanceof ProviderError)
          throw new ToolError("execution", e.message);
        throw e;
      }
    },
  };
}

export function calendarGetEventTask(): Task {
  return {
    kind: "task",
    name: "calendar_get_event",
    description:
      "Fetch a single event's details from the user's connected Google Calendar by its id (e.g. from calendar_list_events).",
    inputSchema: z.object({
      eventId: z.string().describe("The Google Calendar event id"),
      calendarId: z
        .string()
        .optional()
        .describe("Calendar id; defaults to the user's primary calendar"),
    }),
    execute: async (input, ctx) => {
      const { eventId, calendarId } = input as {
        eventId: string;
        calendarId?: string;
      };
      if (!eventId?.trim())
        throw new ToolError(
          "validation",
          "calendar_get_event requires an eventId",
        );
      const cfg = getConfig();
      const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
      const provider = composioProvider(
        GOOGLE_CALENDAR_INTEGRATION,
        cfg,
        prisma.integrationConnection,
        `${webBase}/api/v1/integrations/googlecalendar/callback`,
      );
      const request: RequestFn = (path, opts) =>
        provider.apiRequest(ctx.userId, path, opts);
      try {
        const event = await fetchCalendarEvent(request, eventId, calendarId);
        return { provider: "googlecalendar", event };
      } catch (e) {
        if (e instanceof ConnectionError)
          throw new ToolError("connection", e.message);
        if (e instanceof ProviderError)
          throw new ToolError("execution", e.message);
        throw e;
      }
    },
  };
}
