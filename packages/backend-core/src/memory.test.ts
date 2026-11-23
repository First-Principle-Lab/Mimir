import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "./prisma.js";
import {
  MemoryGateway,
  containsSecret,
  type MemoryNamespace,
  type MemoryProvider,
} from "./memory.js";
import { LegacyMemoryProvider } from "./legacy-memory.js";

const prisma = getPrismaClient();
const userId = "memory-test-" + randomUUID();
const otherId = "memory-test-" + randomUUID();
const c1 = randomUUID(),
  c2 = randomUUID(),
  alien = randomUUID();
const source = randomUUID();
const p = { userId, conversationId: c1 };
const provider = new LegacyMemoryProvider(async () => []);
const gateway = new MemoryGateway(provider);
const ns: MemoryNamespace = { ...p, scope: "conversation" };
beforeAll(async () => {
  await prisma.user.createMany({
    data: [
      {
        id: userId,
        email: userId + "@example.test",
        passwordHash: "synthetic",
      },
      {
        id: otherId,
        email: otherId + "@example.test",
        passwordHash: "synthetic",
      },
    ],
  });
  await prisma.conversation.createMany({
    data: [
      { id: c1, userId },
      { id: c2, userId },
      { id: alien, userId: otherId },
    ],
  });
  await prisma.message.createMany({
    data: [
      {
        id: source,
        conversationId: c1,
        role: "user",
        content: "Remember the symposium is on Friday.",
      },
      {
        conversationId: c2,
        role: "user",
        content: "Cobalt symposium in the second session",
      },
      {
        conversationId: alien,
        role: "user",
        content: "Cobalt symposium private alien detail",
      },
    ],
  });
});
afterAll(async () => {
  await prisma.extractedFact.deleteMany({
    where: { userId: { in: [userId, otherId] } },
  });
  await prisma.message.deleteMany({
    where: { conversationId: { in: [c1, c2, alien] } },
  });
  await prisma.conversation.deleteMany({
    where: { id: { in: [c1, c2, alien] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
});

describe("memory boundary and compatibility adapter", () => {
  test("unauthorized conversation is refused before reaching a provider", async () => {
    await expect(
      gateway.search(
        { userId: otherId, conversationId: c1 },
        "conversation",
        "symposium",
      ),
    ).rejects.toThrow("denied");
  });
  test("agent scope cannot widen to user scope and requires a runtime identity", async () => {
    await expect(
      gateway.search(
        { ...p, agentId: "agent-a", allowedScope: "agent" },
        "user",
        "symposium",
      ),
    ).rejects.toThrow("widened");
    await expect(gateway.search(p, "agent", "symposium")).rejects.toThrow(
      "namespace",
    );
  });
  test("remember, correction and tombstone export preserve source and supersession", async () => {
    const first = await gateway.remember(p, "conversation", {
      subject: "symposium",
      fact: "The symposium is on Friday",
      sourceMessageId: source,
    });
    const corrected = await gateway.remember(p, "conversation", {
      subject: "symposium",
      fact: "The symposium is on Saturday",
      sourceMessageId: source,
      replacesId: first.id,
    });
    expect(corrected.supersedesId).toBe(first.id);
    expect(
      (await gateway.search(p, "conversation", "symposium")).map((r) => r.id),
    ).toEqual([corrected.id]);
    expect(await gateway.forget(p, "conversation", corrected.id)).toBe(true);
    expect(await gateway.search(p, "conversation", "symposium")).toEqual([]);
    const exported = await gateway.export(p, "conversation");
    expect(exported.schemaVersion).toBe(1);
    expect(exported.records.map((r) => r.status)).toEqual([
      "superseded",
      "deleted",
    ]);
    expect(exported.records.every((r) => r.sourceMessageId === source)).toBe(
      true,
    );
  });
  test("cross-scope and cross-user corrections never supersede the target", async () => {
    const first = await gateway.remember(p, "user", {
      subject: "style",
      fact: "Use concise prose",
      sourceMessageId: source,
    });
    await expect(
      gateway.remember(p, "conversation", {
        subject: "style",
        fact: "Use long prose",
        sourceMessageId: source,
        replacesId: first.id,
      }),
    ).rejects.toThrow("not found");
    expect(
      (
        await prisma.extractedFact.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).status,
    ).toBe("active");
    expect(
      await gateway.forget(
        { userId: otherId, conversationId: alien },
        "user",
        first.id,
      ),
    ).toBe(false);
    expect(
      await gateway.search(
        { userId: otherId, conversationId: alien },
        "user",
        "concise",
      ),
    ).toEqual([]);
    expect(
      (
        await gateway.search({ ...p, conversationId: c2 }, "user", "concise")
      ).map((r) => r.id),
    ).toContain(first.id);
    expect(
      await gateway.search(
        { ...p, conversationId: c2 },
        "conversation",
        "concise",
      ),
    ).toEqual([]);
  });
  test("conversation search spans owned sessions only when requested", async () => {
    expect(
      await gateway.conversationSearch(p, "conversation", "Cobalt symposium"),
    ).toEqual([]);
    const found = await gateway.conversationSearch(
      p,
      "user",
      "Cobalt symposium",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.conversationId).toBe(c2);
    expect(
      await gateway.conversationSearch(
        { ...p, agentId: "agent-a" },
        "agent",
        "symposium",
      ),
    ).toEqual([]);
  });
  test("source ownership and credentials are checked before provider ingestion", async () => {
    await expect(
      gateway.remember(p, "conversation", {
        subject: "key",
        fact: "api_key=synthetic-secret-canary-123",
        sourceMessageId: source,
      }),
    ).rejects.toThrow("credentials");
    await expect(
      gateway.remember(p, "conversation", {
        subject: "source",
        fact: "Unsupported source",
        sourceMessageId: "missing",
      }),
    ).rejects.toThrow("source");
    expect(containsSecret("I prefer afternoon meetings")).toBe(false);
    expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });
  test("timeouts abort a provider and expose failure metrics without query text", async () => {
    let aborted = false;
    const events: unknown[] = [];
    const slow: MemoryProvider = Object.assign(Object.create(provider), {
      search: async (
        _ns: MemoryNamespace,
        _query: string,
        signal: AbortSignal,
      ) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("cancelled"));
          }),
        ),
    });
    const timed = new MemoryGateway(slow, 50, (e) => events.push(e));
    await expect(
      timed.search(p, "conversation", "private query"),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private query");
    expect(events).toMatchObject([{ operation: "search", success: false }]);
    expect(await provider.search(ns, "", new AbortController().signal)).toEqual(
      [],
    );
  });
});

test("a faulty adapter cannot return another tenant's facts or transcript", async () => {
  const alienMessage = await prisma.message.findFirstOrThrow({
    where: { conversationId: alien },
  });
  const faulty: MemoryProvider = Object.assign(Object.create(provider), {
    search: async () => [
      {
        userId: otherId,
        id: "alien-fact",
        subject: "private",
        fact: "private",
        conversationId: alien,
        scope: "user",
        status: "active",
        sourceMessageId: alienMessage.id,
        createdAt: new Date().toISOString(),
        supersedesId: null,
      },
    ],
    conversationSearch: async () => [
      { ...alienMessage, createdAt: alienMessage.createdAt.toISOString() },
    ],
  });
  const boundary = new MemoryGateway(faulty);
  expect(await boundary.search(p, "user", "private")).toEqual([]);
  expect(await boundary.conversationSearch(p, "user", "private")).toEqual([]);
});
