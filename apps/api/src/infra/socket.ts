import { createHash, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import {
  getConfig,
  getLogger,
  recordFailure,
  registerGauge,
  withUserScope,
} from "@mimir/backend-core";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import { parseCookies, verifyAccessToken } from "../auth/tokens.js";
import { deliverToUser } from "./delivery.js";
import { acknowledgeDelivery, drainDeliveries } from "./delivery-queue.js";
import { redis as defaultRedis } from "./redis.js";
import { SOCKET_HEARTBEAT_MS, SocketRegistry } from "./socket-registry.js";

const cfg = getConfig();
const room = (userId: string) => `user:${userId}`;

export const instanceId =
  process.env.MIMIR_INSTANCE_ID ??
  process.env.RENDER_INSTANCE_ID ??
  randomUUID().slice(0, 8);

// One API instance's socket.io server. Sockets join a per-user room; the Redis
// adapter carries room emits to the other instances, and the registry answers
// "is this user connected anywhere?" for the delivery decision.
export interface SocketHub {
  io: Server;
  registry: SocketRegistry;
  // Sockets on this instance only (worker pub/sub reaches every instance).
  emitLocal(userId: string, event: string, payload: unknown): number;
  // Every instance; returns the user's live sockets cluster-wide.
  emitToUser(userId: string, event: string, payload: unknown): Promise<number>;
  close(graceMs?: number): Promise<void>;
}

export function createSocketHub(
  server: HttpServer,
  redis: Redis,
  id = instanceId,
): SocketHub {
  const origins = [
    cfg.WEB_APP_URL,
    "http://localhost:3000",
    "tauri://localhost",
  ].filter((o): o is string => Boolean(o));
  const io = new Server(server, {
    cors: { origin: origins, credentials: true },
  });
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  for (const client of [pub, sub])
    client.on("error", (err) =>
      getLogger().error({ err }, "socket adapter redis error"),
    );
  io.adapter(createAdapter(pub, sub, { key: "mimir-socket" }));
  const registry = new SocketRegistry(redis, id);

  io.use(async (socket, next) => {
    const token = parseCookies(socket.handshake.headers.cookie).access_token;
    const userId = token
      ? await verifyAccessToken(token, cfg.JWT_SECRET)
      : null;
    if (!userId) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    void socket.join(room(userId));
    const registered = registry.add(userId, socket.id).catch((err) => {
      recordFailure("socket", "registry_add");
      getLogger().error({ err, userId }, "socket registry add failed");
    });
    socket.on("delivery_ack", (payload: unknown) => {
      if (
        Array.isArray(payload) &&
        payload.every((id) => typeof id === "string")
      )
        void withUserScope(userId, () =>
          acknowledgeDelivery(userId, payload),
        ).catch((err) => {
          recordFailure("delivery", "receipt");
          getLogger().warn({ err }, "delivery receipt failed");
        });
    });
    // Drain after registering, so the drain sees this socket as present.
    void registered
      .then(() => drainDeliveries({ userId, emit: hub.emitToUser }))
      .catch((err) => getLogger().warn({ err }, "reconnect delivery failed"));
    getLogger().info(
      { userId, socketId: socket.id, open: registry.localSockets(userId).size },
      "socket connected",
    );
    // Manual ping/pong test event (distinct from socket.io's wire-level ping).
    socket.on("ping", (cb) => {
      if (typeof cb === "function")
        cb({ event: "pong", at: new Date().toISOString() });
      else socket.emit("pong", { at: new Date().toISOString() });
    });
    socket.on("disconnect", () => {
      void registry.remove(userId, socket.id).catch((err) => {
        recordFailure("socket", "registry_remove");
        getLogger().error({ err, userId }, "socket registry remove failed");
      });
      getLogger().info(
        {
          userId,
          socketId: socket.id,
          open: registry.localSockets(userId).size,
        },
        "socket disconnected",
      );
    });
  });

  const heartbeat = setInterval(() => {
    void registry.heartbeat().catch((err) => {
      recordFailure("socket", "registry_heartbeat");
      getLogger().error({ err }, "socket registry heartbeat failed");
    });
  }, SOCKET_HEARTBEAT_MS);
  heartbeat.unref();

  const hub: SocketHub = {
    io,
    registry,
    emitLocal(userId, event, payload) {
      io.local.to(room(userId)).emit(event, payload);
      return registry.localSockets(userId).size;
    },
    async emitToUser(userId, event, payload) {
      const live = await registry.count(userId);
      if (live) io.to(room(userId)).emit(event, payload);
      return live;
    },
    async close(graceMs = 8000) {
      clearInterval(heartbeat);
      await registry.clear().catch(() => {});
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bun 1.3 can leave the HTTP close callback waiting after websocket
        // transports close. Bound shutdown and end remaining HTTP connections.
        await Promise.race([
          io.close(),
          new Promise<void>((resolve) => {
            deadline = setTimeout(() => {
              server.closeAllConnections();
              resolve();
            }, graceMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        pub.disconnect();
        sub.disconnect();
      }
    },
  };
  return hub;
}

let hub: SocketHub | null = null;

// Attaches socket.io to the same http server express uses, authenticating each
// handshake with the access_token cookie.
export function initSocket(
  server: HttpServer,
  redis: Redis = defaultRedis,
): SocketHub {
  hub = createSocketHub(server, redis);
  registerGauge(
    "mimir_socket_connections",
    "Live sockets on this API instance",
    () => [[hub?.registry.localCount() ?? 0, { api_instance: instanceId }]],
  );
  return hub;
}

export function emitToUser(
  userId: string,
  event: string,
  payload: unknown,
): Promise<number> {
  return hub ? hub.emitToUser(userId, event, payload) : Promise.resolve(0);
}

export function emitLocal(
  userId: string,
  event: string,
  payload: unknown,
): number {
  return hub ? hub.emitLocal(userId, event, payload) : 0;
}

// Worker publishes on `user-events:{userId}`; every instance subscribes and
// pushes stream events to its own sockets. Events that may fall back to push
// are claimed once cluster-wide so N instances never send N pushes. Pattern
// subscribe needs its own connection: a subscribed client can't run commands.
export function initPubSub(
  subscriber: Redis,
  claims: Redis = defaultRedis,
  target: Pick<SocketHub, "emitLocal" | "emitToUser"> = {
    emitLocal,
    emitToUser,
  },
): void {
  subscriber.psubscribe("user-events:*");
  subscriber.on("error", (e) =>
    getLogger().error({ err: e }, "pub/sub redis error"),
  );
  subscriber.on("pmessage", (_pattern, chan, message) => {
    const userId = chan.replace(/^user-events:/, "");
    let parsed: { event?: string; payload?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      getLogger().warn(
        { channel: chan, message },
        "dropping non-JSON pub/sub payload",
      );
      return;
    }
    // Payloads carry their own event name ({event:'new_message',...}); emit on
    // that name so the web client can wire per-event handlers. Falls back to "debug".
    const eventName = typeof parsed.event === "string" ? parsed.event : "debug";
    if (eventName === "delivery_ready") {
      // Leases in the delivery table keep concurrent drains from double-sending.
      void drainDeliveries({ userId, emit: target.emitToUser }).catch((err) =>
        getLogger().error({ err }, "delivery wake failed"),
      );
      return;
    }
    if (eventName === "message_delta" || eventName === "turn_settled") {
      target.emitLocal(userId, eventName, parsed.payload);
      return;
    }
    const claim = `user-event-claim:${createHash("sha256")
      .update(chan + message)
      .digest("hex")}`;
    void claims
      .set(claim, instanceId, "PX", 60_000, "NX")
      .then((won) => {
        if (won !== "OK") return;
        // Live socket → web push. No email: email is a watched source, not a delivery channel.
        return deliverToUser(
          userId,
          eventName,
          (parsed.payload ?? {}) as { [k: string]: unknown },
          target.emitToUser,
        ).then((delivery) =>
          getLogger().info(
            { userId, eventName, channel: delivery },
            "user event delivered",
          ),
        );
      })
      .catch((e) => {
        recordFailure("delivery", "user_event");
        getLogger().error({ err: e, userId }, "delivery decision failed");
      });
  });
}
