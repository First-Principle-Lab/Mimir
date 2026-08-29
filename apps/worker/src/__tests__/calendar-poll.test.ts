import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { ApiRequestResult } from "@mimir/connection-provider";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "calendar-poll-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ConnectionError, GOOGLE_CALENDAR_INTEGRATION } = await import("@mimir/connection-provider");
const { pollCalendarActivity } = await import("../integrations/calendar/calendar-poll.js");
import type { CalendarPollDeps } from "../integrations/calendar/calendar-poll.js";

const prisma = getPrismaClient();
const userId = `cal-poll-${randomUUID()}`;
const email = `${userId}@test.local`;
let conversationId = "";

function fakeCache(): Redis {
  const sets = new Map<string, Set<string>>();
  return {
    sismember: async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0),
    sadd: async (key: string, member: string) => {
      const s = sets.get(key) ?? new Set<string>();
      const added = s.has(member) ? 0 : 1;
      s.add(member);
      sets.set(key, s);
      return added;
    },
    ttl: async (key: string) => (sets.has(key) ? 60 : -2),
    expire: async () => 1,
  } as unknown as Redis;
}

const event = (id: string, summary: string, updatedAt: string, overrides: Record<string, unknown> = {}) => ({
  id,
  summary,
  updated: updatedAt,
  status: "confirmed",
  start: { dateTime: "2026-09-01T10:00:00Z" },
  end: { dateTime: "2026-09-01T11:00:00Z" },
  organizer: { email: "boss@acme.com" },
  attendees: [{ email: userId }, { email: "boss@acme.com" }],
  ...overrides,
});

// Fake transport scoped to THIS user: /calendars/primary/events returns the
// injected events; other users get an empty list so the sweep only "sees" ours.
function requestForEvents(events: Array<Record<string, unknown>>) {
  return (forUserId: string) => async (path: string): Promise<ApiRequestResult> => {
    if (forUserId !== userId) return { status: 200, data: { items: [] } };
    if (path === "/calendars/primary/events") return { status: 200, data: { items: events } };
    return { status: 404, data: {} };
  };
}

const surfacingDeps = (overrides: Partial<CalendarPollDeps> = {}): CalendarPollDeps => ({
  cache: fakeCache(),
  judge: async () => ({ surface: true, rationale: "time changed", category: "actionable" as const }),
  publish: async () => {},
  requestFor: requestForEvents([event("evt-1", "Board review", "2026-08-30T09:00:00.000Z")]),
  now: Date.parse("2026-08-30T10:00:00.000Z"),
  windowMs: 60 * 60 * 1000,
  ...overrides,
});

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({
    data: { userId, provider: GOOGLE_CALENDAR_INTEGRATION, connectionId: `ca-${userId}`, status: "connected" },
  });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("pollCalendarActivity (monitor sweep)", () => {
  test("surfaces a changed event into the user's thread, judging with the calendar kind", async () => {
    const published: unknown[] = [];
    const judgedKinds: (string | undefined)[] = [];
    const surfaced = await pollCalendarActivity(
      surfacingDeps({
        publish: async (u, e, payload) => { published.push({ u, e, payload }); },
        judge: async (_u, _c, kind) => { judgedKinds.push(kind); return { surface: true, rationale: "time changed", category: "actionable" as const }; },
      }),
    );
    expect(surfaced).toBe(1);
    expect(published.length).toBe(1);
    expect(judgedKinds).toEqual(["googlecalendar"]);
    const rows = await prisma.message.findMany({ where: { conversationId, role: "assistant" } });
    expect(rows.some((r) => (r.content ?? "").includes("Board review"))).toBe(true);
  });

  test("Redis dedup keeps a re-polled unchanged event from surfacing twice", async () => {
    const cache = fakeCache();
    const deps = surfacingDeps({ cache });
    expect(await pollCalendarActivity(deps)).toBe(1);
    const before = await prisma.message.count({ where: { conversationId } });
    expect(await pollCalendarActivity(deps)).toBe(0);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  });

  test("a re-changed event (new updatedAt) IS re-judged: dedup key carries the revision", async () => {
    const cache = fakeCache();
    let payload = event("evt-2", "Sprint retro", "2026-08-30T09:00:00.000Z");
    const deps = surfacingDeps({
      cache,
      requestFor: (u) => async () => ({ status: 200, data: { items: u === userId ? [payload] : [] } }),
    });
    expect(await pollCalendarActivity(deps)).toBe(1);
    // Same event, same revision -> skip.
    expect(await pollCalendarActivity(deps)).toBe(0);
    // Revision changes (moved later) -> re-judged and re-surfaced.
    payload = event("evt-2", "Sprint retro", "2026-08-30T09:30:00.000Z");
    expect(await pollCalendarActivity(deps)).toBe(1);
  });

  test("a noise verdict is not surfaced and is held in the noise cooldown window", async () => {
    const cache = fakeCache();
    let judgeCalls = 0;
    const deps = surfacingDeps({
      cache,
      judge: async () => {
        judgeCalls++;
        return { surface: false, rationale: "", category: "noise" as const };
      },
    });
    expect(await pollCalendarActivity(deps)).toBe(0);
    expect(judgeCalls).toBe(1);
    expect(await pollCalendarActivity(deps)).toBe(0);
    expect(judgeCalls).toBe(1);
  });

  test("a judge error is NOT claimed, so the event is retried next sweep", async () => {
    const cache = fakeCache();
    let calls = 0;
    const deps: CalendarPollDeps = {
      ...surfacingDeps({ cache }),
      judge: async () => {
        calls++;
        return calls === 1
          ? { surface: false, rationale: "", category: "noise" as const, error: true }
          : { surface: true, rationale: "now", category: "actionable" as const };
      },
    };
    await pollCalendarActivity(deps);
    expect(calls).toBe(1);
    expect(await pollCalendarActivity(deps)).toBe(1);
  });

  test("a dead connection flips the row expired (fail-fast reconnect UX)", async () => {
    const deps: CalendarPollDeps = {
      ...surfacingDeps({}),
      requestFor: (u) => async () => {
        if (u !== userId) return { status: 200, data: { items: [] } };
        throw new ConnectionError("expired", "token revoked");
      },
    };
    await pollCalendarActivity(deps);
    const row = await prisma.integrationConnection.findFirst({ where: { userId, provider: GOOGLE_CALENDAR_INTEGRATION } });
    expect(row?.status).toBe("expired");
    await prisma.integrationConnection.updateMany({ where: { userId }, data: { status: "connected" } });
  });
});