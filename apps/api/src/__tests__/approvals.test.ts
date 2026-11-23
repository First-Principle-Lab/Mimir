import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "approval-route-tests";
const { getPrismaClient, getConfig } = await import("@mimir/backend-core");
const { approvalsRouter } = await import("../routes/approvals.js");
const { createMessageRouter } = await import("../routes/message.js");
const { signAccessToken } = await import("../auth/tokens.js");
const prisma = getPrismaClient();
const userId = randomUUID();
const foreign = randomUUID();
let conversationId: string;
let cookie: string;
let foreignCookie: string;
let base: string;
const app = express();
app.use(express.json());
app.use(approvalsRouter);
app.use(createMessageRouter(async () => true));
const server = createServer(app);
beforeAll(async () => {
  for (const id of [userId, foreign])
    await prisma.user.create({
      data: { id, email: id + "@example.test", passwordHash: "synthetic" },
    });
  conversationId = (await prisma.conversation.create({ data: { userId } })).id;
  cookie =
    "access_token=" + (await signAccessToken(userId, getConfig().JWT_SECRET));
  foreignCookie =
    "access_token=" + (await signAccessToken(foreign, getConfig().JWT_SECRET));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.outboxEvent.deleteMany({
    where: { payload: { path: ["conversationId"], equals: conversationId } },
  });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, foreign] } } });
});
async function card() {
  const run = await prisma.agentRun.create({
    data: { userId, conversationId, trigger: "user", status: "waiting_human" },
  });
  return prisma.actionApproval.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      toolCallId: randomUUID(),
      toolName: "github_create_issue",
      provenance: "test:write",
      arguments: { repo: "fixture/repo", title: "Actual title" },
      argumentHash: "a".repeat(64),
      risk: "communicate_external",
      reason: "risk_tier",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
}
async function decide(id: string, body: unknown, auth = cookie) {
  return fetch(base + "/approvals/" + id + "/decision", {
    method: "POST",
    headers: { cookie: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("cards and decisions require authentication and ownership", async () => {
  const c = await card();
  expect(
    (await fetch(base + "/approvals?conversationId=" + conversationId)).status,
  ).toBe(401);
  const list = await fetch(
    base + "/approvals?conversationId=" + conversationId,
    { headers: { cookie: foreignCookie } },
  );
  expect(((await list.json()) as { approvals: unknown[] }).approvals).toEqual(
    [],
  );
  expect(
    (
      await decide(
        c.id,
        { approved: true, argumentHash: c.argumentHash },
        foreignCookie,
      )
    ).status,
  ).toBe(404);
});
test("parallel repeated decisions create exactly one durable answer and wake", async () => {
  const c = await card();
  const body = { approved: true, argumentHash: c.argumentHash };
  const responses = await Promise.all([decide(c.id, body), decide(c.id, body)]);
  expect(responses.every((r) => r.status === 202 || r.status === 409)).toBe(
    true,
  );
  const rows = await prisma.inboxInput.findMany({
    where: { dedupeKey: "approval:" + c.id },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.source).toBe("user:approval-card");
  expect(
    await prisma.outboxEvent.count({
      where: { payload: { path: ["inputId"], equals: rows[0]!.id } },
    }),
  ).toBe(1);
  expect((await decide(c.id, body)).status).toBe(202);
});
test("a card hash binds the decision and callers cannot replace arguments", async () => {
  const c = await card();
  expect(
    (await decide(c.id, { approved: true, argumentHash: "b".repeat(64) }))
      .status,
  ).toBe(409);
  expect(
    (
      await decide(c.id, {
        approved: true,
        argumentHash: c.argumentHash,
        arguments: { title: "Replaced" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await prisma.actionApproval.findUniqueOrThrow({ where: { id: c.id } }))
      .status,
  ).toBe("pending");
});
test("declined and expired cards cannot later authorize an action", async () => {
  const c = await card();
  expect(
    (await decide(c.id, { approved: false, argumentHash: c.argumentHash }))
      .status,
  ).toBe(202);
  expect(
    (await decide(c.id, { approved: true, argumentHash: c.argumentHash }))
      .status,
  ).toBe(409);
  const expired = await card();
  await prisma.actionApproval.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(0) },
  });
  expect(
    (
      await decide(expired.id, {
        approved: true,
        argumentHash: expired.argumentHash,
      })
    ).status,
  ).toBe(410);
});
test("a new user correction or stop cancels older cards", async () => {
  // An ordinary message leaves open cards alone.
  const c = await card();
  const chat = await fetch(base + "/message", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      content: "Also, what's on my calendar tomorrow?",
      clientMessageId: randomUUID(),
    }),
  });
  expect(chat.status).toBe(202);
  expect(
    (await prisma.actionApproval.findUniqueOrThrow({ where: { id: c.id } }))
      .status,
  ).toBe("pending");
  expect(
    (await prisma.agentRun.findUniqueOrThrow({ where: { id: c.runId } }))
      .status,
  ).toBe("waiting_human");
  const response = await fetch(base + "/message", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      content: "stop",
      clientMessageId: randomUUID(),
    }),
  });
  expect(response.status).toBe(202);
  expect(
    (await prisma.actionApproval.findUniqueOrThrow({ where: { id: c.id } }))
      .status,
  ).toBe("canceled");
  expect(
    (await decide(c.id, { approved: true, argumentHash: c.argumentHash }))
      .status,
  ).toBe(409);
});
