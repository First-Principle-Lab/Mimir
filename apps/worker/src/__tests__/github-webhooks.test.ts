import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "github-webhooks-test-secret";

const { getPrismaClient } = await import("@mimir/backend-core");
const { GITHUB_INTEGRATION } = await import("@mimir/connection-provider");
const { registerGithubWebhooks, registerGithubWebhooksForUser, removeGithubWebhooks } = await import("../integrations/github/github-webhooks.js");
import type { RequestFn } from "../integrations/http-rpc.js";
import type { ApiRequestOptions } from "@mimir/connection-provider";

const prisma = getPrismaClient();
const URL = "https://api.test.local/webhooks/github";

// In-memory GitHub hooks store keyed by repo. The fake transport serves
// GET/POST/DELETE /repos/{repo}/hooks exactly like GitHub does.
function hookStore(initial: Record<string, Array<{ id: number; config: { url: string } }>>) {
  const store = new Map(Object.entries(initial).map(([repo, hooks]) => [repo, [...hooks]]));
  const ops: string[] = [];
  const request: RequestFn = async (path, opts: ApiRequestOptions = {}) => {
    const m = path.match(/^\/repos\/(.+)\/hooks(?:\/(\d+))?$/);
    if (!m) return { status: 404, data: {} };
    const repo = m[1]!;
    const hookId = m[2];
    const hooks = store.get(repo) ?? [];
    const method = opts.method ?? "GET";
    if (method === "GET") {
      return { status: 200, data: hooks };
    }
    if (method === "POST") {
      const created = { id: hooks.length + 1, config: (opts.body as { config: { url: string } }).config };
      hooks.push(created);
      store.set(repo, hooks);
      ops.push(`POST ${repo} ${created.id}`);
      return { status: 201, data: created };
    }
    if (method === "DELETE") {
      const idx = hooks.findIndex((h) => String(h.id) === hookId);
      if (idx === -1) return { status: 404, data: {} };
      hooks.splice(idx, 1);
      store.set(repo, hooks);
      ops.push(`DELETE ${repo} ${hookId}`);
      return { status: 204, data: {} };
    }
    return { status: 405, data: {} };
  };
  return { request, ops, store };
}

describe("registerGithubWebhooks (idempotent repo registration)", () => {
  test("creates a hook per repo only when our URL isn't already registered", async () => {
    const { request, ops } = hookStore({});
    const url = URL;
    const first = await registerGithubWebhooks(request, ["owner/repo-a", "owner/repo-b"], { url, secret: "s" });
    expect(first).toHaveLength(2);
    const second = await registerGithubWebhooks(request, ["owner/repo-a", "owner/repo-b"], { url, secret: "s" });
    expect(second).toHaveLength(2); // still reports covered repos (no-op)
    const creates = ops.filter((o) => o.startsWith("POST"));
    expect(creates).toHaveLength(2); // one POST per repo, never duplicated
  });

  test("skips a repo that already has a hook at our URL (re-run safety)", async () => {
    const { request, ops } = hookStore({
      "owner/repo-c": [{ id: 7, config: { url: URL } }],
    });
    const registered = await registerGithubWebhooks(request, ["owner/repo-c"], { url: URL, secret: "s" });
    expect(registered).toEqual([{ repo: "owner/repo-c", id: 7, url: URL }]);
    expect(ops).toEqual([]); // no POST issued
  });
});

describe("removeGithubWebhooks (disconnect)", () => {
  test("DELETEs each tracked hook", async () => {
    const { request, ops } = hookStore({
      "owner/repo-a": [{ id: 1, config: { url: URL } }, { id: 2, config: { url: URL } }],
    });
    await removeGithubWebhooks(request, [
      { repo: "owner/repo-a", id: 1, url: URL },
      { repo: "owner/repo-a", id: 2, url: URL },
    ]);
    expect(ops).toEqual(["DELETE owner/repo-a 1", "DELETE owner/repo-a 2"]);
  });
});

describe("registerGithubWebhooksForUser (sweep + connect-time entry point)", () => {
  const userId = `gh-hooks-${randomUUID()}`;
  let githubUrl = "";
  const email = `${userId}@test.local`;

  beforeAll(async () => {
    githubUrl = URL;
    await prisma.user.create({ data: { id: userId, email, passwordHash: "x" } });
    await prisma.integrationConnection.create({
      data: { userId, provider: GITHUB_INTEGRATION, connectionId: `gh-${randomUUID()}`, status: "connected" },
    });
  });

  afterAll(async () => {
    await prisma.integrationConnection.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  test("registers hooks on the top pushed repos and persists them in webhookMeta", async () => {
    const { request } = hookStore({});
    // /user/repos -> the tracked repos.
    const requestFor = (u: string): RequestFn => {
      if (u !== userId) return async () => ({ status: 200, data: [] });
      return async (path: string, opts: ApiRequestOptions = {}) => {
        if (path === "/user/repos") return { status: 200, data: [{ full_name: "owner/repo-a" }, { full_name: "owner/repo-b" }] };
        return request(path, opts);
      };
    };

    const registered = await registerGithubWebhooksForUser(requestFor, userId, { url: URL, secret: "wh-secret" });
    expect(registered).toBe(2);

    const row = await prisma.integrationConnection.findFirst({ where: { userId, provider: GITHUB_INTEGRATION } });
    const meta = (row?.webhookMeta ?? {}) as { hooks?: { repo: string; id: number; url: string }[] };
    expect(meta.hooks).toHaveLength(2);
    expect(meta.hooks!.map((h) => h.repo).sort()).toEqual(["owner/repo-a", "owner/repo-b"]);
    expect(meta.hooks!.every((h) => h.url === githubUrl)).toBe(true);
  });

  test("re-running keeps persisted hooks (idempotent, no duplicates in meta)", async () => {
    const { request } = hookStore({});
    const requestFor = (u: string): RequestFn => {
      if (u !== userId) return async () => ({ status: 200, data: [] });
      return async (path: string, opts: ApiRequestOptions = {}) => {
        if (path === "/user/repos") return { status: 200, data: [{ full_name: "owner/repo-a" }, { full_name: "owner/repo-b" }] };
        return request(path, opts);
      };
    };

    await registerGithubWebhooksForUser(requestFor, userId, { url: URL, secret: "wh-secret" });
    await registerGithubWebhooksForUser(requestFor, userId, { url: URL, secret: "wh-secret" });
    const row = await prisma.integrationConnection.findFirst({ where: { userId, provider: GITHUB_INTEGRATION } });
    const meta = (row?.webhookMeta ?? {}) as { hooks?: unknown[] };
    expect(meta.hooks ?? []).toHaveLength(2);
  });
});