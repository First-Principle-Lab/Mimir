import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";

// storeWebhook touches the DB; the signature/verify functions are pure.
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "webhooks-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GOOGLE_CALENDAR_INTEGRATION } = await import("@mimir/connection-provider");
const { gmailExternalId, isStale, slackSignature, storeWebhook, verifyGithubSignature, verifySlackSignature, webhooksRouter } = await import("../routes/webhooks.js");

const prisma = getPrismaClient();
const provider = `webhook-test-${randomUUID()}`;

beforeAll(async () => {});

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({ where: { provider } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "github" } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "slack" } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "gmail" } });
  await prisma.webhookEvent.deleteMany({ where: { provider: "googlecalendar" } });
});

describe("github signature verification (6.1.2)", () => {
  test("accepts a valid HMAC-SHA256 signature", () => {
    const raw = JSON.stringify({ action: "opened", delivery: "d1" });
    const sig = createHmac("sha256", "secret").update(raw).digest("hex");
    expect(verifyGithubSignature(raw, `sha256=${sig}`, "secret")).toBe(true);
  });

  test("rejects a wrong signature and a missing header", () => {
    expect(verifyGithubSignature('{"x":1}', "sha256=deadbeef", "secret")).toBe(false);
    expect(verifyGithubSignature('{"x":1}', undefined, "secret")).toBe(false);
  });

  test("rejects a different secret", () => {
    const raw = '{"x":1}';
    const sig = createHmac("sha256", "other").update(raw).digest("hex");
    expect(verifyGithubSignature(raw, `sha256=${sig}`, "secret")).toBe(false);
  });
});

describe("slack signature verification (6.1.2)", () => {
  test("accepts a valid versioned signature", () => {
    const body = '{"event_id":"e1"}';
    const sig = `v0=${slackSignature("secret", "1700000000", body)}`;
    expect(verifySlackSignature(body, "1700000000", sig, "secret")).toBe(true);
  });

  test("rejects a tampered body / wrong secret / missing parts", () => {
    const body = '{"event_id":"e1"}';
    const sig = `v0=${slackSignature("secret", "1700000000", body)}`;
    expect(verifySlackSignature('{"event_id":"EVIL"}', "1700000000", sig, "secret")).toBe(false);
    expect(verifySlackSignature(body, "1700000000", sig, "wrong")).toBe(false);
    expect(verifySlackSignature(body, undefined, sig, "secret")).toBe(false);
  });
});

describe("replay protection (6.1.3)", () => {
  test("rejects a timestamp older than 5 minutes", () => {
    const now = 1_000_000;
    expect(isStale(now - 6 * 60 * 1000, now)).toBe(true);
  });

  test("accepts a fresh timestamp and rejects non-finite", () => {
    const now = 1_000_000;
    expect(isStale(now - 60 * 1000, now)).toBe(false);
    expect(isStale(NaN, now)).toBe(true);
  });
});

describe("storeWebhook (6.1.4 idempotency)", () => {
  test("stores a new event once and treats the duplicate as a no-op", async () => {
    const id = `wh-${randomUUID()}`;
    const first = await storeWebhook(provider, id, { hello: "world" });
    expect(first.stored).toBe(true);
    expect(first.id).toBeTruthy();

    const dup = await storeWebhook(provider, id, { hello: "world" });
    expect(dup.stored).toBe(false);
    expect(dup.id).toBe(first.id);

    expect(await prisma.webhookEvent.count({ where: { provider, externalId: id } })).toBe(1);
  });
});

