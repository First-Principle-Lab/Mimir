import { randomUUID } from "node:crypto";
import {
  agentDefinitionInput,
  AGENT_ACTIVE_STATUSES,
  cancelAgentRuns,
  getPrismaClient,
} from "@mimir/backend-core";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.js";

// Background agents for the chat panel, and the user's own agent definitions.
// Ownership always comes from the session, never from the request body.
const prisma = getPrismaClient();
export const agentsRouter: Router = Router();

const briefObjective = (brief: unknown) =>
  z.object({ objective: z.string() }).safeParse(brief).data?.objective ?? "";
const resultSummary = (result: unknown) =>
  z.object({ summary: z.string() }).safeParse(result).data?.summary ?? "";

agentsRouter.get("/agents", requireAuth, async (req, res) => {
  const conversationId =
    typeof req.query.conversationId === "string"
      ? req.query.conversationId
      : "";
  const runs = await prisma.agentRun.findMany({
    where: { userId: req.userId!, conversationId, trigger: "agent", depth: 1 },
    orderBy: { startedAt: "desc" },
    take: 20,
    include: {
      definition: { select: { name: true } },
      _count: { select: { children: true } },
    },
  });
  res.json({
    agents: runs.map((r) => ({
      id: r.id,
      agent: r.definition?.name ?? "agent",
      status: r.status,
      objective: briefObjective(r.brief),
      // Agent reports come from tool content: shown as plain text only.
      summary: resultSummary(r.result).slice(0, 1200),
      helpers: r._count.children,
      costUsd: r.costUsd,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  });
});

agentsRouter.post("/agents/:id/cancel", requireAuth, async (req, res) => {
  const run = await prisma.agentRun.findFirst({
    where: {
      id: String(req.params.id),
      userId: req.userId!,
      trigger: "agent",
      depth: 1,
    },
  });
  if (!run) {
    res.status(404).json({ error: { message: "Agent not found" } });
    return;
  }
  if (!AGENT_ACTIVE_STATUSES.includes(run.status)) {
    res
      .status(409)
      .json({ error: { message: "This agent already finished" } });
    return;
  }
  await cancelAgentRuns(prisma, [run.id]);
  res.status(202).json({ canceled: true });
});

const definitionFields = {
  id: true,
  userId: true,
  name: true,
  description: true,
  prompt: true,
  tools: true,
  modelRole: true,
  memoryScope: true,
  canSpawn: true,
  maxSteps: true,
  maxUsd: true,
  timeoutSec: true,
} as const;

agentsRouter.get("/agent-definitions", requireAuth, async (req, res) => {
  const rows = await prisma.agentDefinition.findMany({
    where: { OR: [{ userId: req.userId! }, { userId: null }] },
    orderBy: [{ name: "asc" }],
    select: definitionFields,
  });
  res.json({
    definitions: rows.map(({ userId, ...d }) => ({ ...d, builtIn: !userId })),
  });
});

agentsRouter.post("/agent-definitions", requireAuth, async (req, res) => {
  const parsed = agentDefinitionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: z.prettifyError(parsed.error) } });
    return;
  }
  const exists = await prisma.agentDefinition.findFirst({
    where: { userId: req.userId!, name: parsed.data.name },
  });
  if (exists) {
    res
      .status(409)
      .json({ error: { message: "You already have an agent with that name" } });
    return;
  }
  const row = await prisma.agentDefinition.create({
    data: { id: randomUUID(), userId: req.userId!, ...parsed.data },
    select: definitionFields,
  });
  res.status(201).json({ definition: { ...row, builtIn: false } });
});

agentsRouter.patch("/agent-definitions/:id", requireAuth, async (req, res) => {
  const parsed = agentDefinitionInput.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: z.prettifyError(parsed.error) } });
    return;
  }
  // Built-ins have no owner, so they can't match and can't be edited.
  const count = await prisma.agentDefinition
    .updateMany({
      where: { id: String(req.params.id), userId: req.userId! },
      data: parsed.data,
    })
    .then((r) => r.count)
    .catch((error: { code?: string }) => {
      if (error.code === "P2002") return -1;
      throw error;
    });
  if (count === -1) {
    res
      .status(409)
      .json({ error: { message: "You already have an agent with that name" } });
    return;
  }
  if (!count) {
    res.status(404).json({ error: { message: "Agent definition not found" } });
    return;
  }
  res.json({ updated: true });
});

agentsRouter.delete("/agent-definitions/:id", requireAuth, async (req, res) => {
  // Past runs keep their records; their definition link is cleared.
  const { count } = await prisma.agentDefinition.deleteMany({
    where: { id: String(req.params.id), userId: req.userId! },
  });
  res.status(count ? 204 : 404).end();
});
