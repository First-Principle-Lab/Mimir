import {
  AGENT_MAX_ACTIVE_PER_USER,
  getPrismaClient,
} from "@mimir/backend-core";
import { ToolError } from "@mimir/tasks";
import type { Queue } from "bullmq";
import { z } from "zod";
import {
  ACTIVE,
  assertCanStart,
  agentJobOptions,
  agentJobs,
  briefSchema,
  cancelAgentTree,
  createAgentRun,
  findDefinition,
} from "./agents.js";
import type { ToolRunContext, ToolSpec } from "./tools.js";

const prisma = getPrismaClient();
const internal = {
  risk: "write_reversible_self",
  sideEffect: "reversible",
  idempotent: true,
  provenance: "mimir:harness/internal",
  resultTrust: "trusted",
  outputMaxChars: 4000,
} as const;
const spawnArgs = briefSchema.extend({
  agent: z.string().trim().min(1).max(100).default("researcher"),
});
const agentRef = z.strictObject({ agent_id: z.string().min(1).max(100) });
const messageArgs = agentRef.extend({
  text: z.string().trim().min(1).max(4000),
});
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

// Background agents this conversation started; ownership comes from the run
// context, never from the model's arguments.
async function ownAgent(agentId: string, ctx: ToolRunContext) {
  const run = await prisma.agentRun.findFirst({
    where: {
      id: agentId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      trigger: "agent",
      depth: 1,
    },
  });
  if (!run) throw new ToolError("validation", "No such background agent");
  return run;
}

async function activeAgent(agentId: string, ctx: ToolRunContext) {
  const run = await ownAgent(agentId, ctx);
  if (!ACTIVE.includes(run.status))
    throw new ToolError(
      "validation",
      `That agent already finished (${run.status}); start a new one with the updated brief`,
    );
  return run;
}

async function spawnTarget(agent: string, ctx: ToolRunContext) {
  const parent = await prisma.agentRun.findFirst({
    where: { id: ctx.runId, userId: ctx.userId },
  });
  if (!parent || parent.trigger === "agent")
    throw new ToolError("blocked", "Only the assistant can start agents");
  const definition = await findDefinition(ctx.userId, agent);
  if (!definition) throw new ToolError("validation", "Unknown agent: " + agent);
  await assertCanStart(parent);
  return { parent, definition };
}

// Built-in definitions plus the user's own, which win on a name clash.
export async function availableDefinitions(userId: string) {
  const rows = await prisma.agentDefinition.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: [{ userId: "asc" }, { name: "asc" }],
    select: { name: true, description: true, userId: true },
  });
  const byName = new Map<string, { name: string; description: string }>();
  for (const r of rows)
    if (!byName.has(r.name) || r.userId) byName.set(r.name, r);
  return [...byName.values()];
}

