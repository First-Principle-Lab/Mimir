import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { ApiRequestResult } from "@mimir/connection-provider";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "github-poll-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { ConnectionError, GITHUB_INTEGRATION } = await import("@mimir/connection-provider");
const { pollGithubActivity } = await import("../integrations/github/github-poll.js");
import type { GithubPollDeps } from "../integrations/github/github-poll.js";

const prisma = getPrismaClient();
const userId = `github-poll-${randomUUID()}`;
const email = `${userId}@test.local`;
// Mention-patching: surfaced issues reuse the thread's conversation; seed one so
// ownerConversation finds it deterministically.
let conversationId = "";

// In-memory Redis subset (same shape as mail-poll's fakeCache) so dedup under
// test is deterministic and isolated from the real redis-backed sets.
function fakeCache(): Redis {
  const sets = new Map<string, Set<string>>();
  return {
    sismember: async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0),
    sadd: async (key: string, member: string) => {
      const s = sets.get(key) ?? new Set<string>();
      const added = s.has(member) ? 0 : 1;
      s.add(member);
      sets.set(key, s);
      return added;
    },
    ttl: async (key: string) => (sets.has(key) ? 60 : -2),
    expire: async () => 1,
  } as unknown as Redis;
}

// A fake provider transport for THIS user: /user/repos returns a repo list,
// /repos/*/issues returns the injected issues. Scoped so the sweep only "sees"
// our user's activity (other connected github rows exist in the shared test DB).
function requestForIssues(repos: string[], issues: Array<Record<string, unknown>>) {
  return (forUserId: string) => async (path: string): Promise<ApiRequestResult> => {
    if (forUserId !== userId) return { status: 200, data: [] };
    if (path === "/user/repos") return { status: 200, data: repos.map((full_name) => ({ full_name })) };
    if (path.startsWith("/repos/")) return { status: 200, data: issues };
    return { status: 404, data: {} };
  };
}

const issue = (number: number, title: string) => ({
  number,
  title,
  state: "open",
  html_url: `https://github.com/owner/repo/issues/${number}`,
  updated_at: "2024-08-02T12:00:00.000Z",
  user: { login: "alice" },
});

const surfacingDeps = (overrides: Partial<GithubPollDeps> = {}): GithubPollDeps => ({
  cache: fakeCache(),
  // "github" kind rides the same email triage prompt — fine for the monitor v1.
  judge: async () => ({ surface: true, rationale: "needs review", category: "actionable" as const }),
  publish: async () => {},
  requestFor: requestForIssues(["owner/repo"], [issue(1, "URGENT: creds in dockerfile")]),
  ...overrides,
});

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
  await prisma.integrationConnection.create({
    data: { userId, provider: GITHUB_INTEGRATION, connectionId: `gh-${userId}`, status: "connected" },
  });
  const conv = await prisma.conversation.create({ data: { userId } });
  conversationId = conv.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.integrationConnection.deleteMany({ where: { userId } });
  await prisma.conversation.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
});

describe("pollGithubActivity (lazy sweep)", () => {
  test("surfaces a new issue into the user's thread via the publish path", async () => {
    const published: unknown[] = [];
    const surfaced = await pollGithubActivity(
      surfacingDeps({ publish: async (u, e, payload) => { published.push({ u, e, payload }); } }),
    );
    expect(surfaced).toBe(1);
    expect(published.length).toBe(1);
    const rows = await prisma.message.findMany({ where: { conversationId, role: "assistant" } });
    expect(rows.some((r) => (r.content ?? "").includes("URGENT: creds"))).toBe(true);
  });

  test("Redis dedup keeps a re-swept issue from surfacing twice", async () => {
    const cache = fakeCache();
    const deps = surfacingDeps({ cache });
    expect(await pollGithubActivity(deps)).toBe(1);
    const before = await prisma.message.count({ where: { conversationId } });
    expect(await pollGithubActivity(deps)).toBe(0);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  });

  test("a noise verdict is not surfaced and is held in the noise cooldown window", async () => {
    const cache = fakeCache();
    let judgeCalls = 0;
    const deps = surfacingDeps({
      cache,
      judge: async () => {
        judgeCalls++;
        return { surface: false, rationale: "", category: "noise" as const };
      },
    });
    // First sweep: judged, marked noise, nothing surfaced — and no claim.
    expect(await pollGithubActivity(deps)).toBe(0);
    expect(judgeCalls).toBe(1);
    // Second sweep within the cooldown window: skipped without a second judge call.
    expect(await pollGithubActivity(deps)).toBe(0);
    expect(judgeCalls).toBe(1);
  });

  test("a judge error is NOT claimed, so the issue is retried next sweep", async () => {
    const cache = fakeCache();
    let calls = 0;
    const deps: GithubPollDeps = {
      ...surfacingDeps({ cache }),
      // First call errors, second call surfaces — the error must not claim the
      // issue, or the second sweep would skip it as already-surfaced.
      judge: async () => {
        calls++;
        return calls === 1
          ? { surface: false, rationale: "", category: "noise" as const, error: true }
          : { surface: true, rationale: "now", category: "actionable" as const };
      },
    };
    await pollGithubActivity(deps);
    expect(calls).toBe(1);
    expect(await pollGithubActivity(deps)).toBe(1);
  });

  test("a dead connection flips the row expired (fail-fast reconnect UX)", async () => {
    const deps: GithubPollDeps = {
      ...surfacingDeps({}),
      requestFor: () => async () => {
        throw new ConnectionError("expired", "token revoked");
      },
    };
    await pollGithubActivity(deps);
    const row = await prisma.integrationConnection.findFirst({ where: { userId, provider: GITHUB_INTEGRATION } });
    expect(row?.status).toBe("expired");
    // Restore so afterAll cleanup mirrors the connecting user.
    await prisma.integrationConnection.updateMany({ where: { userId }, data: { status: "connected" } });
  });
});