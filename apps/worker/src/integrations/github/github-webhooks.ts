import { getConfig, getLogger, getPrismaClient, type InputJsonValue } from "@mimir/backend-core";
import { GITHUB_INTEGRATION, composioProvider } from "@mimir/connection-provider";
import { rpc, type RequestFn } from "../http-rpc.js";
import { fetchTrackedRepos } from "./github.js";

// GitHub inbound-webhook registration (distinct from the GitHub TOOL access —
// this is the outbound config of repo webhooks that deliver events to our
// /webhooks/github endpoint). GitHub has no account-level webhooks, so hooks are
// registered per-repo. Registration is IDEMPOTENT (skips a repo that already has
// a hook for our URL), which is what makes it safe for BOTH the connect-time
// enqueue and the daily self-heal sweep to call the same function.
//
// Events: only the four the surface path actually reasons about — issues,
// issue_comment, pull_request, pull_request_review.

const prisma = getPrismaClient();

export interface GithubHook {
  repo: string;
  id: number;
  url: string;
}

interface GithubWebhookMeta {
  hooks?: GithubHook[];
}

const GITHUB_WEBHOOK_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review"];

interface RawHook {
  id?: number;
  config?: { url?: string };
}

async function listRepoHooks(request: RequestFn, repo: string): Promise<RawHook[]> {
  const hooks = await rpc<RawHook[]>(request, `/repos/${repo}/hooks`, { query: { per_page: 100 } });
  return Array.isArray(hooks) ? hooks : [];
}

// Register a web hook on each repo that doesn't already have one pointing at our
// URL. Re-running (reconnect, daily sweep, lost hook) is a no-op for covered repos.
export async function registerGithubWebhooks(
  request: RequestFn,
  repos: string[],
  opts: { url: string; secret: string },
): Promise<GithubHook[]> {
  const registered: GithubHook[] = [];
  for (const repo of repos) {
    try {
      const existing = (await listRepoHooks(request, repo)).filter((h) => h.config?.url === opts.url);
      if (existing.length > 0) {
        registered.push({ repo, id: existing[0]?.id ?? 0, url: opts.url });
        continue;
      }
      const created = await rpc<RawHook>(request, `/repos/${repo}/hooks`, {
        method: "POST",
        body: {
          name: "web",
          active: true,
          events: GITHUB_WEBHOOK_EVENTS,
          config: { url: opts.url, content_type: "json", secret: opts.secret },
        },
      });
      if (!created.id) continue;
      registered.push({ repo, id: created.id, url: opts.url });
      getLogger().info({ repo, hookId: created.id }, "github repo webhook registered");
    } catch (e) {
      // Repo admin may be absent, or a transient github error — leave the repo
      // for the next sweep; one failed repo must not abort the rest.
      getLogger().info({ err: e, repo }, "github webhook registration failed for repo; continuing");
    }
  }
  return registered;
}

// Best-effort removal of the tracked hooks at disconnect. A failed DELETE is
// logged, not fatal — revoke() drops the local row either way, and the hook
// keeps firing requests our endpoint dedups/ignores (401 on the secret).
export async function removeGithubWebhooks(request: RequestFn, hooks: GithubHook[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await rpc<undefined>(request, `/repos/${hook.repo}/hooks/${hook.id}`, { method: "DELETE" });
      getLogger().info({ repo: hook.repo, hookId: hook.id }, "github repo webhook removed");
    } catch (e) {
      getLogger().info({ err: e, repo: hook.repo, hookId: hook.id }, "github webhook removal failed; continuing");
    }
  }
}

export interface GithubWebhooksForUserDeps {
  // Overrides (test seam, mirrors runWatchRenewal's deps): default to the
  // config web base + GITHUB_WEBHOOK_SECRET.
  url?: string;
  secret?: string;
}

// The shared per-connection registration entry point used by BOTH the daily
// self-heal sweep and the connect-time outbox job. Reads the top pushed repos,
// registers what's missing, and persists the hook ids on the connection row.
// Hooks for repos that dropped off top-5 stay in meta so disconnect removes them.
export async function registerGithubWebhooksForUser(
  requestFor: (userId: string) => RequestFn,
  userId: string,
  deps: GithubWebhooksForUserDeps = {},
): Promise<number> {
  const cfg = getConfig();
  const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
  const url = deps.url ?? (webBase ? `${webBase}/webhooks/github` : "");
  const secret = deps.secret ?? cfg.GITHUB_WEBHOOK_SECRET;
  if (!url || !secret) return 0;

  const connection = await prisma.integrationConnection.findFirst({
    where: { userId, provider: GITHUB_INTEGRATION, status: "connected" },
  });
  if (!connection) return 0;

  const request = requestFor(userId);
  const repos = await fetchTrackedRepos(request, 5);
  const hooks = await registerGithubWebhooks(request, repos, { url, secret });

  const meta = (connection.webhookMeta ?? {}) as GithubWebhookMeta;
  const retained = (meta.hooks ?? []).filter((h) => !hooks.some((n) => n.repo === h.repo));
  await prisma.integrationConnection.update({
    where: { id: connection.id },
    data: { webhookMeta: { ...meta, hooks: [...retained, ...hooks] } as unknown as InputJsonValue },
  });
  getLogger().info({ userId, registered: hooks.length }, "github webhooks ensured");
  return hooks.length;
}

// The canonical per-user GitHub transport both the sweep and the outbox job use.
export const githubRequestFor: (userId: string) => RequestFn = (userId: string) => {
  const cfg = getConfig();
  const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
  const provider = composioProvider(GITHUB_INTEGRATION, cfg, prisma.integrationConnection, `${webBase}/api/v1/integrations/github/callback`);
  return (path, opts) => provider.apiRequest(userId, path, opts);
};

// Daily self-heal sweep: ensure every connected github account has hooks on its
// top pushed repos. A missed connect-time registration (api down/restart around
// the outbox drain) is healed here within 24h.
// ponytail: does NOT reconcile repo churn on already-registered accounts (a repo
// that drops off top-5 keeps its hook until disconnect) — the daily re-scan of
// every repo's hook list is the upgrade if stale hooks ever cost real money.
export async function runGithubHookSweep(): Promise<number> {
  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GITHUB_INTEGRATION, status: "connected" },
    select: { userId: true },
  });
  let ensured = 0;
  for (const { userId } of connections) {
    try {
      ensured += await registerGithubWebhooksForUser(githubRequestFor, userId);
    } catch (e) {
      getLogger().info({ err: e, userId }, "github hook sweep failed for user; continuing");
    }
  }
  return ensured;
}