export function agentTools(
  opts: {
    queue?: Queue;
    definitions?: { name: string; description: string }[];
  } = {},
): ToolSpec[] {
  const queue = opts.queue ?? agentJobs;
  const choices = opts.definitions?.length
    ? " Agents: " +
      opts.definitions
        .map((d) => `${d.name} (${d.description.slice(0, 200)})`)
        .join("; ") +
      "."
    : "";
  return [
    {
      ...internal,
      name: "spawn_agent",
      label: "Start a background agent",
      description: `Start a read-only background agent with a brief and return at once; its result arrives later as a background input. Use for long work that shouldn't hold the chat, multi-source research, triage of many items, and whenever the user asks for background work. Otherwise answer short or sequential requests yourself. Give a self-contained objective, success criteria and the context it needs, including the user's instructions about how to do the work (helpers per item, proposals for review): it can't see this conversation. One agent per independent task; put items the user wants handled separately in items (one helper each). At most ${AGENT_MAX_ACTIVE_PER_USER} active. agent defaults to "researcher". Agents never message the user and propose writes instead of making them.${choices}`,
      // Input mode: fields with defaults stay optional for the model.
      parameters: spawnArgs.toJSONSchema({ io: "input" }),
      // Refusals happen here, before the action journal.
      prepare: async (raw, ctx) => {
        const args = spawnArgs.parse(raw);
        await spawnTarget(args.agent, ctx);
        return json(args);
      },
      execute: async (raw, ctx) => {
        const { agent, ...brief } = spawnArgs.parse(raw);
        const { parent, definition } = await spawnTarget(agent, ctx);
        await ctx.assertOwned?.();
        const run = await createAgentRun({ parent, definition, brief });
        // The outbox row guarantees the job; this is the fast path.
        await queue
          .add("agent", { runId: run.id }, agentJobOptions(run.id))
          .catch(() => {});
        return {
          agentId: run.id,
          agent: definition.name,
          status: "queued",
          note: "Runs in the background. Its result arrives later as a separate input; don't wait for it or claim its findings now.",
        };
      },
    },
    {
      ...internal,
      name: "message_agent",
      label: "Message a background agent",
      description:
        "Send a correction or extra instruction to a queued or running background agent. It applies the message at its next step. A finished agent can't be messaged; start a new one with the updated brief.",
      parameters: messageArgs.toJSONSchema({ io: "input" }),
      prepare: async (raw, ctx) => {
        const args = messageArgs.parse(raw);
        await activeAgent(args.agent_id, ctx);
        return json(args);
      },
      execute: async (raw, ctx) => {
        const args = messageArgs.parse(raw);
        const run = await activeAgent(args.agent_id, ctx);
        await ctx.assertOwned?.();
        await prisma.agentMessage.create({
          data: { runId: run.id, text: args.text },
        });
        return { delivered: true, status: run.status };
      },
    },
    {
      ...internal,
      name: "cancel_agent",
      label: "Cancel a background agent",
      description:
        "Cancel a background agent and any helpers it started. Use when the user cancels the task or replaces it.",
      parameters: agentRef.toJSONSchema({ io: "input" }),
      prepare: (raw) => json(agentRef.parse(raw)),
      execute: async (raw, ctx) => {
        const run = await ownAgent(agentRef.parse(raw).agent_id, ctx);
        if (!ACTIVE.includes(run.status))
          return { canceled: false, status: run.status };
        await ctx.assertOwned?.();
        await cancelAgentTree(run.id);
        return { canceled: true };
      },
    },
    {
      name: "list_agents",
      label: "List background agents",
      description:
        "List this conversation's background agents with their status, objective and cost, newest first.",
      parameters: z.strictObject({}).toJSONSchema(),
      risk: "read_private",
      sideEffect: "none",
      idempotent: true,
      provenance: "mimir:harness/internal",
      // Briefs are model-written and may quote tool content.
      resultTrust: "untrusted",
      outputMaxChars: 6000,
      execute: async (_raw, ctx) => {
        const runs = await prisma.agentRun.findMany({
          where: {
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            trigger: "agent",
            depth: 1,
          },
          orderBy: { startedAt: "desc" },
          take: 20,
          include: { definition: { select: { name: true } } },
        });
        return runs.map((r) => ({
          agentId: r.id,
          agent: r.definition?.name,
          status: r.status,
          objective: briefSchema.safeParse(r.brief).data?.objective,
          costUsd: Number(r.costUsd.toFixed(4)),
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
        }));
      },
    },
  ];
}

// Active agents for the per-turn runtime context.
export async function activeAgents(conversationId: string) {
  const runs = await prisma.agentRun.findMany({
    where: {
      conversationId,
      trigger: "agent",
      depth: 1,
      status: { in: ACTIVE },
    },
    orderBy: { startedAt: "asc" },
    take: 10,
    include: { definition: { select: { name: true } } },
  });
  return runs.map((r) => ({
    id: r.id,
    agent: r.definition?.name ?? "agent",
    status: r.status,
    objective: briefSchema.safeParse(r.brief).data?.objective ?? "",
  }));
}
