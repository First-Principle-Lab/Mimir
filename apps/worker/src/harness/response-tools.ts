import { getPrismaClient } from "@mimir/backend-core";
import { z } from "zod";
import type { ToolSpec } from "./tools.js";
import { payloadOf, type Input } from "./inbox.js";
import { scheduleTool, channelReadTool } from "../routines/routines.js";

const prisma = getPrismaClient();
export function responseTools(opts: {
  userId: string;
  conversationId: string;
  runId: string;
  inputs: Input[];
  ambient: boolean;
  response: { sent: boolean; interrupted: boolean };
  assertOwned: () => Promise<void>;
}): ToolSpec[] {
  const notification = z.object({
    text: z.string().trim().min(1).max(8000),
    urgency: z.enum(["low", "normal", "urgent"]),
    reason_code: z.enum([
      "requested_reminder",
      "relevant_change",
      "task_completed",
      "needs_attention",
    ]),
  });
  return [
    channelReadTool(opts),
    ...(opts.ambient
      ? [
          {
            name: "send_to_user",
            label: "Notify the user",
            description:
              "Deliver a warranted ambient notification. Only notify for a requested reminder, a relevant new change, a completed requested task or something that needs attention. Nothing new, irrelevant or duplicate results should finish with NO_REPLY. Use urgent only for time-critical issues; low joins the next digest. One notification per turn, combine related findings.",
            parameters: notification.toJSONSchema(),
            risk: "write_reversible_self",
            sideEffect: "reversible",
            idempotent: true,
            provenance: "mimir:harness/internal",
            resultTrust: "trusted",
            outputMaxChars: 2000,
            execute: async (args: unknown) => {
              const value = notification.parse(args);
              await opts.assertOwned();
              if (opts.response.interrupted) throw new Error("Run interrupted");
              const routineIds = [
                ...new Set(
                  opts.inputs.flatMap((input) => {
                    const p = payloadOf(input);
                    return p.kind === "event" || p.kind === "routine_fire"
                      ? [p.routineId]
                      : [];
                  }),
                ),
              ];
              if (
                routineIds.length &&
                (await prisma.routine.count({
                  where: {
                    id: { in: routineIds },
                    userId: opts.userId,
                    conversationId: opts.conversationId,
                    status: "active",
                  },
                })) !== routineIds.length
              )
                throw new Error(
                  "The user canceled or disabled this routine; do not notify",
                );
              const id = `notification-${opts.runId}`;
              await prisma.$transaction(async (tx) => {
                const message = await tx.message.upsert({
                  where: { id },
                  create: {
                    id,
                    conversationId: opts.conversationId,
                    role: "assistant",
                    content: value.text,
                  },
                  update: {},
                });
                await tx.delivery.upsert({
                  where: { messageId: id },
                  create: {
                    conversationId: opts.conversationId,
                    userId: opts.userId,
                    messageId: id,
                    urgency: value.urgency,
                    reasonCode: value.reason_code,
                    ambient: true,
                  },
                  update: {},
                });
                await tx.outboxEvent.create({
                  data: {
                    eventType: "delivery_ready",
                    payload: { userId: opts.userId },
                  },
                });
                await tx.agentRun.update({
                  where: { id: opts.runId },
                  data: { replyMessageId: message.id },
                });
              });
              opts.response.sent = true;
              return { queued: true, messageId: id };
            },
          } satisfies ToolSpec,
        ]
      : [scheduleTool(opts)]),
  ];
}
