import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError, GITHUB_INTEGRATION, composioProvider } from "@mimir/connection-provider";
import type { Redis } from "ioredis";
import { triageVerdict, type TriageVerdict } from "../../agent/triage.js";
import { ownerConversation } from "../../infra/mail-poll.js";
import { newMessagePayload, publishUserEvent, redis } from "../../infra/redis.js";
import type { RequestFn } from "../http-rpc.js";
import { fetchRepoIssues, fetchTrackedRepos, type GitHubIssue } from "./github.js";

const prisma = getPrismaClient();

// The GitHub monitor (5.7.3): a fixed-cadence sweep over every user's connected
// GitHub that surfaces NEW open issues/PRs the triage judge deems worth seeing.
// Same shape as pollImportantMail (detect -> judge -> surface into the user's
// thread) but on its own 15-min cadence: issues change rarely, and each sweep is
// N repo-list + M issue-list calls followed by an LLM triage call per new item —
// slower than mail poll keeps both API quota and triage COGS bounded.

const SURFACED_KEY = (userId: string) => `gh-surfaced:${userId}`;
// A "noise" verdict is NOT claimed permanently: the judge can misfire, so a
// non-surface issue is held in a short-TTL set and re-judged after
// GITHUB_NOISE_TTL_SECONDS instead of sending the LLM one triage call per issue
// per sweep forever (a user's open-issue backlog would otherwise burn unbounded
// triage cost on items nothing will ever surface).
const NOISE_KEY = (userId: string) => `gh-noise:${userId}`;
const GITHUB_NOISE_TTL_SECONDS = 24 * 60 * 60;

// How many of the user's repos to watch, capped to the most recently pushed
// (sort=pushed in fetchTrackedRepos) so the cap watches active repos.
// ponytail: fixed global cap + Redis-only dedup — re-surfaces once if Redis is
// flushed; a per-user cap and a Postgres claim row (like SurfacedMail) are the
// upgrade if a heavy multi-repo user or a flush ever makes that matter.
const MAX_REPOS = 5;

function defaultRequestFor(userId: string): RequestFn {
  const cfg = getConfig();
  const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
  const provider = composioProvider(GITHUB_INTEGRATION, cfg, prisma.integrationConnection, `${webBase}/api/v1/integrations/github/callback`);
  return (path, opts) => provider.apiRequest(userId, path, opts);
}

function renderIssue(repo: string, issue: GitHubIssue): string {
  const kind = issue.pullRequest ? "Pull request" : "Issue";
  return `${repo} · ${kind} #${issue.number}\n${issue.title}\nState: ${issue.state}\n${issue.url}`;
}

async function isNoiseCooldown(cache: Redis, userId: string, key: string): Promise<boolean> {
  return (await cache.sismember(NOISE_KEY(userId), key)) === 1;
}

async function markNoise(cache: Redis, userId: string, key: string, ttlSeconds: number): Promise<void> {
  const redisKey = NOISE_KEY(userId);
  await cache.sadd(redisKey, key);
  if ((await cache.ttl(redisKey)) === -1) {
    await cache.expire(redisKey, ttlSeconds);
  }
}

export interface GithubPollDeps {
  cache?: Redis;
  // The triage judge; tests inject a deterministic one. Production default is
  // triageVerdict (compatibility: tests may pass an extra `kind` arg).
  judge?: (userId: string, content: string, kind?: string) => Promise<TriageVerdict>;
  publish?: typeof publishUserEvent;
  // The per-user provider transport; tests inject a fake one.
  requestFor?: (userId: string) => RequestFn;
  // Re-judge window for noise verdicts. Injectable for tests; defaults to 24h.
  noiseTtlSeconds?: number;
}

// Sweep all connected GitHub accounts for new open issues/PRs. Returns the
// number surfaced this tick. Best-effort per user — one user's failure must not
// block the rest of the sweep.
export async function pollGithubActivity(deps: GithubPollDeps = {}): Promise<number> {
  const cache = deps.cache ?? redis;
  const judge = deps.judge ?? triageVerdict;
  const publish = deps.publish ?? publishUserEvent;
  const requestFor = deps.requestFor ?? defaultRequestFor;
  const noiseTtlSeconds = deps.noiseTtlSeconds ?? GITHUB_NOISE_TTL_SECONDS;

  const connections = await prisma.integrationConnection.findMany({
    where: { provider: GITHUB_INTEGRATION, status: "connected" },
    select: { userId: true },
  });
  if (connections.length === 0) return 0;

  let surfaced = 0;
  for (const { userId } of connections) {
    try {
      const request = requestFor(userId);
      const repos = await fetchTrackedRepos(request, MAX_REPOS);
      for (const repo of repos) {
        try {
          // PRs ride the same /issues number space (tagged pull_request), so one
          // call per repo dedups both by issue number.
          const issues = await fetchRepoIssues(request, repo, { state: "open", perPage: 10 });
          for (const issue of issues) {
            const key = `${repo}:${issue.number}`;
            if (await cache.sismember(SURFACED_KEY(userId), key)) continue;
            // Recently-judged noise stays quiet until its re-judge window lapses.
            if (await isNoiseCooldown(cache, userId, key)) continue;
            const verdict = await judge(userId, renderIssue(repo, issue), "github");
            // A judge failure (error flag) is NOT a verdict: don't claim the issue
            // so the next sweep retries it instead of permanently dropping it.
            if (verdict.error) continue;
            if (!verdict.surface) {
              await markNoise(cache, userId, key, noiseTtlSeconds);
              continue;
            }
            const conversationId = await ownerConversation(userId);
            const message = await prisma.message.create({
              data: {
                conversationId,
                role: "assistant",
                content: `Active GitHub activity:\n\n${renderIssue(repo, issue)}\n\n${verdict.rationale ?? ""}`.trim(),
                status: "complete",
              },
            });
            surfaced += 1;
            getLogger().info({ userId, repo, issueNumber: issue.number, category: verdict.category }, "github issue surfaced");
            try {
              await publish(userId, "new_message", newMessagePayload(conversationId, message));
            } catch (publishErr) {
              getLogger().error({ err: publishErr, userId }, "github publish failed (message already written)");
            }
            // Claim AFTER the durable write: if message.create fails (transient
            // DB error), the issue stays unclaimed and is retried next sweep —
            // never silently dropped by a redis marker written for a message
            // that doesn't exist.
            await cache.sadd(SURFACED_KEY(userId), key);
          }
        } catch (e) {
          // One repo failing (e.g. the account lost access — 404) must not abort
          // the rest of this user's repos; log and move on.
          getLogger().error({ err: e, userId, repo }, "github repo sweep failed; continuing repos");
        }
      }
    } catch (e) {
      getLogger().error({ err: e, userId }, "github poll failed for user; continuing sweep");
      // A dead connection must flip the local row so the UI stops claiming
      // "connected" — mirrors the mail-poll fail-fast flip.
      if (e instanceof ConnectionError) {
        await prisma.integrationConnection.updateMany({
          where: { userId, provider: GITHUB_INTEGRATION },
          data: { status: "expired" },
        });
        getLogger().info({ userId }, "github connection marked expired from poll failure");
      }
    }
  }
  return surfaced;
}