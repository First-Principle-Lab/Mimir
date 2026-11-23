import { randomUUID } from "node:crypto";
import {
  AGENT_MAX_ACTIVE_PER_USER,
  AGENT_MAX_CHILDREN,
  AGENT_MAX_DEPTH,
  AGENT_MAX_RUNNING_PER_USER,
  AGENT_RESULT_MAX_CHARS,
  AGENT_ROOT_MAX_USD,
  AGENT_ACTIVE_STATUSES,
  AGENT_STALE_MS,
  cancelAgentRuns,
  getConfig,
  getLogger,
  getPrismaClient,
  trackModelCall,
  workerSystemPrompt,
  type InputJsonValue,
  type Prisma,
} from "@mimir/backend-core";
import { ToolError } from "@mimir/tasks";
import { DelayedError, Queue, type Job } from "bullmq";
import { z } from "zod";
import { interruptStartedActions } from "./actions.js";
import { buildRuntimeContext } from "./context.js";
import { agentConfig, openSession } from "./pi-runtime.js";
import { isReadOnly, readToolsFor, type ToolSpec } from "./tools.js";

// Background agents (plan Phase 4). An interaction run spawns depth-1 agents
// that run as BullMQ jobs, so long work never holds the conversation. A depth-1
// agent may delegate in-turn to depth-2 leaves (fresh pi sessions in the same
// process, ported from @tintinweb/pi-subagents). Agents only read: writes come
// back as proposed actions. The runtime, never the agent's text, sets the
// result status and posts it to the parent conversation's inbox.

const prisma = getPrismaClient();
export const agentJobs = new Queue("harness-agents", {
  connection: { url: getConfig().REDIS_URL, maxRetriesPerRequest: null },
});
export const agentJobId = (runId: string) => "agent-" + runId;
// Shared by spawn_agent's fast path and the outbox relay, which use one jobId.
export const agentJobOptions = (runId: string) => ({
  jobId: agentJobId(runId),
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
});
const AGENT_DEFER_MS = 2_000;

export type AgentStatus =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "timeout"
  | "budget_exceeded"
  | "canceled";
export const ACTIVE = AGENT_ACTIVE_STATUSES;
export interface ProposedAction {
  tool: string;
  arguments: unknown;
  reason: string;
  // Recipients and sites the user never named in this conversation, so they
  // came from tool content or the model. Set by the runtime.
  unverifiedTargets?: string[];
}
export interface AgentOutcome {
  status: AgentStatus;
  summary: string;
  proposedActions: ProposedAction[];
}
type AgentRun = Prisma.AgentRun & {
  definition: Prisma.AgentDefinition | null;
};
// Eval runs give agents synthetic account data, as TurnOptions does for turns.
export interface AgentOptions {
  readTools?: typeof readToolsFor;
}

export const briefSchema = z.strictObject({
  objective: z.string().trim().min(1).max(4000),
  success_criteria: z.string().trim().max(2000).optional(),
  context: z.string().trim().max(8000).optional(),
  // Independent items the agent hands to one helper each.
  items: z
    .array(z.string().trim().min(1).max(500))
    .max(AGENT_MAX_CHILDREN)
    .optional()
    .describe(
      "Independent things of the same kind to check separately, one helper each (projects, people, threads). Not steps or search queries; leave empty for a single task.",
    ),
});
export type Brief = z.infer<typeof briefSchema>;

export async function findDefinition(userId: string, name: string) {
  const rows = await prisma.agentDefinition.findMany({
    where: { name, OR: [{ userId }, { userId: null }] },
  });
  return rows.find((r) => r.userId === userId) ?? rows[0] ?? null;
}

// A depth-1 run is its own root, so one query costs a whole task.
export async function treeCost(rootRunId: string): Promise<number> {
  const sum = await prisma.agentRun.aggregate({
    where: { rootRunId },
    _sum: { costUsd: true },
  });
  return sum._sum.costUsd ?? 0;
}

