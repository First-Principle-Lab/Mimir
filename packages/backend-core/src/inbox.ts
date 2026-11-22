import { z } from "zod";
import { getPrismaClient } from "./prisma.js";

export const inboxPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    text: z.string().min(1),
    control: z.enum(["stop"]).optional(),
  }),
  z.object({
    kind: z.literal("agent_result"),
    agentRunId: z.string(),
    status: z.enum(["succeeded", "failed", "interrupted"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("event"),
    routineId: z.string(),
    key: z.string(),
    instruction: z.string(),
  }),
  z.object({
    kind: z.literal("routine_fire"),
    routineId: z.string(),
    key: z.string(),
    instruction: z.string(),
  }),
  z.object({
    kind: z.literal("approval_answer"),
    approvalId: z.string(),
    approved: z.boolean(),
  }),
]);
export type InboxPayload = z.infer<typeof inboxPayload>;

// Internal ingress only. HTTP never accepts a caller-provided source, kind or
// ambient instruction. The producer and dedupe key survive queue/job loss.
export async function postInbox(input: {
  conversationId: string;
  userId: string;
  source: string;
  dedupeKey: string;
  payload: InboxPayload;
}): Promise<string> {
  const payload = inboxPayload.parse(input.payload);
  return getPrismaClient().$transaction(async (tx) => {
    const owner = await tx.conversation.findFirst({
      where: { id: input.conversationId, userId: input.userId },
    });
    if (!owner)
      throw new Error("Inbox conversation does not belong to this user");
    const row = await tx.inboxInput.upsert({
      where: {
        conversationId_dedupeKey: {
          conversationId: input.conversationId,
          dedupeKey: input.dedupeKey,
        },
      },
      create: {
        conversationId: input.conversationId,
        source: input.source,
        kind: payload.kind,
        payload,
        dedupeKey: input.dedupeKey,
      },
      update: {},
    });
    if (row.status === "pending")
      await tx.outboxEvent.create({
        data: {
          eventType: "conversation_turn",
          payload: {
            conversationId: input.conversationId,
            userId: input.userId,
            inputId: row.id,
          },
        },
      });
    return row.id;
  });
}

export const INBOX_QUIET_MS = 1000;
export const INBOX_MAX_WAIT_MS = 10_000;
export function burstReadyAt(first: Date, last: Date): number {
  return Math.min(
    first.getTime() + INBOX_MAX_WAIT_MS,
    last.getTime() + INBOX_QUIET_MS,
  );
}

export async function recordNotificationReceipt(
  messageId: string,
  db: Pick<
    ReturnType<typeof getPrismaClient>,
    "agentRun" | "inboxInput" | "routineScratch"
  > = getPrismaClient(),
): Promise<void> {
  const run = await db.agentRun.findFirst({
    where: { replyMessageId: messageId },
  });
  if (!run) return;
  const inputs = await db.inboxInput.findMany({ where: { runId: run.id } });
  for (const input of inputs) {
    const p = inboxPayload.parse(input.payload);
    if (p.kind === "event" || p.kind === "routine_fire")
      await db.routineScratch.updateMany({
        where: { routineId: p.routineId },
        data: { lastToldKey: p.key },
      });
  }
}
