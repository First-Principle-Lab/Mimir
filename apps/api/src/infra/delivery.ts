import { getConfig, getLogger, recordDelivery } from "@mimir/backend-core";
import { sendPushToSubscriptions } from "../routes/push.js";
import { emitToUser } from "./socket.js";

export type DeliveryChannel = "socket" | "push" | "none";

// 7.4 — the single delivery decision point for ad-hoc user events (queued
// assistant messages go through delivery-queue.ts). One API instance handles
// each event (see initPubSub). Order: a live socket on any instance → web
// push. If neither reaches the user, "none" — the message stays in the thread
// and shows on next open. No email: email is a watched source (Mimir's job is
// to surface its contents in-app), not a delivery channel.
export async function deliverToUser(
  userId: string,
  eventName: string,
  payload: { [k: string]: unknown },
  emit: (
    userId: string,
    event: string,
    payload: unknown,
  ) => Promise<number> = emitToUser,
): Promise<DeliveryChannel> {
  const delivered = await emit(userId, eventName, payload);
  if (delivered > 0) {
    recordDelivery("socket");
    return "socket";
  }

  const cfg = getConfig();
  const body = typeof payload.content === "string" ? String(payload.content) : eventName;
  const pushed = await sendPushToSubscriptions(userId, cfg, { title: "Mimir", body });
  if (pushed > 0) {
    recordDelivery("push");
    return "push";
  }

  recordDelivery("none");
  getLogger().info({ userId, eventName }, "no delivery channel; message persisted in thread");
  return "none";
}
