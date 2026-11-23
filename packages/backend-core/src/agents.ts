import { z } from "zod";
import { AGENT_ROOT_MAX_USD } from "./constants.js";
import type { getPrismaClient } from "./prisma.js";

// Background-agent records shared by the API (chat stop, the agents panel,
// user definitions) and the worker's runtime.

export const AGENT_ACTIVE_STATUSES = ["queued", "running"];

type Db = Pick<ReturnType<typeof getPrismaClient>, "agentRun">;

// Cancel runs and everything under them. Depth is at most AGENT_MAX_DEPTH (2),
// so descendants either have a run as parent or as root. A running agent sees
// the status at its next poll and aborts; a queued job finds it and exits.
export async function cancelAgentRuns(
  db: Db,
  runIds: string[],
): Promise<number> {
  if (!runIds.length) return 0;
  const { count } = await db.agentRun.updateMany({
    where: {
      trigger: "agent",
      status: { in: AGENT_ACTIVE_STATUSES },
      OR: [
        { id: { in: runIds } },
        { parentRunId: { in: runIds } },
        { rootRunId: { in: runIds } },
      ],
    },
    data: { status: "canceled", finishedAt: new Date() },
  });
  return count;
}

// A user-owned agent definition. Tools are names or "*"; the worker only ever
// grants read tools, so a write tool listed here is simply ignored.
export const agentDefinitionInput = z.strictObject({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{1,39}$/,
      "Use 2–40 lowercase letters, digits or dashes, starting with a letter",
    ),
  description: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(4000),
  tools: z
    .array(z.string().regex(/^(\*|[a-z][a-z0-9_]{1,63})$/))
    .min(1)
    .max(40)
    .default(["*"]),
  modelRole: z.enum(["subagent", "interaction"]).default("subagent"),
  memoryScope: z.enum(["conversation", "none"]).default("conversation"),
  canSpawn: z.boolean().default(false),
  maxSteps: z.number().int().min(1).max(40).default(12),
  maxUsd: z.number().min(0.01).max(AGENT_ROOT_MAX_USD).default(0.05),
  timeoutSec: z.number().int().min(30).max(1800).default(300),
});
export type AgentDefinitionInput = z.infer<typeof agentDefinitionInput>;