// Depth, fan-out, per-user and task-cost limits for a new child of `parent`.
// Tools check these in prepare, before the action journal, so a refusal is a
// plain error rather than an uncertain action; createAgentRun checks again
// under the per-user lock.
export async function assertCanStart(
  parent: Pick<Prisma.AgentRun, "id" | "userId" | "depth" | "rootRunId">,
  db: Pick<typeof prisma, "agentRun"> = prisma,
): Promise<void> {
  const depth = parent.depth + 1;
  if (depth > AGENT_MAX_DEPTH)
    throw new ToolError("blocked", "Agents at this depth cannot delegate");
  const children = await db.agentRun.count({
    where: { parentRunId: parent.id },
  });
  if (children >= AGENT_MAX_CHILDREN)
    throw new ToolError(
      "blocked",
      `This run already started ${AGENT_MAX_CHILDREN} agents; finish with what you have`,
    );
  if (depth === 1) {
    const active = await db.agentRun.count({
      where: {
        userId: parent.userId,
        trigger: "agent",
        depth: 1,
        status: { in: ACTIVE },
      },
    });
    if (active >= AGENT_MAX_ACTIVE_PER_USER)
      throw new ToolError(
        "blocked",
        `${active} background agents are already active; wait for one to finish or cancel one`,
      );
  } else {
    const spent = await db.agentRun.aggregate({
      where: { rootRunId: parent.rootRunId },
      _sum: { costUsd: true },
    });
    if ((spent._sum.costUsd ?? 0) >= AGENT_ROOT_MAX_USD)
      throw new ToolError("blocked", "This task's cost budget is used up");
  }
}

