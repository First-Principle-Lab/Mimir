import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Redis } from "ioredis";
import { io, type Socket } from "socket.io-client";

// Two API instances in one process, sharing Redis the way two Render
// instances do: the socket.io Redis adapter, the presence registry, pub/sub
// claims and the delivery table's leases.
process.env.JWT_SECRET = "socket-test-secret";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";

const { createSocketHub, initPubSub } = await import("../infra/socket.js");
const { SocketRegistry, SOCKET_ENTRY_TTL_MS } =
  await import("../infra/socket-registry.js");
const { drainDeliveries } = await import("../infra/delivery-queue.js");
const { signAccessToken } = await import("../auth/tokens.js");
const { getConfig, getPrismaClient } = await import("@mimir/backend-core");

const JWT_SECRET = getConfig().JWT_SECRET;
const prisma = getPrismaClient();
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const subscribers: Redis[] = [];
const servers: Server[] = [];

async function instance(id: string) {
  const server = createServer();
  const hub = createSocketHub(server, redis, id);
  const subscriber = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 1,
  });
  initPubSub(subscriber, redis, hub);
  subscribers.push(subscriber);
  servers.push(server);
  const port = await new Promise<number>((resolve) =>
    server.listen(0, () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  return { hub, port };
}

const a = await instance(`inst-a-${randomUUID().slice(0, 6)}`);
const b = await instance(`inst-b-${randomUUID().slice(0, 6)}`);
// psubscribe and the adapter's subscriptions are asynchronous.
await Bun.sleep(200);

const userId = `multi-${randomUUID()}`;
const conversationId = randomUUID();
const sockets: Socket[] = [];

function connect(port: number, user = userId): Promise<Socket> {
  return signAccessToken(user, JWT_SECRET).then(
    (token) =>
      new Promise((resolve, reject) => {
        const socket = io(`http://localhost:${port}`, {
          transports: ["websocket"],
          extraHeaders: { Cookie: `access_token=${token}` },
        });
        sockets.push(socket);
        socket.on("connect", () => resolve(socket));
        socket.on("connect_error", reject);
      }),
  );
}

// Registry writes follow the handshake asynchronously.
async function presence(user = userId, expected: number) {
  for (let i = 0; i < 50; i++) {
    if ((await a.hub.registry.count(user)) === expected) return;
    await Bun.sleep(20);
  }
  throw new Error(`presence never reached ${expected}`);
}

beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.local`, passwordHash: "x" },
  });
  await prisma.conversation.create({ data: { id: conversationId, userId } });
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await a.hub.close(100);
  await b.hub.close(100);
  for (const s of servers) s.close();
  await Promise.all(subscribers.map((s) => s.quit()));
  await prisma.deliveryReceipt.deleteMany({
    where: { delivery: { conversationId } },
  });
  await prisma.delivery.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.user.delete({ where: { id: userId } });
  await redis.quit();
});

describe("multiple API instances", () => {
  test("an emit on one instance reaches the user's socket on another", async () => {
    const onB = await connect(b.port);
    await presence(userId, 1);
    const got: unknown[] = [];
    onB.on("debug", (p) => got.push(p));
    expect(await a.hub.emitToUser(userId, "debug", { from: "a" })).toBe(1);
    await Bun.sleep(100);
    expect(got).toEqual([{ from: "a" }]);
    onB.disconnect();
    await presence(userId, 0);
    expect(await a.hub.emitToUser(userId, "debug", {})).toBe(0);
  });

  test("a queued reply drained by an instance without the socket is delivered once by socket, not push", async () => {
    const onB = await connect(b.port);
    await presence(userId, 1);
    const message = await prisma.message.create({
      data: { conversationId, role: "assistant", content: "hello from A" },
    });
    await prisma.delivery.create({
      data: {
        conversationId,
        userId,
        messageId: message.id,
        urgency: "normal",
        reasonCode: "user_reply",
        ambient: false,
      },
    });
    const received: { content?: string }[] = [];
    onB.on("new_message", (p) => received.push(p));
    let pushes = 0;
    const push = async () => {
      pushes += 1;
      return 1;
    };
    // Both instances drain at once, as their 1s ticks and pub/sub wakes do.
    const [sentA, sentB] = await Promise.all([
      drainDeliveries({ userId, emit: a.hub.emitToUser, push }),
      drainDeliveries({ userId, emit: b.hub.emitToUser, push }),
    ]);
    await Bun.sleep(100);
    expect(sentA + sentB).toBe(1);
    expect(pushes).toBe(0);
    expect(received.map((r) => r.content)).toEqual(["hello from A"]);
    onB.disconnect();
    await presence(userId, 0);
  });

  test("pub/sub events reach each socket exactly once across instances", async () => {
    const [onA, onB] = await Promise.all([connect(a.port), connect(b.port)]);
    await presence(userId, 2);
    const seen = { a: [] as string[], b: [] as string[] };
    for (const [name, socket] of [
      ["a", onA],
      ["b", onB],
    ] as const) {
      socket.on("message_delta", () => seen[name].push("delta"));
      socket.on("note", () => seen[name].push("note"));
    }
    const pub = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    // Stream events: every instance emits only to its own sockets.
    await pub.publish(
      `user-events:${userId}`,
      JSON.stringify({ event: "message_delta", payload: { text: "hi" } }),
    );
    // Ad-hoc events: one instance claims the event and emits cluster-wide.
    await pub.publish(
      `user-events:${userId}`,
      JSON.stringify({
        event: "note",
        payload: { content: "x" },
        at: new Date().toISOString(),
      }),
    );
    await Bun.sleep(300);
    await pub.quit();
    expect(seen).toEqual({ a: ["delta", "note"], b: ["delta", "note"] });
  });
});

describe("socket registry", () => {
  test("a crashed instance's sockets expire instead of suppressing push", async () => {
    let now = Date.now();
    const user = `registry-${randomUUID()}`;
    const crashed = new SocketRegistry(redis, "crashed", () => now);
    const live = new SocketRegistry(redis, "live", () => now);
    await crashed.add(user, "s1");
    await live.add(user, "s2");
    expect(await live.count(user)).toBe(2);
    // Only the live instance keeps heartbeating.
    now += SOCKET_ENTRY_TTL_MS - 1000;
    await live.heartbeat();
    now += 2000;
    expect(await live.count(user)).toBe(1);
    await live.clear();
    expect(await live.count(user)).toBe(0);
  });
});
