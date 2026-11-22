import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { Queue } from "bullmq";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "message-route-test-secret";

const { CONVERSATION_TURNS, getConfig, getPrismaClient } = await import("@mimir/backend-core");
const { signAccessToken } = await import("../auth/tokens.js");
const { messageRouter } = await import("../routes/message.js");

const prisma = getPrismaClient();
const turns = new Queue(CONVERSATION_TURNS, { connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } });
const userId = `msg-route-${randomUUID()}`;
const otherUserId = `msg-route-other-${randomUUID()}`;
const conversationId = randomUUID();
const otherConversationId = randomUUID();
let server: Server;
let base = "";
let cookie = "";

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" } });
  await prisma.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, passwordHash: "x" } });
  await prisma.conversation.create({ data: { id: conversationId, userId } });
  await prisma.conversation.create({ data: { id: otherConversationId, userId: otherUserId } });
  cookie = `access_token=${await signAccessToken(userId, getConfig().JWT_SECRET)}`;
  const app = express();
  app.use(express.json());
  app.use("/api/v1", messageRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as { port: number }).port}/api/v1`;
});

afterAll(async () => {
  server.close();
  // No worker runs in this suite; remove the turn jobs it queued so a dev worker
  // sharing this Redis doesn't pick them up against deleted rows.
  const messages = await prisma.message.findMany({ where: { conversationId }, select: { id: true } });
  for (const m of messages) await (await turns.getJob(`turn-${m.id}`))?.remove().catch(() => {});
  await turns.close();
  await prisma.outboxEvent.deleteMany({ where: { payload: { path: ["conversationId"], equals: conversationId } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: [conversationId, otherConversationId] } } });
  await prisma.conversation.deleteMany({ where: { id: { in: [conversationId, otherConversationId] } } });
  await prisma.analyticsEvent.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
});

const post = (body: unknown, withCookie = true) =>
  fetch(`${base}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /message", () => {
  test("records the message, queues the turn and returns 202", async () => {
    const clientMessageId = randomUUID();
    const res = await post({ conversationId, content: "hello", clientMessageId });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { message: { id: string; content: string }; status: string };
    expect(body).toMatchObject({ status: "queued", message: { content: "hello" } });

    const job = await turns.getJob(`turn-${body.message.id}`);
    expect(job?.data).toEqual({ conversationId, userId, messageId: body.message.id });
    const outbox = await prisma.outboxEvent.findFirst({ where: { payload: { path: ["messageId"], equals: body.message.id } } });
    expect(outbox?.eventType).toBe("conversation_turn");
    expect(outbox?.processedAt).not.toBeNull(); // the fast path enqueued it
  });

  test("a retry of an unanswered message is 202 again, with no second message", async () => {
    const clientMessageId = randomUUID();
    const first = (await (await post({ conversationId, content: "again", clientMessageId })).json()) as { message: { id: string } };
    const res = await post({ conversationId, content: "again", clientMessageId });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { message: { id: string } }).message.id).toBe(first.message.id);
    expect(await prisma.message.count({ where: { conversationId, clientMessageId } })).toBe(1);
  });

  test("a retry of an answered message returns the reply", async () => {
    const clientMessageId = randomUUID();
    const first = (await (await post({ conversationId, content: "q", clientMessageId })).json()) as { message: { id: string } };
    await prisma.message.create({ data: { conversationId, role: "assistant", content: "a", parentMessageId: first.message.id } });
    const res = await post({ conversationId, content: "q", clientMessageId });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: { content: string } }).reply.content).toBe("a");
  });

  test("someone else's conversation is 404", async () => {
    const res = await post({ conversationId: otherConversationId, content: "hi", clientMessageId: randomUUID() });
    expect(res.status).toBe(404);
  });

  test("an invalid payload is 400 and an anonymous request 401", async () => {
    expect((await post({ conversationId, content: "", clientMessageId: randomUUID() })).status).toBe(400);
    expect((await post({ conversationId, content: "hi", clientMessageId: randomUUID() }, false)).status).toBe(401);
  });
});

describe("GET /conversation", () => {
  test("returns the thread in order", async () => {
    const res = await fetch(`${base}/conversation`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string; messages: { content: string }[] } };
    expect(body.conversation.id).toBe(conversationId);
    expect(body.conversation.messages[0]!.content).toBe("hello");
  });
});
