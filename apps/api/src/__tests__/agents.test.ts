import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "agent-route-tests";
const { getPrismaClient, getConfig, AGENT_ROOT_MAX_USD } =
  await import("@mimir/backend-core");
const { agentsRouter } = await import("../routes/agents.js");
const { createMessageRouter } = await import("../routes/message.js");
const { signAccessToken } = await import("../auth/tokens.js");
const prisma = getPrismaClient();
const userId = randomUUID();
const foreign = randomUUID();
let conversationId: string;
let otherConversationId: string;
let cookie: string;
let foreignCookie: string;
let base: string;
const app = express();
app.use(express.json());
app.use(agentsRouter);
app.use(createMessageRouter(async () => true));
const server = createServer(app);
beforeAll(async () => {
  for (const id of [userId, foreign])
    await prisma.user.create({
      data: { id, email: id + "@example.test", passwordHash: "synthetic" },
    });
  conversationId = (await prisma.conversation.create({ data: { userId } })).id;
  otherConversationId = (await prisma.conversation.create({ data: { userId } }))
    .id;
  cookie =
    "access_token=" + (await signAccessToken(userId, getConfig().JWT_SECRET));
  foreignCookie =
    "access_token=" + (await signAccessToken(foreign, getConfig().JWT_SECRET));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of [conversationId, otherConversationId]) {
    await prisma.outboxEvent.deleteMany({
      where: { payload: { path: ["conversationId"], equals: id } },
    });
    await prisma.message.deleteMany({ where: { conversationId: id } });
    await prisma.conversation.delete({ where: { id } });
  }
  await prisma.agentDefinition.deleteMany({
    where: { userId: { in: [userId, foreign] } },
  });
  await prisma.analyticsEvent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, foreign] } } });
});
const call = (path: string, init: RequestInit = {}, auth = cookie) =>
  fetch(base + path, {
    ...init,
    headers: {
      cookie: auth,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
// A background agent with one in-turn helper, as the worker would create.
async function agentWithHelper(conversation = conversationId) {
  const turn = await prisma.agentRun.create({
    data: { conversationId: conversation, userId, trigger: "user" },
  });
  const id = randomUUID();
  const agent = await prisma.agentRun.create({
    data: {
      id,
      conversationId: conversation,
      userId,
      trigger: "agent",
      status: "running",
      depth: 1,
      parentRunId: turn.id,
      rootRunId: id,
      definitionId: "builtin-researcher",
      brief: { objective: "Research Cedar" },
    },
  });
  const helper = await prisma.agentRun.create({
    data: {
      conversationId: conversation,
      userId,
      trigger: "agent",
      status: "running",
      depth: 2,
      parentRunId: agent.id,
      rootRunId: agent.id,
      definitionId: "builtin-reader",
      brief: { objective: "One part" },
    },
  });
  return { agent, helper };
}
const statusOf = async (id: string) =>
  (await prisma.agentRun.findUniqueOrThrow({ where: { id } })).status;

test("the agents panel lists only the user's own agents and cancels a whole task", async () => {
  const { agent, helper } = await agentWithHelper();
  expect((await fetch(base + "/agents?conversationId=" + conversationId)).status).toBe(401);
  const listed = (await (
    await call("/agents?conversationId=" + conversationId)
  ).json()) as { agents: { id: string; objective: string; helpers: number }[] };
  expect(listed.agents.find((a) => a.id === agent.id)).toMatchObject({
    objective: "Research Cedar",
    helpers: 1,
  });
  expect(
    (
      (await (
        await call("/agents?conversationId=" + conversationId, {}, foreignCookie)
      ).json()) as { agents: unknown[] }
    ).agents,
  ).toHaveLength(0);
  expect(
    (await call("/agents/" + agent.id + "/cancel", { method: "POST" }, foreignCookie))
      .status,
  ).toBe(404);
  expect((await call("/agents/" + agent.id + "/cancel", { method: "POST" })).status).toBe(
    202,
  );
  expect(await statusOf(agent.id)).toBe("canceled");
  expect(await statusOf(helper.id)).toBe("canceled");
  expect((await call("/agents/" + agent.id + "/cancel", { method: "POST" })).status).toBe(
    409,
  );
});

test("a standalone stop cancels this conversation's background agents, nothing else does", async () => {
  const here = await agentWithHelper();
  const elsewhere = await agentWithHelper(otherConversationId);
  const send = (content: string) =>
    call("/message", {
      method: "POST",
      body: JSON.stringify({ conversationId, content, clientMessageId: randomUUID() }),
    });
  expect((await send("How's the research going?")).status).toBe(202);
  expect(await statusOf(here.agent.id)).toBe("running");
  expect((await send("stop")).status).toBe(202);
  expect(await statusOf(here.agent.id)).toBe("canceled");
  expect(await statusOf(here.helper.id)).toBe("canceled");
  expect(await statusOf(elsewhere.agent.id)).toBe("running");
  await prisma.agentRun.updateMany({
    where: { conversationId: otherConversationId, trigger: "agent" },
    data: { status: "canceled" },
  });
});

test("users manage their own agent definitions within the runtime's limits", async () => {
  const builtIns = (
    (await (await call("/agent-definitions")).json()) as {
      definitions: { id: string; name: string; builtIn: boolean }[];
    }
  ).definitions;
  expect(builtIns.filter((d) => d.builtIn).map((d) => d.name).sort()).toEqual([
    "reader",
    "researcher",
  ]);
  const create = (body: unknown, auth = cookie) =>
    call("/agent-definitions", { method: "POST", body: JSON.stringify(body) }, auth);
  const valid = {
    name: "inbox-triage",
    description: "Sort new mail",
    prompt: "Group unread mail by urgency.",
  };
  expect((await create({ ...valid, name: "Bad Name" })).status).toBe(400);
  expect(
    (await create({ ...valid, maxUsd: AGENT_ROOT_MAX_USD + 1 })).status,
  ).toBe(400);
  expect((await create({ ...valid, unexpected: true })).status).toBe(400);
  const created = await create(valid);
  expect(created.status).toBe(201);
  const { definition } = (await created.json()) as {
    definition: { id: string; tools: string[]; maxSteps: number };
  };
  expect(definition).toMatchObject({ tools: ["*"], maxSteps: 12 });
  expect((await create(valid)).status).toBe(409);
  // Another user may use the same name; neither sees the other's.
  expect((await create(valid, foreignCookie)).status).toBe(201);
  const mine = (
    (await (await call("/agent-definitions")).json()) as {
      definitions: { name: string; builtIn: boolean }[];
    }
  ).definitions.filter((d) => !d.builtIn);
  expect(mine.map((d) => d.name)).toEqual(["inbox-triage"]);

  // A partial update changes only what it names.
  const patch = (id: string, body: unknown, auth = cookie) =>
    call("/agent-definitions/" + id, { method: "PATCH", body: JSON.stringify(body) }, auth);
  expect((await patch(definition.id, { description: "Triage mail" })).status).toBe(200);
  expect(
    await prisma.agentDefinition.findUniqueOrThrow({ where: { id: definition.id } }),
  ).toMatchObject({ description: "Triage mail", tools: ["*"], maxSteps: 12 });
  expect((await patch(definition.id, { maxSteps: 99 })).status).toBe(400);
  expect((await patch(definition.id, { description: "x" }, foreignCookie)).status).toBe(404);
  expect((await patch("builtin-researcher", { description: "x" })).status).toBe(404);

  expect(
    (await call("/agent-definitions/builtin-reader", { method: "DELETE" })).status,
  ).toBe(404);
  expect(
    (await call("/agent-definitions/" + definition.id, { method: "DELETE" })).status,
  ).toBe(204);
});
