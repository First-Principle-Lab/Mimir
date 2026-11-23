import { getLogger, getPrismaClient, trackEvent } from "@mimir/backend-core";
import { messageSchema } from "@mimir/zod-schemas";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";
import { enqueueTurn } from "../infra/turns.js";

const prisma = getPrismaClient();

type StoredMessage = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
  promptTokens: number | null;
  completionTokens: number | null;
  tokenCount: number | null;
  durationMs: number | null;
  clientMessageId: string | null;
  parentMessageId: string | null;
  replyToMessageIds?: string[];
  toolCalls?: unknown;
};

function toWire(m: StoredMessage) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    totalTokens: m.tokenCount,
    durationMs: m.durationMs,
    toolCalls: m.toolCalls ?? null,
    clientMessageId: m.clientMessageId,
    parentMessageId: m.parentMessageId,
    replyToMessageIds: m.replyToMessageIds ?? [],
  };
}

// The eval runner supplies a private queue; normal API intake always uses the
// production enqueuer. Both paths retain the same transaction and replay rules.
export function createMessageRouter(
  enqueue: typeof enqueueTurn = enqueueTurn,
): Router {
  const messageRouter: Router = Router();

  // POST /api/v1/message
  // Records the user's message and hands the turn to the worker's harness. The
  // reply arrives over the socket (new_message) once the harness settles, so this
  // returns 202 right away. Retries with the same clientMessageId are idempotent:
  // an answered message returns its reply (200), an unanswered one 202 again.
  messageRouter.post("/message", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Not authenticated" },
      });
      return;
    }
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid message payload" },
      });
      return;
    }
    const { conversationId, content, clientMessageId } = parsed.data;
    // A standalone stop is a fixed control command, never an intent classifier.
    const stop =
      parsed.data.control === "stop" || content.trim().toLowerCase() === "stop";

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation || conversation.userId !== userId) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });
      return;
    }

    const existing = await prisma.message.findUnique({
      where: {
        conversationId_clientMessageId: { conversationId, clientMessageId },
      },
    });
    if (existing) {
      const reply = await prisma.message.findFirst({
        where: {
          role: "assistant",
          conversationId,
          OR: [
            { parentMessageId: existing.id },
            { replyToMessageIds: { has: existing.id } },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
      getLogger().info(
        { conversationId, clientMessageId, answered: !!reply },
        "user message replayed (idempotent hit)",
      );
      if (reply) {
        res
          .status(200)
          .json({ message: toWire(existing), reply: toWire(reply) });
        return;
      }
      await enqueue({ conversationId, userId, messageId: existing.id });
      res.status(202).json({ message: toWire(existing), status: "queued" });
      return;
    }

    let userMsg: StoredMessage;
    let outboxId: string;
    try {
      // The message and its turn's outbox row commit together, so a crash right
      // after this can't leave a message the harness never hears about.
      [userMsg, outboxId] = await prisma.$transaction(async (tx) => {
        // An explicit stop withdraws every open card. Other messages leave
        // cards open; the model cancels a card it is correcting.
        if (stop) {
          await tx.actionApproval.updateMany({
            where: {
              run: { conversationId, userId },
              status: { in: ["pending", "approved"] },
            },
            data: { status: "canceled" },
          });
          await tx.agentRun.updateMany({
            where: { conversationId, userId, status: "waiting_human" },
            data: { status: "interrupted", finishedAt: new Date() },
          });
        }
        const msg = await tx.message.create({
          data: {
            conversationId,
            clientMessageId,
            role: "user",
            content,
            status: "complete",
          },
        });
        await tx.inboxInput.create({
          data: {
            conversationId,
            kind: "user",
            source: "user:http",
            messageId: msg.id,
            dedupeKey: `user:${msg.id}`,
            payload: {
              kind: "user",
              text: content,
              ...(stop ? { control: "stop" } : {}),
            },
          },
        });
        const row = await tx.outboxEvent.create({
          data: {
            eventType: "conversation_turn",
            payload: { conversationId, userId, messageId: msg.id },
          },
        });
        return [msg, row.id] as const;
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        // A concurrent retry with the same clientMessageId won the insert.
        res.status(409).json({
          error: {
            code: "CONFLICT",
            message: "Message already being processed",
          },
        });
        return;
      }
      throw e;
    }

    if (await enqueue({ conversationId, userId, messageId: userMsg.id })) {
      await prisma.outboxEvent
        .update({ where: { id: outboxId }, data: { processedAt: new Date() } })
        .catch(() => {});
    }
    getLogger().info(
      { conversationId, messageId: userMsg.id },
      "user message recorded; turn queued",
    );
    await trackEvent(userId, "chat_message_sent", {
      conversationId,
      contentLength: content.length,
    });
    res.status(202).json({ message: toWire(userMsg), status: "queued" });
  });

  // GET /api/v1/conversation — single persistent thread (find-or-create).
  messageRouter.get("/conversation", requireAuth, async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Not authenticated" },
      });
      return;
    }
    let conversation = await prisma.conversation.findFirst({
      where: { userId },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({ data: { userId } });
    }
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    getLogger().info(
      { conversationId: conversation.id, messageCount: messages.length },
      "conversation loaded",
    );
    res.json({
      conversation: { id: conversation.id, messages: messages.map(toWire) },
    });
  });

  return messageRouter;
}

export const messageRouter = createMessageRouter();
