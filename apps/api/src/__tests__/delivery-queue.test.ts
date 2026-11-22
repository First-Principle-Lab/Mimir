import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "delivery-queue-tests";
const { getPrismaClient } = await import("@mimir/backend-core");
const { acknowledgeDelivery, drainDeliveries } =
  await import("../infra/delivery-queue.js");
const prisma = getPrismaClient();
const userId = randomUUID();
let conversationId: string;
beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "synthetic",
      timezone: "UTC",
    },
  });
  conversationId = (await prisma.conversation.create({ data: { userId } })).id;
});
afterAll(async () => {
  if (!conversationId) return;
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.user.delete({ where: { id: userId } });
});
async function delivery(urgency = "normal", ambient = false) {
  const message = await prisma.message.create({
    data: { conversationId, role: "assistant", content: "Synthetic finding" },
  });
  return prisma.delivery.create({
    data: {
      conversationId,
      userId,
      messageId: message.id,
      urgency,
      reasonCode: "relevant_change",
      ambient,
    },
  });
}
test("dropped publish and a restarted sender recover; ownership protects ACKs", async () => {
  const row = await delivery();
  const now = new Date(Date.now() + 1000);
  const seen: unknown[] = [];
  const options = {
    now,
    userId,
    emit: (_user: string, _name: string, payload: unknown) => {
      seen.push(payload);
      return 1;
    },
    push: async () => 0,
  };
  await Promise.all([drainDeliveries(options), drainDeliveries(options)]);
  expect(seen).toHaveLength(1);
  expect(
    await prisma.deliveryReceipt.count({
      where: { deliveryId: row.id, channel: "socket" },
    }),
  ).toBe(1);
  await acknowledgeDelivery("another-user", [row.id]);
  expect(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: row.id } })).status,
  ).toBe("pending");
  await acknowledgeDelivery(userId, [row.id]);
  await acknowledgeDelivery(userId, [row.id]);
  expect(
    (await prisma.delivery.findUniqueOrThrow({ where: { id: row.id } })).status,
  ).toBe("delivered");
  expect(
    await prisma.deliveryReceipt.count({
      where: { deliveryId: row.id, channel: "client" },
    }),
  ).toBe(1);
  await drainDeliveries({ ...options, now: new Date(now.getTime() + 60_000) });
  expect(seen).toHaveLength(1);
});
test("quiet hours defer ambient delivery; low notifications form one digest", async () => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      notificationPreferences: {
        quietEnabled: true,
        quietStart: 1320,
        quietEnd: 480,
      },
    },
  });
  const rows = [await delivery("low", true), await delivery("low", true)];
  await prisma.delivery.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: {
      createdAt: new Date("2026-11-22T21:30:00Z"),
      availableAt: new Date("2026-11-22T21:30:00Z"),
    },
  });
  let emits = 0;
  let last: { digest?: boolean; deliveryIds?: string[] } = {};
  const emit = (_user: string, _event: string, p: unknown) => {
    emits++;
    last = p as typeof last;
    return 1;
  };
  await drainDeliveries({
    userId,
    now: new Date("2026-11-22T23:00:00Z"),
    emit,
  });
  expect(emits).toBe(0);
  await drainDeliveries({
    userId,
    now: new Date("2026-11-23T08:00:00Z"),
    emit,
  });
  expect(emits).toBe(1);
  expect(last.digest).toBe(true);
  expect(last.deliveryIds).toHaveLength(2);
  await acknowledgeDelivery(
    userId,
    rows.map((r) => r.id),
  );
});