describe("gmailExternalId (6.1.4 mailbox-namespaced dedup)", () => {
  test("two different mailboxes at the same historyId get distinct ids (no cross-user drop)", () => {
    const a = gmailExternalId({ historyId: "500", emailAddress: "alice@gmail.com" }, "x");
    const b = gmailExternalId({ historyId: "500", emailAddress: "bob@gmail.com" }, "x");
    expect(a).not.toBe(b);
    expect(a).toContain("alice@gmail.com:500");
    expect(b).toContain("bob@gmail.com:500");
  });

  test("same mailbox + historyId is stable (dedup still works)", () => {
    const a = gmailExternalId({ historyId: "500", emailAddress: "alice@gmail.com" }, "x");
    const b = gmailExternalId({ historyId: "500", emailAddress: "alice@gmail.com" }, "x");
    expect(a).toBe(b);
  });
});

describe("/webhooks/calendar (Google Calendar push)", () => {
  const calUserId = `cal-webhook-${randomUUID()}`;
  const channelId = `chan-${randomUUID()}`;
  const token = `cal-token-${randomUUID()}`;
  let appUrl = "";
  let server: Server;

  async function postPush(headers: Record<string, string>, body: unknown): Promise<Response> {
    return fetch(`${appUrl}/webhooks/calendar`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: calUserId, email: `${calUserId}@test.local`, passwordHash: "x" } });
    await prisma.integrationConnection.create({
      data: {
        userId: calUserId,
        provider: GOOGLE_CALENDAR_INTEGRATION,
        connectionId: `ca-${randomUUID()}`,
        status: "connected",
        webhookMeta: { token, channelId, resourceId: "res-1", expiration: Date.now() + 7 * 24 * 3600 * 1000 },
      },
    });
    // Boot a real express app mirroring server.ts's /webhooks setup (verify-hook
    // rawBody capture so req.body is still parsed) — exercised over actual HTTP.
    const app = express();
    app.use("/webhooks", express.json({ verify: (_req, _res, buf) => { (_req as { rawBody?: string }).rawBody = buf.toString("utf8"); } }));
    app.use(express.json());
    app.use("/webhooks", webhooksRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        appUrl = `http://localhost:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server?.close();
    await prisma.integrationConnection.deleteMany({ where: { userId: calUserId } });
    await prisma.user.delete({ where: { id: calUserId } });
  });

  function pushHeaders(messageNumber: string, overrides: Record<string, string> = {}) {
    return {
      "x-goog-channel-id": channelId,
      "x-goog-message-number": messageNumber,
      "x-goog-channel-token": token,
      "x-goog-resource-id": "res-1",
      ...overrides,
    };
  }

  test("a valid push is stored once; the same message-number redelivery is an atomic no-op", async () => {
    const first = await postPush(pushHeaders("1"), { message: { summary: "hi" } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ stored: true });

    const dup = await postPush(pushHeaders("1"), { message: { summary: "hi" } });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ stored: false });
    expect(await prisma.webhookEvent.count({ where: { provider: "googlecalendar", externalId: `${channelId}:1` } })).toBe(1);
  });

  test("a forged token is rejected 401 BEFORE any DB write", async () => {
    const before = await prisma.webhookEvent.count({ where: { provider: "googlecalendar" } });
    const res = await postPush(pushHeaders("2", { "x-goog-channel-token": "attacker-token" }), { message: {} });
    expect(res.status).toBe(401);
    const after = await prisma.webhookEvent.count({ where: { provider: "googlecalendar" } });
    expect(after).toBe(before);
  });

  test("an unknown channel is rejected 401 (no match on channelId)", async () => {
    const res = await postPush(pushHeaders("3", { "x-goog-channel-id": "alien-channel" }), { message: {} });
    expect(res.status).toBe(401);
    expect(await prisma.webhookEvent.count({ where: { provider: "googlecalendar", externalId: "alien-channel:3" } })).toBe(0);
  });

  test("missing push headers are 400; a channel-sync ack never stores", async () => {
    const res = await postPush({}, { message: {} });
    expect(res.status).toBe(400);

    const sync = await postPush(pushHeaders("4", { "x-goog-resource-state": "sync" }), { message: {} });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ stored: false });
    expect(await prisma.webhookEvent.count({ where: { provider: "googlecalendar", externalId: `${channelId}:4` } })).toBe(0);
  });
});