// Creates a child of `parent` after checking depth, fan-out, per-user and
// task-cost limits under a per-user lock. Depth-1 children are enqueued
// through the outbox in the same transaction.
export async function createAgentRun(opts: {
  parent: Pick<
    Prisma.AgentRun,
    "id" | "conversationId" | "userId" | "depth" | "rootRunId"
  >;
  definition: Prisma.AgentDefinition;
  brief: Brief;
}): Promise<AgentRun> {
  const { parent, definition } = opts;
  const depth = parent.depth + 1;
  if (depth > AGENT_MAX_DEPTH)
    throw new ToolError("blocked", "Agents at this depth cannot delegate");
  const id = randomUUID();
  const rootRunId = depth === 1 ? id : parent.rootRunId!;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${parent.userId}))::text`;
    await assertCanStart(parent, tx);
    const run = await tx.agentRun.create({
      data: {
        id,
        conversationId: parent.conversationId,
        userId: parent.userId,
        trigger: "agent",
        status: depth === 1 ? "queued" : "running",
        parentRunId: parent.id,
        rootRunId,
        depth,
        definitionId: definition.id,
        brief: opts.brief as InputJsonValue,
        budgetUsd: definition.maxUsd,
      },
      include: { definition: true },
    });
    if (depth === 1)
      await tx.outboxEvent.create({
        data: { eventType: "agent_run", payload: { runId: id } },
      });
    return run;
  });
}

// Cancel a run and everything under it. Depth is at most 2, so descendants
// either have it as parent or as root.
export async function cancelAgentTree(runId: string): Promise<number> {
  const count = await cancelAgentRuns(prisma, [runId]);
  // A queued job is removed; an active one sees the status and aborts.
  await agentJobs.remove(agentJobId(runId)).catch(() => 0);
  return count;
}

// Email addresses and URL hosts in a proposal that the trusted text (the
// user's own messages) doesn't mention.
export function unverifiedTargets(args: unknown, trusted: string): string[] {
  const text = JSON.stringify(args).toLowerCase();
  const known = trusted.toLowerCase();
  const targets = new Set<string>();
  for (const [email] of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))
    if (!known.includes(email)) targets.add(email);
  for (const [url] of text.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    try {
      const host = new URL(url).hostname;
      if (!known.includes(host)) targets.add(host);
    } catch {
      /* not a URL */
    }
  }
  return [...targets];
}

function proposeActionSpec(
  proposals: ProposedAction[],
  trusted: () => Promise<string>,
): ToolSpec {
  const schema = z.strictObject({
    tool: z.string().trim().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()),
    reason: z.string().trim().min(1).max(1000),
  });
  return {
    name: "propose_action",
    label: "Propose an action",
    description:
      "Record a change the work calls for (send an email, create an event or issue, edit a page) for the assistant to review. Give the exact tool name and arguments. Nothing runs: the assistant decides and the user approves any action.",
    parameters: schema.toJSONSchema(),
    // Recorded in this run's result only; there is no effect to journal.
    risk: "read_public",
    sideEffect: "none",
    idempotent: true,
    provenance: "mimir:harness/internal",
    resultTrust: "trusted",
    outputMaxChars: 1000,
    execute: async (args) => {
      if (proposals.length >= 10)
        throw new ToolError("validation", "At most 10 proposals per agent");
      const proposal: ProposedAction = schema.parse(args);
      const unverified = unverifiedTargets(proposal.arguments, await trusted());
      if (unverified.length) proposal.unverifiedTargets = unverified;
      proposals.push(proposal);
      return {
        recorded: true,
        executed: false,
        ...(unverified.length && {
          unverifiedTargets: unverified,
          warning:
            "The user never named these targets; they came from tool content.",
        }),
        note: "Proposal recorded for review. Do not describe it as done.",
      };
    },
  };
}

const delegateArgs = briefSchema.omit({ items: true }).extend({
  agent: z.string().trim().min(1).max(100).default("reader"),
});
function delegateSpec(parent: AgentRun, options: AgentOptions): ToolSpec {
  return {
    name: "delegate",
    label: "Delegate a sub-task",
    description: `Run one focused read-only sub-task in a fresh context and wait for its result. Use for independent reads that benefit from isolation: one per source or item, several in one step when they don't depend on each other. At most ${AGENT_MAX_CHILDREN} per run. Do short sequential work yourself. agent defaults to "reader".`,
    // Input mode: fields with defaults stay optional for the model.
    parameters: delegateArgs.toJSONSchema({ io: "input" }),
    risk: "write_reversible_self",
    sideEffect: "reversible",
    idempotent: true,
    provenance: "mimir:harness/internal",
    resultTrust: "untrusted",
    outputMaxChars: AGENT_RESULT_MAX_CHARS + 2000,
    prepare: async (raw) => {
      const args = delegateArgs.parse(raw);
      await assertCanStart(parent);
      return JSON.parse(JSON.stringify(args));
    },
    execute: async (raw, ctx) => {
      const { agent, ...brief } = delegateArgs.parse(raw);
      const definition = await findDefinition(parent.userId, agent);
      if (!definition)
        throw new ToolError("validation", "Unknown agent: " + agent);
      if (definition.canSpawn)
        throw new ToolError(
          "validation",
          "Delegate to a leaf agent such as reader",
        );
      const child = await createAgentRun({ parent, definition, brief });
      const outcome = await executeAgent(child, ctx.signal, options);
      await finalizeAgent(child, outcome);
      return outcome;
    },
  };
}

async function agentSpecs(
  run: AgentRun,
  proposals: ProposedAction[],
  options: AgentOptions,
): Promise<ToolSpec[]> {
  const def = run.definition!;
  const allowed = def.tools as string[];
  const specs = (await (options.readTools ?? readToolsFor)(run.userId)).filter(
    (s) =>
      isReadOnly(s) &&
      (allowed.includes("*") || allowed.includes(s.name)) &&
      (def.memoryScope !== "none" || s.name !== "memory_search"),
  );
  // Briefs and parent messages are model-written and may quote tool
  // content, so only the user's own messages vouch for a target.
  specs.push(
    proposeActionSpec(proposals, async () =>
      (
        await prisma.message.findMany({
          where: { conversationId: run.conversationId, role: "user" },
          select: { content: true },
        })
      )
        .map((m) => m.content)
        .join("\n"),
    ),
  );
  if (run.depth < AGENT_MAX_DEPTH && def.canSpawn)
    specs.push(delegateSpec(run, options));
  return specs;
}

