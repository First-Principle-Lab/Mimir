import { getPrismaClient } from "@mimir/backend-core";
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
  const approval = await prisma.actionApproval.findFirst({
    where: {
      id: payload.approvalId,
      runId: ctx.runId,
      run: { conversationId: ctx.conversationId, userId: ctx.userId },
    },
  });
  if (!approval)
    return "The approval no longer exists. No action was executed.";
  if (!payload.approved || approval.status === "rejected")
    return "The user declined the action. It was not executed. Acknowledge the decision.";
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
  if (approval.status !== "approved")
    return (
      "This approval is " +
      approval.status +
      ". Do not repeat the action; report its recorded status."
    );
  if (approval.expiresAt <= new Date()) {
    await prisma.actionApproval.updateMany({
      where: { id: approval.id, status: "approved" },
      data: { status: "expired" },
    });
    return "The approval expired. No action was executed.";
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
    return "The approved action is no longer available or its details changed. Nothing ran; request a fresh card.";
  }
  if (!spec) return "The tool is unavailable. No action ran.";
  await ctx.assertOwned?.();
  const claimed = await prisma.actionApproval.updateMany({
    where: { id: approval.id, status: "approved" },
    data: { status: "executing" },
  });
  if (!claimed.count)
    return "The action already has a decision or is running; do not repeat it.";
  // A provider may return untrusted text in either its result or its error.
  // Mark the context before execution, as the normal tool executor does.
  if (ctx.safety && spec.resultTrust === "untrusted")
    ctx.safety.tainted = true;
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
    await prisma.actionApproval.update({
      where: { id: approval.id },
      data: { status: "interrupted" },
    });
    return (
      "The approved action was interrupted. Its outcome may be uncertain and it will not be retried automatically. Tell the user to verify with the provider. Provider error:\n" +
      renderToolResult(spec, error instanceof Error ? error.message : "")
    );
  }
}
