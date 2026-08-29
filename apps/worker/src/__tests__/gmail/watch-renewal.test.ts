import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "watch-renew-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GMAIL_INTEGRATION, GOOGLE_CALENDAR_INTEGRATION } = await import("@mimir/connection-provider");
import type { GmailTransport } from "../../integrations/gmail/gmail.js";
const { registerGmailWatch } = await import("../../integrations/gmail/gmail.js");
import type { RequestFn } from "../../integrations/http-rpc.js";
const { registerCalendarWatch } = await import("../../integrations/calendar/calendar-watch.js");
const { runWatchRenewal } = await import("../../integrations/gmail/watch-renewal.js");

const prisma = getPrismaClient();
const userId = `watch-${randomUUID()}`;
const email = `${userId}@test.local`;
const calUserId = `watch-cal-${randomUUID()}`;
const ADDRESS = "https://test.local/webhooks/calendar";

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({ data: { userId, provider: GMAIL_INTEGRATION, connectionId: `n-${userId}`, status: "connected" } });
  await prisma.user.create({ data: { id: calUserId, email: `${calUserId}@test.local`, passwordHash: "x" } });
  // Near-expiry channel: the renewal sweep must re-register and swap channelId.
  await prisma.integrationConnection.create({
    data: {
      userId: calUserId,
      provider: GOOGLE_CALENDAR_INTEGRATION,
      connectionId: `ca-expiring-${calUserId}`,
      status: "connected",
      webhookMeta: { token: "cal-token-1", channelId: "old-chan", resourceId: "res-old", expiration: 1750000000000 },
    },
  });
});

afterAll(async () => {
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.integrationConnection.deleteMany({ where: { userId: calUserId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.user.delete({ where: { id: calUserId } });
});

describe("registerGmailWatch (6.2.1)", () => {
  test("POSTs the watch body and returns expiration + historyId", async () => {
    let captured: { path: string; method: string; body: unknown } | undefined;
    const transport: GmailTransport = async (path, opts) => {
      captured = { path, method: opts?.method ?? "GET", body: opts?.body };
      return { status: 200, data: { expiration: 1729999999000, historyId: "12345" } };
    };

    const res = await registerGmailWatch(transport, "projects/p/topics/t");
    expect(res).toEqual({ expiration: 1729999999000, historyId: "12345" });
    expect(captured!.path).toBe("/gmail/v1/users/me/watch");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toMatchObject({ topicName: "projects/p/topics/t", labelIds: ["INBOX"] });
  });

  test("missing historyId -> ProviderError(malformed_response)", async () => {
    const transport: GmailTransport = async () => ({ status: 200, data: {} });
    expect(registerGmailWatch(transport, "projects/p/topics/t")).rejects.toMatchObject({ kind: "malformed_response" });
  });
});

describe("registerCalendarWatch (calendar push channel)", () => {
  test("POSTs the watch body with our channelId + token and returns the channel", async () => {
    let captured: { path: string; method: string; body: unknown } | undefined;
    const request: RequestFn = async (path, opts) => {
      captured = { path, method: opts?.method ?? "GET", body: opts?.body };
      return { status: 200, data: { id: "chan-new", resourceId: "res-new", expiration: 1760000000000 } };
    };

    const res = await registerCalendarWatch(request, { address: ADDRESS, channelId: "chan-new", token: "cal-token-1" });
    expect(res).toEqual({ id: "chan-new", resourceId: "res-new", expiration: 1760000000000 });
    expect(captured!.path).toBe("/calendars/primary/events/watch");
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toMatchObject({ id: "chan-new", type: "web_hook", address: ADDRESS, token: "cal-token-1" });
  });

  test("missing channel id -> ProviderError(malformed_response)", async () => {
    const request: RequestFn = async () => ({ status: 200, data: {} });
    expect(registerCalendarWatch(request, { address: ADDRESS, channelId: "x", token: "t" })).rejects.toMatchObject({ kind: "malformed_response" });
  });
});

describe("runWatchRenewal (6.2.2)", () => {
  test("re-registers a gmail watch for every connected user (idempotent refresh)", async () => {
    const renewed = await runWatchRenewal({
      topic: "projects/p/topics/t",
      request: () => async () => ({ status: 200, data: { expiration: 1750000000000, historyId: "999" } }),
    });
    // Shared DB holds other connected users too; assert at least ours.
    expect(renewed).toBeGreaterThanOrEqual(1);
  });

  test("no topic configured -> gmail part is a no-op (not an error)", async () => {
    expect(await runWatchRenewal({ topic: undefined })).toBe(0);
  });

  test("a calendar channel inside its expiry window is re-registered (fresh channelId, token preserved)", async () => {
    const now = 1750000000000; // matches the seeded near-expiry expiration
    let stopped: { id: string; resourceId: string } | undefined;
    const request: RequestFn = async (path, opts) => {
      if (path === "/calendars/primary/events/watch") {
        // Google echoes the channel id we send; the fake mirrors that.
        const body = (opts?.body ?? {}) as { id?: string };
        return { status: 200, data: { id: body.id ?? "chan-new", resourceId: "res-new", expiration: 1770000000000 } };
      }
      if (path === "/channels/stop") {
        stopped = opts?.body as { id: string; resourceId: string };
        return { status: 200, data: {} };
      }
      return { status: 404, data: {} };
    };

    const renewed = await runWatchRenewal({ topic: undefined, address: ADDRESS, now, calendarRequest: () => request });
    expect(renewed).toBeGreaterThanOrEqual(1);

    const row = await prisma.integrationConnection.findFirst({ where: { userId: calUserId, provider: GOOGLE_CALENDAR_INTEGRATION } });
    const meta = (row?.webhookMeta ?? {}) as { token?: string; channelId?: string; expiration?: number; resourceId?: string };
    expect(meta.channelId).not.toBe("old-chan"); // fresh re-registered channel
    expect(meta.token).toBe("cal-token-1"); // same token survives so in-flight old-channel pushes still verify
    expect(meta.expiration).toBe(1770000000000);
    expect(stopped).toEqual({ id: "old-chan", resourceId: "res-old" });
    // Restore for the skip test below.
    await prisma.integrationConnection.update({
      where: { id: row!.id },
      data: { webhookMeta: { token: "cal-token-1", channelId: "old-chan", resourceId: "res-old", expiration: 1770000000000 } },
    });
  });

  test("a calendar channel NOT near expiry is left untouched (no re-register)", async () => {
    const now = 1750000000000;
    const farExpiry = now + 25 * 60 * 60 * 1000; // > the 24h renewal window
    await prisma.integrationConnection.updateMany({
      where: { userId: calUserId, provider: GOOGLE_CALENDAR_INTEGRATION },
      data: { webhookMeta: { token: "cal-token-1", channelId: "old-chan", resourceId: "res-old", expiration: farExpiry } },
    });
    const request: RequestFn = async () => ({ status: 404, data: {} }); // would throw on a registration attempt

    const renewed = await runWatchRenewal({ topic: undefined, address: ADDRESS, now, calendarRequest: () => request });
    // The 404 transport ensures NO watch call was attempted for the healthy channel.
    expect(renewed).toBe(0);
    const row = await prisma.integrationConnection.findFirst({ where: { userId: calUserId, provider: GOOGLE_CALENDAR_INTEGRATION } });
    expect(((row?.webhookMeta ?? {}) as { channelId?: string }).channelId).toBe("old-chan");
  });
});