function lastText(messages: unknown[]): string {
  const m = [...messages]
    .reverse()
    .find((x) => (x as { role?: string }).role === "assistant") as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  return (m?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

function briefText(brief: Brief, def: Prisma.AgentDefinition): string {
  return [
    "<brief>",
    "Objective: " + brief.objective,
    brief.success_criteria
      ? "Success criteria: " + brief.success_criteria
      : "",
    brief.context ? "Context from the assistant: " + brief.context : "",
    brief.items?.length
      ? "Items, one helper each (delegate them all in one step):\n" +
        brief.items.map((item) => "- " + item).join("\n")
      : "",
    "</brief>",
    `Budget: ${def.maxSteps} model steps, $${def.maxUsd} and ${def.timeoutSec} seconds.`,
  ]
    .filter(Boolean)
    .join("\n");
}
const fromParent = (texts: string[]) =>
  texts.map((t) => "Message from the assistant: " + t).join("\n\n");

export async function executeAgent(
  run: AgentRun,
  parentSignal?: AbortSignal,
  options: AgentOptions = {},
): Promise<AgentOutcome> {
  const log = getLogger().child({ agentRunId: run.id, depth: run.depth });
  const def = run.definition;
  const proposals: ProposedAction[] = [];
  const outcome = (status: AgentStatus, summary = ""): AgentOutcome => ({
    status,
    summary: summary.slice(0, AGENT_RESULT_MAX_CHARS),
    proposedActions: proposals,
  });
  if (!def) return outcome("failed", "The agent definition no longer exists.");
  const brief = briefSchema.parse(run.brief);
  // A retried job may find a delegation that was mid-flight when it crashed.
  // In-turn helpers die with the process that ran them, so any still active
  // when an attempt starts are orphans.
  await interruptStartedActions(run.id);
  await prisma.agentRun.updateMany({
    where: { parentRunId: run.id, status: { in: ACTIVE } },
    data: { status: "interrupted", finishedAt: new Date() },
  });
  if ((await treeCost(run.rootRunId!)) >= AGENT_ROOT_MAX_USD)
    return outcome("budget_exceeded");

  const user = await prisma.user.findUnique({
    where: { id: run.userId },
    select: { timezone: true },
  });
  const usage = {
    steps: run.steps,
    toolCalls: run.toolCalls,
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    costUsd: run.costUsd,
  };
  const limitUsd = run.budgetUsd ?? def.maxUsd;
  const config = agentConfig(def.modelRole);
  let session: Awaited<ReturnType<typeof openSession>>;
  let stopped: AgentStatus | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  // Spend anywhere in the task (siblings, helpers) is only known in the
  // database: settle this run's bookkeeping, then check before each tool runs.
  const guarded = (await agentSpecs(run, proposals, options)).map(
    (spec): ToolSpec => ({
      ...spec,
      execute: async (args, ctx) => {
        await chain;
        if (!stopped && (await treeCost(run.rootRunId!)) >= AGENT_ROOT_MAX_USD)
          stop("budget_exceeded");
        if (stopped) throw new ToolError("blocked", "The agent was stopped");
        return spec.execute(args, ctx);
      },
    }),
  );
  try {
    session = await openSession({
      entries: [],
      specs: guarded,
      ctx: {
        userId: run.userId,
        conversationId: run.conversationId,
        runId: run.id,
        safety: {
          ambient: true,
          tainted: false,
          pendingApproval: false,
          allowedDomains: new Set(),
        },
      },
      modelId: config.model,
      generation: config,
      systemPrompt: workerSystemPrompt() + "\n\n# Your role\n\n" + def.prompt,
      runtimeContext: () =>
        buildRuntimeContext({
          now: new Date(),
          timezone: user?.timezone ?? null,
          facts: [],
        }) +
        `\n<agent_budget>Steps used: ${usage.steps} of ${def.maxSteps}. Finish before the budget runs out.</agent_budget>`,
    });
  } catch (error) {
    log.error({ err: error }, "agent session failed to open");
    return outcome("failed");
  }

  function stop(status: AgentStatus) {
    stopped ??= status;
    void session?.abort();
  }
  const later = (work: () => Promise<unknown>) => {
    chain = chain
      .then(work)
      .catch((e) => log.error({ err: e }, "agent bookkeeping failed"));
  };
  let lastStopReason: string | undefined;
  session.subscribe((event) => {
    if (
      event.type === "message_end" ||
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    )
      later(() =>
        prisma.agentStep.create({
          data: {
            runId: run.id,
            kind: event.type,
            data: JSON.parse(JSON.stringify(event)) as InputJsonValue,
          },
        }),
      );
    if (event.type === "tool_execution_end") usage.toolCalls += 1;
    if (event.type !== "message_end") return;
    const m = event.message as {
      role?: string;
      model?: string;
      stopReason?: string;
      durationMs?: number;
      usage?: {
        input?: number;
        output?: number;
        totalTokens?: number;
        cacheRead?: number;
        cost?: { total?: number };
      };
    };
    if (m.role !== "assistant") return;
    lastStopReason = m.stopReason;
    usage.steps += 1;
    usage.promptTokens += m.usage?.input ?? 0;
    usage.completionTokens += m.usage?.output ?? 0;
    usage.costUsd += m.usage?.cost?.total ?? 0;
    void trackModelCall({
      userId: run.userId,
      useCase: "subagent",
      result: {
        content: "",
        model: m.model ?? "unknown",
        latencyMs: m.durationMs ?? 0,
        usage: {
          promptTokens: m.usage?.input ?? 0,
          completionTokens: m.usage?.output ?? 0,
          totalTokens: m.usage?.totalTokens ?? 0,
        },
        cachedTokens: m.usage?.cacheRead,
        finishReason: m.stopReason,
      },
      costCents: Math.round((m.usage?.cost?.total ?? 0) * 100),
    });
    // A final answer is kept even at the limit; only further work stops,
    // before its tools run. The task-wide cap is checked by the tool guard.
    if (
      m.stopReason === "toolUse" &&
      (usage.steps >= def.maxSteps || usage.costUsd >= limitUsd)
    )
      stop("budget_exceeded");
    later(() =>
      prisma.agentRun.update({
        where: { id: run.id },
        data: { ...usage, model: m.model },
      }),
    );
  });

  const onParentAbort = () => stop("canceled");
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();
  const deadline = setTimeout(() => stop("timeout"), def.timeoutSec * 1000);
  const unread = () =>
    prisma.agentMessage.findMany({
      where: { runId: run.id, consumedAt: null },
      orderBy: { createdAt: "asc" },
    });
  const claim = async (ids: string[]) =>
    (
      await prisma.agentMessage.updateMany({
        where: { id: { in: ids }, consumedAt: null },
        data: { consumedAt: new Date() },
      })
    ).count === ids.length;
  let polling: Promise<void> = Promise.resolve();
  const poll = setInterval(() => {
    polling = polling
      .then(async () => {
        const row = await prisma.agentRun.findUnique({
          where: { id: run.id },
          select: { status: true },
        });
        if (row?.status === "canceled") return stop("canceled");
        if (!session.isStreaming) return;
        const fresh = await unread();
        if (fresh.length && (await claim(fresh.map((m) => m.id))))
          await session.steer(fromParent(fresh.map((m) => m.text)));
      })
      .catch((e) => log.error({ err: e }, "agent poll failed"));
  }, 250);

  let runError: unknown;
  try {
    // A retried attempt starts from the brief again, so it also needs the
    // messages an earlier attempt already consumed.
    const early = await prisma.agentMessage.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "asc" },
    });
    await claim(early.filter((m) => !m.consumedAt).map((m) => m.id));
    await session.prompt(
      briefText(brief, def) +
        (early.length ? "\n\n" + fromParent(early.map((m) => m.text)) : ""),
    );
    await session.waitForIdle();
    // Messages that arrived after the last tool boundary still get handled.
    for (let i = 0; i < 3 && !stopped; i++) {
      const late = await unread();
      if (!late.length || !(await claim(late.map((m) => m.id)))) break;
      await session.prompt(fromParent(late.map((m) => m.text)));
      await session.waitForIdle();
    }
    if (!stopped && !lastText(session.messages)) {
      await session.prompt("Finish now with your result for the assistant.");
      await session.waitForIdle();
    }
  } catch (error) {
    runError = error;
    log.error({ err: error }, "agent run failed");
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
    parentSignal?.removeEventListener("abort", onParentAbort);
    await polling;
    await chain;
  }
  const summary = lastText(session.messages);
  session.dispose();
  if (stopped) return outcome(stopped, summary);
  return outcome(
    runError || !summary || lastStopReason === "error" ? "failed" : "succeeded",
    summary,
  );
}

