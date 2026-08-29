import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "calendar-action-test-secret";

const {
  calendarActionHint,
  isCalendarEventActionable,
  parseCalendarAction,
  parseCalendarResolve,
  renderCalendarEvent,
} = await import("../calendar/calendar-action.js");

describe("parseCalendarAction (proposal extraction)", () => {
  test("extracts a create_event with summary/start/end + optionals", () => {
    const p = parseCalendarAction(
      '{"intent":"create_event","summary":"HPE meeting","start":"2026-08-31T10:00:00","end":"2026-08-31T11:00:00","description":"Quarterly","location":"Zoom"}',
    );
    expect(p).toEqual({
      intent: "create_event",
      event: { summary: "HPE meeting", start: "2026-08-31T10:00:00", end: "2026-08-31T11:00:00", description: "Quarterly", location: "Zoom" },
    });
  });

  test("drops empty description/location and non-create intents", () => {
    expect(parseCalendarAction('{"intent":"none"}')).toEqual({ intent: "none" });
    expect(parseCalendarAction('{"intent":"create_event","summary":"","start":"","end":""}')).toEqual({
      intent: "create_event",
      event: { summary: "", start: "", end: "" },
    });
    expect(parseCalendarAction("not json")).toEqual({ intent: "none" });
  });
});

describe("parseCalendarResolve (confirm/cancel/edit)", () => {
  const fallback = { summary: "HPE meeting", start: "2026-08-31T10:00:00", end: "2026-08-31T11:00:00", description: "Quarterly" };

  test("passes confirm/cancel/unrelated through", () => {
    expect(parseCalendarResolve('{"intent":"confirm"}', fallback)).toEqual({ intent: "confirm" });
    expect(parseCalendarResolve('{"intent":"cancel"}', fallback)).toEqual({ intent: "cancel" });
    expect(parseCalendarResolve('{"intent":"unrelated"}', fallback)).toEqual({ intent: "unrelated" });
    expect(parseCalendarResolve('{"intent":"wat"}', fallback).intent).toBe("ambiguous");
    expect(parseCalendarResolve("garbage", fallback).intent).toBe("ambiguous");
  });

  test("edit inherits unchanged fields from the pending event", () => {
    const r = parseCalendarResolve('{"intent":"edit","start":"2026-08-31T14:00:00","end":"2026-08-31T15:00:00"}', fallback);
    expect(r.intent).toBe("edit");
    expect(r.event).toEqual({ summary: "HPE meeting", start: "2026-08-31T14:00:00", end: "2026-08-31T15:00:00", description: "Quarterly" });
  });
});

describe("isCalendarEventActionable (title + parseable times gate)", () => {
  test("requires summary and concrete start/end", () => {
    expect(isCalendarEventActionable({ summary: "HPE", start: "2026-08-31T10:00:00", end: "2026-08-31T11:00:00" })).toBe(true);
    expect(isCalendarEventActionable({ summary: "", start: "2026-08-31T10:00:00", end: "2026-08-31T11:00:00" })).toBe(false);
    expect(isCalendarEventActionable({ summary: "HPE", start: "soon", end: "" })).toBe(false);
    expect(isCalendarEventActionable({ summary: "HPE", start: "", end: "" })).toBe(false);
  });
});

describe("calendarActionHint + renderCalendarEvent", () => {
  test("gates on calendar keywords, falls through otherwise", () => {
    expect(calendarActionHint("add a meeting on monday to my calendar")).toBe(true);
    expect(calendarActionHint("schedule an appointment for tuesday")).toBe(true);
    expect(calendarActionHint("what's on my calendar this week")).toBe(true);
    expect(calendarActionHint("say hi")).toBe(false);
    expect(calendarActionHint("what's the weather")).toBe(false);
  });

  test("renders a readable proposal block", () => {
    const text = renderCalendarEvent({ summary: "HPE meeting", start: "2026-09-07T11:00:00", end: "2026-09-07T11:30:00", location: "Zoom" });
    expect(text).toContain("HPE meeting");
    expect(text).toContain("11:00 AM – 11:30 AM · Monday, September 7");
    expect(text).toContain("Where: Zoom");
  });

  test("rendered wall-clock equals the posted wall-clock", () => {
    const text = renderCalendarEvent({ summary: "X", start: "2026-08-31T10:00:00", end: "2026-08-31T11:00:00" });
    expect(text).toContain("10:00 AM – 11:00 AM · Monday, August 31");
  });
});