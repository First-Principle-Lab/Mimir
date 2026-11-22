import { randomUUID } from "node:crypto";
import {
  deliveryAvailableAt,
  getConfig,
  getLogger,
  getPrismaClient,
  recordNotificationReceipt,
} from "@mimir/backend-core";
import { sendPushToSubscriptions } from "../routes/push.js";
import { emitToUser } from "./socket.js";

const prisma = getPrismaClient();
export async function acknowledgeDelivery(
  userId: string,
  ids: string[],
): Promise<void> {
  const owned = await prisma.delivery.findMany({
    where: { id: { in: ids.slice(0, 100) }, userId },
    select: { id: true, messageId: true },
  });
  await prisma.$transaction(async (tx) => {
    for (const row of owned) {
      await tx.deliveryReceipt.upsert({
        where: {
          deliveryId_channel: { deliveryId: row.id, channel: "client" },
        },
        create: { deliveryId: row.id, channel: "client" },
        update: {},
      });
      await tx.delivery.update({
        where: { id: row.id },
        data: { status: "delivered", leaseUntil: null, leaseToken: null },
      });
      await recordNotificationReceipt(row.messageId, tx);
    }
  });
}

export async function drainDeliveries(
  options: {
    now?: Date;
    userId?: string;
    emit?: typeof emitToUser;
    push?: typeof sendPushToSubscriptions;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const rows = await prisma.delivery.findMany({
    where: {
      userId: options.userId,
      status: { in: ["pending", "sending"] },
      availableAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const user = await prisma.user.findUnique({
      where: { id: row.userId },
      select: { timezone: true, notificationPreferences: true },
    });
    const at = deliveryAvailableAt({
      now,
      createdAt: row.createdAt,
      ambient: row.ambient,
      urgency: row.urgency,
      timezone: user?.timezone ?? null,
      preferences: user?.notificationPreferences,
    });
    if (at > now) {
      await prisma.delivery.updateMany({
        where: { id: row.id, status: "pending" },
        data: { availableAt: at },
      });
      continue;
    }
    const key =
      row.ambient && row.urgency === "low"
        ? `${row.userId}:${row.conversationId}:digest`
        : row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let sent = 0;
  for (const group of groups.values()) {
    const leaseToken = randomUUID();
    const claimed: typeof rows = [];
    for (const row of group) {
      const update = await prisma.delivery.updateMany({
        where: {
          id: row.id,
          status: { in: ["pending", "sending"] },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        data: {
          status: "sending",
          leaseToken,
          leaseUntil: new Date(now.getTime() + 30_000),
          attempts: { increment: 1 },
        },
      });
      if (update.count) claimed.push(row);
    }
    if (!claimed.length) continue;
    const ids = claimed.map((r) => r.id);
    const first = claimed[0]!;
    try {
      const messages = await prisma.message.findMany({
        where: { id: { in: claimed.map((r) => r.messageId) } },
        orderBy: { createdAt: "asc" },
      });
      const content = messages
        .map((m) => m.content.replace(/\s+/g, " "))
        .join(" · ")
        .slice(0, 160);
      const payload = {
        conversationId: first.conversationId,
        messageId: first.messageId,
        deliveryIds: ids,
        content,
        digest: claimed.length > 1,
      };
      const sockets = (options.emit ?? emitToUser)(
        first.userId,
        "new_message",
        payload,
      );
      const channel = sockets
        ? "socket"
        : (await (options.push ?? sendPushToSubscriptions)(
              first.userId,
              getConfig(),
              {
                title: claimed.length > 1 ? "Mimir digest" : "Mimir",
                body: content,
                tag: ids.join("-"),
                url: "/chat",
              },
            ))
          ? "push"
          : "none";
      await prisma.$transaction(async (tx) => {
        for (const row of claimed) {
          if (channel !== "none")
            await tx.deliveryReceipt.upsert({
              where: { deliveryId_channel: { deliveryId: row.id, channel } },
              create: { deliveryId: row.id, channel },
              update: {},
            });
          if (channel === "push")
            await recordNotificationReceipt(row.messageId, tx);
          // Socket emission waits for a client ACK; a publish/emit alone is not
          // proof of receipt. Push records provider acceptance.
          await tx.delivery.updateMany({
            where: { id: row.id, leaseToken },
            data: {
              status: channel === "push" ? "delivered" : "pending",
              availableAt: new Date(
                now.getTime() + (channel === "socket" ? 30_000 : 60_000),
              ),
              leaseUntil: null,
              leaseToken: null,
            },
          });
        }
      });
      if (channel !== "none") sent += claimed.length;
    } catch (error) {
      await prisma.delivery.updateMany({
        where: { id: { in: ids }, leaseToken },
        data: {
          status: "pending",
          availableAt: new Date(now.getTime() + 60_000),
          leaseUntil: null,
          leaseToken: null,
        },
      });
      getLogger().warn(
        { err: error, deliveryIds: ids },
        "delivery failed; retained for retry",
      );
    }
  }
  return sent;
}

export function startDeliveryQueue(): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void drainDeliveries()
      .catch((error) =>
        getLogger().error({ err: error }, "delivery queue drain failed"),
      )
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