// Record the runtime's status and, for a background agent, post it to the
// parent conversation's inbox in the same transaction, so a finished agent
// always reports. A run canceled meanwhile stays canceled and posts nothing:
// whoever canceled it already knows.
export async function finalizeAgent(
  run: Pick<Prisma.AgentRun, "id" | "conversationId" | "userId" | "depth">,
  outcome: AgentOutcome,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.agentRun.updateMany({
      where: { id: run.id, status: { in: ACTIVE } },
      data: {
        status: outcome.status,
        result: outcome as unknown as InputJsonValue,
        finishedAt: new Date(),
      },
    });
    if (!updated.count || run.depth !== 1 || outcome.status === "canceled")
      return;
    const input = await tx.inboxInput.upsert({
      where: {
        conversationId_dedupeKey: {
          conversationId: run.conversationId,
          dedupeKey: "agent-result:" + run.id,
        },
      },
      create: {
        conversationId: run.conversationId,
        kind: "agent_result",
        source: "agent:" + run.id,
        dedupeKey: "agent-result:" + run.id,
        payload: {
          kind: "agent_result",
          agentRunId: run.id,
          status: outcome.status,
          text: outcome.summary,
          proposedActions: outcome.proposedActions as unknown as InputJsonValue[],
        },
      },
      update: {},
    });
    await tx.outboxEvent.create({
      data: {
        eventType: "conversation_turn",
        payload: {
          conversationId: run.conversationId,
          userId: run.userId,
          inputId: input.id,
        },
      },
    });
  });
}

