import { createHash } from "node:crypto";
import { getPrismaClient, type InputJsonValue } from "@mimir/backend-core";
import { ConnectionError, ProviderError } from "@mimir/connection-provider";
import { ToolError } from "@mimir/tasks";
import {
  isReadOnly,
  type ToolRisk,
  type ToolRunContext,
  type ToolSpec,
} from "./tools.js";

const prisma = getPrismaClient();
export function canonical(value: unknown): string {
  if (value === undefined) throw new Error("Action arguments must be JSON");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
export const argumentHash = (args: unknown): string =>
  createHash("sha256").update(canonical(args)).digest("hex");

export function decideAction(
  spec: ToolSpec,
  args: unknown,
  ctx: ToolRunContext,
): {
  decision: "allow" | "approve" | "block";
  risk: ToolRisk;
  reason: string;
} {
  const risk = spec.effectiveRisk?.(args) ?? spec.risk;
  if (isReadOnly({ risk, sideEffect: spec.sideEffect }))
    return { decision: "allow", risk, reason: "read" };
  if (spec.provenance.startsWith("mimir:mcp/"))
    return { decision: "approve", risk, reason: "custom_mcp_action" };
  // Only Mimir's fixed internal capabilities can mutate without a card in an
  // ambient turn. Unknown/custom capabilities never inherit this exception.
  const internal = spec.provenance === "mimir:harness/internal";
  // Ambient work can't start durable work of its own (loop prevention).
  if (ctx.safety?.ambient && internal && spec.name === "schedule")
    return { decision: "block", risk, reason: "Schedules require a user turn" };
  if (ctx.safety?.ambient && internal && spec.name === "spawn_agent")
    return {
      decision: "block",
      risk,
      reason: "Background agents can only be started from a user turn",
    };
  if (ctx.safety?.ambient && !internal)
    return { decision: "approve", risk, reason: "unattended_action" };
  if (risk === "write_reversible_self" && internal)
    return { decision: "allow", risk, reason: "internal_reversible" };
  if (risk === "write_reversible_self" && !ctx.safety?.tainted)
    return { decision: "allow", risk, reason: "reversible_self" };
  return {
    decision: "approve",
    risk,
    reason: ctx.safety?.tainted ? "untrusted_content_in_context" : "risk_tier",
  };
}

export function actionKey(
  spec: ToolSpec,
  args: unknown,
  ctx: ToolRunContext,
): string {
  return (
    spec.idempotencyKey?.(args, ctx) ??
    [ctx.runId, spec.name, argumentHash(args)].join(":")
  );
}

export async function requestApproval(
  spec: ToolSpec,
  args: unknown,
  ctx: ToolRunContext,
) {
  if (!ctx.runId || !ctx.toolCallId)
    throw new Error("Approval requires a journaled run");
  const policy = decideAction(spec, args, ctx);
  const hash = argumentHash(args);
  const id = "approval-" + argumentHash([ctx.runId, spec.name, hash]);
  const row = await prisma.$transaction(async (tx) => {
    const approval = await tx.actionApproval.upsert({
      where: { id },
      create: {
        id,
        runId: ctx.runId!,
        toolCallId: ctx.toolCallId!,
        toolName: spec.name,
        provenance: spec.provenance,
        arguments: args as InputJsonValue,
        argumentHash: hash,
        risk: policy.risk,
        reason: policy.reason,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      },
      update: {},
    });
    await tx.agentRun.update({
      where: { id: ctx.runId },
      data: { status: "waiting_human", finishedAt: null },
    });
    return approval;
  });
  if (ctx.safety) ctx.safety.pendingApproval = row.status === "pending";
  return {
    approvalRequired: true,
    approvalId: row.id,
    status: row.status,
    message:
      "The action has not run. Its exact arguments are in the approval card. Wait for that decision; do not retry or replace the action.",
  };
}

// Errors that prove an action took no effect: the provider answered with a
// rejection (bad request, auth, rate limit, not found or conflict), the
// connection was unusable, or a pre-flight check failed before any request.
// Tools throw ToolError("validation") only before reaching their provider.
// Anything else (timeouts, 5xx, lost responses) leaves the outcome uncertain.
export function rejectedBeforeEffect(error: unknown): boolean {
  if (error instanceof ConnectionError) return true;
  if (error instanceof ProviderError)
    return error.kind === "validation_failed" || error.kind === "rate_limited";
  return error instanceof ToolError && error.kind === "validation";
}

// Called only while holding the conversation lease. A crashed or aborted call
// may have reached its provider, so uncertainty is terminal for this key.
export async function interruptStartedActions(runId: string): Promise<void> {
  await prisma.actionAttempt.updateMany({
    where: { runId, status: "started" },
    data: { status: "interrupted", finishedAt: new Date() },
  });
  const approvals = await prisma.actionApproval.findMany({
    where: { runId, status: "executing" },
  });
  for (const approval of approvals) {
    const attempt = await prisma.actionAttempt.findUnique({
      where: { runId_toolCallId: { runId, toolCallId: approval.toolCallId } },
    });
    await prisma.actionApproval.updateMany({
      where: { id: approval.id, status: "executing" },
      data: {
        status:
          attempt?.status === "succeeded" || attempt?.status === "failed"
            ? attempt.status
            : "interrupted",
      },
    });
  }
}

export async function executeJournaled(
  spec: ToolSpec,
  args: unknown,
  ctx: ToolRunContext,
): Promise<unknown> {
  if (!ctx.runId || !ctx.toolCallId)
    throw new Error("Mutations require a journaled run");
  ctx.signal?.throwIfAborted();
  await ctx.assertOwned?.();
  ctx.signal?.throwIfAborted();
  const key = actionKey(spec, args, ctx);
  // INSERT, never upsert-and-execute: only the insert's winner may invoke the
  // provider, including across processes and new model tool-call IDs.
  try {
    await prisma.actionAttempt.create({
      data: {
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
        toolName: spec.name,
        idempotencyKey: key,
        arguments: args as InputJsonValue,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const previous = await prisma.actionAttempt.findFirst({
      where: {
        OR: [
          { idempotencyKey: key },
          { runId: ctx.runId, toolCallId: ctx.toolCallId },
        ],
      },
    });
    if (
      previous &&
      (previous.toolName !== spec.name ||
        argumentHash(previous.arguments) !== argumentHash(args))
    )
      throw new ToolError(
        "blocked",
        "An action key or tool-call ID was reused with different arguments; nothing was executed",
      );
    if (previous?.status === "succeeded") return previous.result;
    // A rejected attempt changed nothing, so the same action may run again.
    const rearmed =
      previous?.status === "failed" &&
      (
        await prisma.actionAttempt.updateMany({
          where: { idempotencyKey: key, status: "failed" },
          data: { status: "started", finishedAt: null },
        })
      ).count === 1;
    if (!rearmed)
      throw new ToolError(
        "blocked",
        "This action was interrupted or is already running. It will not be retried automatically. Verify its outcome with the provider before starting a new action.",
      );
  }
  let onAbort: (() => void) | undefined;
  try {
    ctx.signal?.throwIfAborted();
    await ctx.assertOwned?.();
    ctx.signal?.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(new Error("Action interrupted; outcome uncertain"));
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([spec.execute(args, ctx), aborted]);
    ctx.signal?.throwIfAborted();
    await ctx.assertOwned?.();
    const text = JSON.stringify(result ?? null);
    const stored =
      text.length > spec.outputMaxChars
        ? { summary: text.slice(0, spec.outputMaxChars) }
        : JSON.parse(text);
    await prisma.actionAttempt.update({
      where: { idempotencyKey: key },
      data: { status: "succeeded", result: stored, finishedAt: new Date() },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (rejectedBeforeEffect(error) && !ctx.signal?.aborted) {
      await prisma.actionAttempt.update({
        where: { idempotencyKey: key },
        data: {
          status: "failed",
          result: { error: message },
          finishedAt: new Date(),
        },
      });
      throw new ToolError(
        "validation",
        "The provider rejected the action, so nothing changed: " + message,
      );
    }
    await prisma.actionAttempt.update({
      where: { idempotencyKey: key },
      data: { status: "interrupted", finishedAt: new Date() },
    });
    throw new ToolError(
      "blocked",
      "Action interrupted; it may have reached the provider and will not be retried automatically. " +
        message,
    );
  } finally {
    if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
  }
}

export async function invokeTool(
  spec: ToolSpec,
  raw: unknown,
  ctx: ToolRunContext,
): Promise<unknown> {
  ctx.signal?.throwIfAborted();
  await ctx.assertOwned?.();
  const args = spec.prepare ? await spec.prepare(raw, ctx) : raw;
  ctx.signal?.throwIfAborted();
  const policy = decideAction(spec, args, ctx);
  if (policy.decision === "block")
    throw new ToolError("blocked", policy.reason);
  if (policy.decision === "approve") return requestApproval(spec, args, ctx);
  if (spec.resultTrust === "untrusted" && ctx.safety) ctx.safety.tainted = true;
  if (isReadOnly(spec)) return spec.execute(args, ctx);
  return executeJournaled(spec, args, ctx);
}
