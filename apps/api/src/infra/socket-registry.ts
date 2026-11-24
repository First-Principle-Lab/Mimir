import type { Redis } from "ioredis";

// Cluster-wide record of which users have live sockets, so any API instance can
// decide socket vs push for a user connected to a different instance. Each
// entry is `${instanceId}:${socketId}` scored by its expiry; the owning
// instance refreshes its entries on a heartbeat, so a crashed instance's
// sockets drop out within SOCKET_ENTRY_TTL_MS instead of suppressing push.
export const SOCKET_ENTRY_TTL_MS = 90_000;
export const SOCKET_HEARTBEAT_MS = 30_000;

const key = (userId: string) => `user-sockets:${userId}`;

export class SocketRegistry {
  private readonly local = new Map<string, Set<string>>();

  constructor(
    private readonly redis: Redis,
    readonly instanceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  localSockets(userId: string): ReadonlySet<string> {
    return this.local.get(userId) ?? new Set();
  }

  localCount(): number {
    let n = 0;
    for (const ids of this.local.values()) n += ids.size;
    return n;
  }

  async add(userId: string, socketId: string): Promise<void> {
    let ids = this.local.get(userId);
    if (!ids) this.local.set(userId, (ids = new Set()));
    ids.add(socketId);
    await this.redis
      .multi()
      .zadd(
        key(userId),
        this.now() + SOCKET_ENTRY_TTL_MS,
        this.member(socketId),
      )
      .pexpire(key(userId), SOCKET_ENTRY_TTL_MS)
      .exec();
  }

  async remove(userId: string, socketId: string): Promise<void> {
    const ids = this.local.get(userId);
    ids?.delete(socketId);
    if (ids?.size === 0) this.local.delete(userId);
    await this.redis.zrem(key(userId), this.member(socketId));
  }

  // Live sockets for the user on every instance.
  async count(userId: string): Promise<number> {
    const now = this.now();
    const [, card] = (await this.redis
      .multi()
      .zremrangebyscore(key(userId), "-inf", now)
      .zcard(key(userId))
      .exec())!;
    return Number(card?.[1] ?? 0);
  }

  async heartbeat(): Promise<void> {
    if (!this.local.size) return;
    const tx = this.redis.multi();
    const expiry = this.now() + SOCKET_ENTRY_TTL_MS;
    for (const [userId, ids] of this.local) {
      for (const socketId of ids)
        tx.zadd(key(userId), expiry, this.member(socketId));
      tx.pexpire(key(userId), SOCKET_ENTRY_TTL_MS);
    }
    await tx.exec();
  }

  // Graceful shutdown: drop this instance's entries now rather than at expiry.
  async clear(): Promise<void> {
    const tx = this.redis.multi();
    for (const [userId, ids] of this.local)
      for (const socketId of ids) tx.zrem(key(userId), this.member(socketId));
    this.local.clear();
    await tx.exec();
  }

  private member(socketId: string): string {
    return `${this.instanceId}:${socketId}`;
  }
}