export function createAgentProcessor(options: AgentOptions = {}) {
  return (
    job: Pick<Job<{ runId: string }>, "data" | "moveToDelayed">,
    token?: string,
  ) => runAgentJob(job, token, options);
}

export async function runAgentJob(
  job: Pick<Job<{ runId: string }>, "data" | "moveToDelayed">,
  token?: string,
  options: AgentOptions = {},
): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: job.data.runId },
    include: { definition: true },
  });
  if (!run || run.trigger !== "agent" || !ACTIVE.includes(run.status)) return;
  // Claim a running slot under the per-user lock; otherwise wait a little.
  const started = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${run.userId}))::text`;
    const running = await tx.agentRun.count({
      where: {
        userId: run.userId,
        trigger: "agent",
        depth: 1,
        status: "running",
        id: { not: run.id },
      },
    });
    if (running >= AGENT_MAX_RUNNING_PER_USER) return "busy";
    const { count } = await tx.agentRun.updateMany({
      where: { id: run.id, status: { in: ACTIVE } },
      data: { status: "running" },
    });
    return count ? "started" : "gone";
  });
  if (started === "gone") return;
  if (started === "busy") {
    await job.moveToDelayed(Date.now() + AGENT_DEFER_MS, token);
    throw new DelayedError();
  }
  let outcome: AgentOutcome;
  try {
    outcome = await executeAgent(run, undefined, options);
  } catch (error) {
    getLogger().error({ err: error, agentRunId: run.id }, "agent job failed");
    outcome = { status: "failed", summary: "", proposedActions: [] };
  }
  await finalizeAgent(run, outcome);
}

// An agent whose job was lost or crashed past its retries still reports back,
// as interrupted, so the parent always hears from it.
export async function recoverStaleAgents(now = new Date()): Promise<void> {
  const stale = await prisma.agentRun.findMany({
    where: {
      trigger: "agent",
      status: { in: ACTIVE },
      startedAt: { lt: new Date(now.getTime() - AGENT_STALE_MS) },
    },
    take: 50,
  });
  for (const run of stale)
    await finalizeAgent(run, {
      status: "interrupted",
      summary: "The background agent stopped before it finished.",
      proposedActions: [],
    });
}
