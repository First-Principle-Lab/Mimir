import { getConfig, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError, ProviderError, GITHUB_INTEGRATION, composioProvider } from "@mimir/connection-provider";
import { ToolError, type Task } from "@mimir/tasks";
import { z } from "zod";
import { rpc, type RequestFn } from "../http-rpc.js";

const prisma = getPrismaClient();

// GitHub read tasks (5.7), read-only: list/get issues + list pull requests on
// the user's connected GitHub. Writes (create/comment/close) are deliberately
// not exposed yet — they mutate shared repositories and want a confirmation
// gate. Routes through the shared Composio proxyExecute transport (apiRequest).
// Note the monitor (github-poll.ts) reuses fetchRepoIssues with its own "all
// repos, open issues" fan-out.

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  user: string;
  // Present on issues that are actually pull requests (they share the issue
  // number space; the API tags PRs with a pull_request key).
  pullRequest?: boolean;
}

interface RawIssue {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  updated_at?: string;
  pull_request?: unknown;
  user?: { login?: string };
}

function mapIssue(i: RawIssue): GitHubIssue {
  return {
    number: i.number ?? 0,
    title: i.title ?? "",
    state: i.state ?? "",
    url: i.html_url ?? "",
    updatedAt: i.updated_at ?? "",
    user: i.user?.login ?? "",
    ...(i.pull_request ? { pullRequest: true } : {}),
  };
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function requireRepo(repo: string): string {
  if (!repo?.trim() || !REPO_RE.test(repo.trim())) {
    throw new ToolError("validation", "repo must be \"owner/repo\" (e.g. owner/mimir)");
  }
  return repo.trim();
}

// The repos the github monitor tracks, most recently pushed first so a cap on
// how many it polls watches active repos rather than an alphabetical slice.
export async function fetchTrackedRepos(request: RequestFn, maxRepos: number): Promise<string[]> {
  const repos = await rpc<{ full_name?: string }[]>(request, "/user/repos", {
    query: { sort: "pushed", per_page: maxRepos, affiliation: "owner,collaborator" },
  });
  return (Array.isArray(repos) ? repos : []).map((r) => r.full_name ?? "").filter(Boolean);
}

// List open issues for a repo. PRs ride the same /issues number space (tagged
// pull_request), so callers can pass `pullRequest: true` through or filter them.
export async function fetchRepoIssues(
  request: RequestFn,
  repo: string,
  opts: { state?: string; perPage?: number },
): Promise<GitHubIssue[]> {
  const results = await rpc<RawIssue[]>(request, `/repos/${repo}/issues`, {
    query: { state: opts.state ?? "open", per_page: opts.perPage ?? 20 },
  });
  return Array.isArray(results) ? results.map(mapIssue) : [];
}

function githubTransport(ctx: { userId: string }): RequestFn {
  const cfg = getConfig();
  const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
  const provider = composioProvider(GITHUB_INTEGRATION, cfg, prisma.integrationConnection, `${webBase}/api/v1/integrations/github/callback`);
  return (path, opts) => provider.apiRequest(ctx.userId, path, opts);
}

function mapErrors(e: unknown): never {
  if (e instanceof ConnectionError) throw new ToolError("connection", e.message);
  if (e instanceof ProviderError) throw new ToolError("execution", e.message);
  throw e;
}

const repoSchema = z.object({
  repo: z.string().describe("Repository in owner/repo form, e.g. \"owner/mimir\""),
  state: z.enum(["open", "closed", "all"]).optional().describe("Issue state to filter by (default open)"),
});

export function githubListIssuesTask(): Task {
  return {
    kind: "task",
    name: "github_list_issues",
    description:
      "List issues (and pull requests) in a GitHub repository owned by or accessible to the user's connected account. Returns issue numbers, titles, and states. Read-only.",
    inputSchema: repoSchema,
    execute: async (input, ctx) => {
      const { repo, state } = input as { repo: string; state?: "open" | "closed" | "all" };
      try {
        const issues = await fetchRepoIssues(githubTransport(ctx), requireRepo(repo), { state });
        return { provider: "github", repo, issues };
      } catch (e) {
        mapErrors(e);
      }
    },
  };
}

export function githubGetIssueTask(): Task {
  return {
    kind: "task",
    name: "github_get_issue",
    description:
      "Fetch a single issue or pull request from a GitHub repository by its number. Returns title, state, author, and URL.",
    inputSchema: z.object({
      repo: z.string().describe("Repository in owner/repo form, e.g. \"owner/mimir\""),
      issueNumber: z.number().int().positive().describe("The issue or PR number"),
    }),
    execute: async (input, ctx) => {
      const { repo, issueNumber } = input as { repo: string; issueNumber: number };
      try {
        const issue = await rpc<RawIssue>(githubTransport(ctx), `/repos/${requireRepo(repo)}/issues/${issueNumber}`);
        return { provider: "github", repo, issue: mapIssue(issue) };
      } catch (e) {
        mapErrors(e);
      }
    },
  };
}

export function githubListPullRequestsTask(): Task {
  return {
    kind: "task",
    name: "github_list_pull_requests",
    description:
      "List pull requests in a GitHub repository owned by or accessible to the user's connected account. Returns PR numbers, titles, and states. Read-only.",
    inputSchema: repoSchema,
    execute: async (input, ctx) => {
      const { repo, state } = input as { repo: string; state?: "open" | "closed" | "all" };
      try {
        const prs = await rpc<RawIssue[]>(githubTransport(ctx), `/repos/${requireRepo(repo)}/pulls`, {
          query: { state: state ?? "open", per_page: 20 },
        });
        return { provider: "github", repo, pulls: (Array.isArray(prs) ? prs : []).map(mapIssue) };
      } catch (e) {
        mapErrors(e);
      }
    },
  };
}