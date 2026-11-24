import {
  budgetStatus,
  budgetView,
  getPrismaClient,
  recordBudgetRejection,
} from "@mimir/backend-core";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.js";
const prisma = getPrismaClient();
export const approvalsRouter: Router = Router();
approvalsRouter.get("/approvals", requireAuth, async (req, res) => {
  const conversationId =
    typeof req.query.conversationId === "string"
      ? req.query.conversationId
      : "";
  const approvals = await prisma.actionApproval.findMany({
    where: { run: { userId: req.userId!, conversationId } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      toolName: true,
      arguments: true,
      argumentHash: true,
      risk: true,
      status: true,
      expiresAt: true,
      reason: true,
    },
  });
  res.json({ approvals });
});
approvalsRouter.post(
  "/approvals/:id/decision",
  requireAuth,
  async (req, res) => {
    const parsed = z
      .strictObject({
        approved: z.boolean(),
        argumentHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: "Invalid approval decision" } });
      return;
    }
    const value = parsed.data;
    // Rejecting an action is always allowed. Its follow-up can wait for reset.
    const budget = await budgetStatus(req.userId!);
    if (budget.state === "hard" && value.approved) {
      recordBudgetRejection("approval");
      res.status(429).json({
        error: {
          code: "BUDGET_EXCEEDED",
          message:
            "Today's usage limit is reached. Decide after it resets at midnight UTC.",
        },
        budget: budgetView(budget),
      });
      return;
    }
    const outcome = await prisma.$transaction(async (tx) => {
      const approval = await tx.actionApproval.findFirst({
        where: { id: String(req.params.id), run: { userId: req.userId! } },
        include: { run: true },
      });
      if (!approval) return 404;
      if (approval.argumentHash !== value.argumentHash) return 409;
      const status = value.approved ? "approved" : "rejected";
      if (approval.status === status) return 202;
      if (approval.status !== "pending") return 409;
      if (approval.expiresAt <= new Date()) return 410;
      const changed = await tx.actionApproval.updateMany({
        where: {
          id: approval.id,
          status: "pending",
          argumentHash: value.argumentHash,
        },
        data: { status, decidedAt: new Date() },
      });
      if (!changed.count) return 409;
      const input = await tx.inboxInput.create({
        data: {
          conversationId: approval.run.conversationId,
          kind: "approval_answer",
          source: "user:approval-card",
          dedupeKey: "approval:" + approval.id,
          payload: {
            kind: "approval_answer",
            approvalId: approval.id,
            approved: value.approved,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: "conversation_turn",
          payload: {
            conversationId: approval.run.conversationId,
            userId: req.userId!,
            inputId: input.id,
          },
        },
      });
      return 202;
    });
    res.status(outcome).json(
      outcome === 202
        ? { queued: true }
        : {
            error: {
              message:
                outcome === 404
                  ? "Approval not found"
                  : outcome === 410
                    ? "This approval expired; request a new action"
                    : "This action changed or already has a decision",
            },
          },
    );
  },
);
