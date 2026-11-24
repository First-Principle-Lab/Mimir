import { getPrismaClient } from "@mimir/backend-core";
import { ToolError } from "@mimir/tasks";
import { z } from "zod";
import { argumentHash, executeJournaled } from "./actions.js";
import { payloadOf, type Input } from "./inbox.js";
import {
  renderToolResult,
  type ToolRunContext,
  type ToolSpec,
} from "./tools.js";
const prisma = getPrismaClient();
export async function resumeApproval(
  input: Input,
  specs: ToolSpec[],
  ctx: ToolRunContext,
): Promise<string> {
  const payload = payloadOf(input);
  if (payload.kind !== "approval_answer")
    throw new Error("Expected an approval answer");
  const terminal = (message: string) => {
    if (ctx.safety) ctx.safety.mutationsStopped = true;
    return message;
  };
  const approval = await prisma.actionApproval.findFirst({
    where: {
      id: payload.approvalId,
      runId: ctx.runId,
      run: { conversationId: ctx.conversationId, userId: ctx.userId },
    },
  });
  if (!approval)
    return terminal("The approval no longer exists. No action was executed.");
  if (!payload.approved || approval.status === "rejected")
    return terminal(
      "The user declined the action. It was not executed. Acknowledge the decision.",
    );
  if (approval.status === "succeeded") {
    const recorded = await prisma.actionAttempt.findUnique({
      where: {
        runId_toolCallId: {
          runId: approval.runId,
          toolCallId: approval.toolCallId,
        },
      },
    });
    if (ctx.safety) ctx.safety.tainted = true;
    return (
      "This action already succeeded; do not execute it again. Recorded result:\n" +
      renderToolResult(
        { name: approval.toolName, resultTrust: "untrusted" },
        recorded?.result,
      )
    );
  }
  if (approval.status === "failed")
    return terminal(
      "The provider rejected this action earlier, so nothing changed. A new user instruction can request a corrected action.",
    );
  if (approval.status !== "approved")
    return terminal(
      "This approval is " +
        approval.status +
        ". Do not repeat the action; report its recorded status.",
    );
  if (approval.expiresAt <= new Date()) {
    await prisma.actionApproval.updateMany({
      where: { id: approval.id, status: "approved" },
      data: { status: "expired" },
    });
    return terminal("The approval expired. No action was executed.");
  }
  const spec = specs.find(
    (s) => s.name === approval.toolName && s.provenance === approval.provenance,
  );
  try {
    if (!spec || argumentHash(approval.arguments) !== approval.argumentHash)
      throw new Error("Approved capability or arguments changed");
    const prepared = spec.prepare
      ? await spec.prepare(approval.arguments, ctx)
      : approval.arguments;
    if (argumentHash(prepared) !== approval.argumentHash)
      throw new Error("The approved action changed");
  } catch {
    await prisma.actionApproval.updateMany({
      where: { id: approval.id, status: "approved" },
      data: { status: "canceled" },
    });
    return terminal(
      "The approved action is no longer available or its details changed. Nothing ran; ask for an updated instruction before requesting a fresh card.",
    );
  }
  if (!spec) return terminal("The tool is unavailable. No action ran.");
  await ctx.assertOwned?.();
  const claimed = await prisma.actionApproval.updateMany({
    where: { id: approval.id, status: "approved" },
    data: { status: "executing" },
  });
  if (!claimed.count)
    return terminal(
      "The action already has a decision or is running; do not repeat it.",
    );
  // A provider may return untrusted text in either its result or its error.
  // Mark the context before execution, as the normal tool executor does.
  if (ctx.safety && spec.resultTrust === "untrusted") ctx.safety.tainted = true;
  try {
    const result = await executeJournaled(spec, approval.arguments, {
      ...ctx,
      toolCallId: approval.toolCallId,
    });
    await prisma.actionApproval.update({
      where: { id: approval.id },
      data: { status: "succeeded" },
    });
    return (
      "The approved action executed. Report only the actual result:\n" +
      renderToolResult(spec, result)
    );
  } catch (error) {
    const attempt = await prisma.actionAttempt.findUnique({
      where: {
        runId_toolCallId: {
          runId: approval.runId,
          toolCallId: approval.toolCallId,
        },
      },
    });
    const rejected = attempt?.status === "failed";
    await prisma.actionApproval.update({
      where: { id: approval.id },
      data: { status: rejected ? "failed" : "interrupted" },
    });
    if (rejected)
      return terminal(
        "The provider rejected the approved action, so nothing changed. Tell the user why and offer a corrected action. Provider error:\n" +
          renderToolResult(spec, error instanceof Error ? error.message : ""),
      );
    return terminal(
      "The approved action was interrupted. Its outcome may be uncertain and it will not be retried automatically. Tell the user to verify with the provider. Provider error:\n" +
        renderToolResult(spec, error instanceof Error ? error.message : ""),
    );
  }
}

// Open cards in this conversation, for the per-turn runtime context. Only ids,
// tool names and ages: the arguments are already in the transcript.
export async function openApprovals(conversationId: string, userId: string) {
  return prisma.actionApproval.findMany({
    where: {
      run: { conversationId, userId },
      status: { in: ["pending", "approved"] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, toolName: true, status: true, createdAt: true },
  });
}

const cancelArgs = z.strictObject({ approval_id: z.string().min(1).max(200) });
export const cancelApprovalSpec: ToolSpec = {
  name: "cancel_approval",
  label: "Withdraw an approval card",
  description:
    "Withdraw a pending approval card that the user corrected, replaced or no longer wants. The action never runs. Propose the corrected action separately if there is one.",
  parameters: cancelArgs.toJSONSchema(),
  risk: "write_reversible_self",
  sideEffect: "reversible",
  idempotent: true,
  provenance: "mimir:harness/internal",
  resultTrust: "trusted",
  outputMaxChars: 1000,
  // Refusals happen here, before the action journal.
  prepare: async (raw, ctx) => {
    const { approval_id } = cancelArgs.parse(raw);
    const card = await prisma.actionApproval.findFirst({
      where: {
        id: approval_id,
        run: { conversationId: ctx.conversationId, userId: ctx.userId },
      },
    });
    if (!card) throw new ToolError("validation", "No such approval card");
    if (!["pending", "approved"].includes(card.status))
      throw new ToolError(
        "validation",
        `That card is already ${card.status}; nothing to withdraw`,
      );
    return { approval_id };
  },
  execute: async (raw, ctx) => {
    const { approval_id } = cancelArgs.parse(raw);
    const { count } = await prisma.actionApproval.updateMany({
      where: {
        id: approval_id,
        run: { conversationId: ctx.conversationId, userId: ctx.userId },
        status: { in: ["pending", "approved"] },
      },
      data: { status: "canceled" },
    });
    return { withdrawn: count === 1 };
  },
};
