# AGENTS.md

Rules for anyone changing this repo: people and coding agents (Claude Code, Codex, pi, …).
`CLAUDE.md` is a symlink to this file.

## What this is

Mimir is a personal AI assistant: chat (web + Tauri desktop), background agents that watch Gmail /
Calendar / GitHub / Notion, reminders and routines, web push. The agent harness is being rebuilt on
the **pi SDK** (`@earendil-works/pi-coding-agent`). **The plan is [plan.md](plan.md); read it before
changing agent code.**

| Path | What |
|---|---|
| `apps/api` | Express + socket.io: auth, message intake, webhooks, delivery |
| `apps/worker` | BullMQ worker: the harness (pi sessions), watchers, background jobs |
| `apps/web` | Next.js static export (chat UI) |
| `apps/desktop` | Tauri shell around `apps/web` |
| `packages/backend-core` | Prisma, config, OpenRouter, prompts, memory (facts) |
| `packages/connection-provider` | Composio OAuth + proxy for integrations |
| `evals/` | Eval suites and the eval-run format |
| `docs/` | Research, pi package survey, post-harness backlog |

## Branches

| Branch | Purpose | Takes PRs from | Deploys to |
|---|---|---|---|
| `dev` | Integration branch; all work lands here first | `feat/*`, `fix/*`, `chore/*`, `docs/*`, `test/*` | — |
| `staging` | Release candidate | `dev` only | Staging (Render) |
| `main` | Production | `staging` only, or `hotfix/*` | Production (Render) |
| `eval/*` | One branch per eval run: tested code + results. Read-only records | Created by `scripts/eval/run.sh` only | — |

- **Never push directly to `dev`, `staging` or `main`.** Open a PR; CI must pass.
- Branch from `dev`: `feat/<short-name>`, `fix/<short-name>`, `chore/…`, `docs/…`, `test/…`.
- Merge into `dev` with **squash**. Promote `dev → staging` and `staging → main` with a **merge commit**
  (not squash), so each environment's history is a prefix of the one before it.
- **Hotfix:** branch `hotfix/<name>` from `main`, PR into `main`, then PR the same fix into `dev`
  right away so it isn't lost on the next promotion.
- CI rejects PRs that go the wrong way (for example `feat/x → staging`).
- **Never merge, rebase or delete an `eval/*` branch.** They are the record of what was tested.

## Commits and PRs

- Conventional commits: `feat(worker): …`, `fix(api): …`, `chore: …`, `test: …`, `docs: …`, `eval: …`.
- One logical change per PR. The PR template asks what changed, how it was tested, and (for agent
  behavior) which `eval/...` branch shows the eval run.
- Every PR adds or updates tests for the code it changes. A PR that only deletes code must keep
  the remaining tests green.

## Phase completion gate

Every phase ends with a dedicated review and evaluation before the next phase begins.
Before marking a phase complete or starting work on the next phase:

1. Review the entire phase against **every planned requirement and exit criterion** in [plan.md](plan.md),
   including changes spread across multiple PRs. Check the implementation, integrations, migrations,
   tests and end-to-end behavior; identify omissions, regressions and unfinished work.
2. Run the relevant evaluations with **actual model inference** through the implemented agent path.
   Mocked or faux-model tests supplement this evaluation but cannot replace it. A missing API key,
   skipped evaluation or run marked "not run" leaves the gate incomplete.
3. Fix the review findings and evaluation failures, then repeat the affected checks and real-inference
   evaluations. Record the review findings, resolutions, test results, tested commit and passing
   `eval/...` branch in the phase's PR or completion report.
4. Proceed only when every requirement and exit criterion is satisfied, the review findings are
   resolved, required CI checks pass and the real-inference evaluations pass. Green CI alone does
   not establish phase completion. If anything remains, finish the current phase before moving on.

## Before you open a PR

```sh
bun install
docker compose up -d                      # Postgres (pgvector) on :5434, Redis on :6380
DATABASE_URL=postgres://mimir:mimir@localhost:5434/mimir bun run migrate
bun run lint && bun run typecheck && bun run test && bun run verify
bun run build                             # web static export (desktop is excluded in CI)
```

Tests that call a real LLM skip themselves when `OPENROUTER_API_KEY` is not set. Tests expect
Postgres on `localhost:5434` and Redis on `localhost:6380`.

## CI/CD

| Workflow | When | What |
|---|---|---|
| `ci.yml` | PRs into `dev` / `staging` / `main`, pushes to `dev` | Promotion-direction check, lint, typecheck, tests (Postgres + Redis), duplication check, build, Docker image builds, memory retrieval gate (only if `OPENROUTER_API_KEY` is set) |
| `deploy.yml` | Push to `staging` / `main` | Re-runs CI, then calls the Render deploy hooks for that environment, then checks `/health` |
| `eval.yml` | Manual (topic + suite), nightly on `dev` | Runs an eval suite and publishes the run to an `eval/...` branch |

### Deployments

Render deploys are triggered **only** by `deploy.yml`, after CI passes. One-time setup (by hand):

1. In Render, create the staging services (`mimir-*-staging`) alongside production, and turn
   **Auto-Deploy off** on all of them.
2. Copy each service's deploy hook URL.
3. In GitHub → Settings → Environments, create `staging` and `production`. Add these secrets to each:
   `RENDER_DEPLOY_HOOK_API`, `RENDER_DEPLOY_HOOK_WORKER`, `RENDER_DEPLOY_HOOK_WEB`. Add the variable
   `HEALTHCHECK_URL` (for example `https://<api-host>/health`). Optionally require a reviewer on
   `production`.

Until the hooks exist, `deploy.yml` passes with a "deploy skipped" notice.

## Evals

Every eval run gets its own branch, so you can check it out and see exactly what was tested and
what came out.

```sh
scripts/eval/run.sh <suite> "<topic>"          # run locally, create the eval/ branch locally
scripts/eval/run.sh <suite> "<topic>" --push   # …and push it
```

Or run the **eval** workflow from GitHub Actions with a topic and suite.

- Branch name: `eval/<YYYY-MM-DD>-<suite>-<topic-slug>` (with `-2`, `-3`, … if taken).
- The branch is the **tested commit** plus one commit that adds `evals/runs/<run-id>/`:
  `README.md` (topic, suite, status, tested commit, summary), `meta.json`, `output.log`, and the
  result rows (`*.jsonl`).
- List runs: `git fetch origin 'refs/heads/eval/*:refs/remotes/origin/eval/*' && git branch -r --list 'origin/eval/*'`.
- Suites today: `retrieval`, `query`, `locomo` (memory). The harness scenario suite (`harness`) is
  added in Phase 0 of the plan.
- The runner needs a clean working tree, so the branch matches exactly what was tested.
- Any change to prompts, tool descriptions or harness logic needs an eval run linked in the PR.

## Harness rules

- **No classifier or keyword router in front of the model.** The model decides by calling tools.
  The harness enforces fixed rules around it (reply owed or not, `NO_REPLY` in ambient mode only,
  the policy gate).
- **Every tool is a `ToolSpec`** with a risk tier, side-effect and idempotency flags, an output budget
  and provenance. No tool executes a side effect without an `action_attempt` row.
- **Workers never talk to the user.** Only the interaction agent delivers messages.
- **Untrusted content** (email bodies, web pages, MCP output, other people's calendar text) is tagged
  at the tool boundary. Never put "ignore previous instructions"-style defenses in individual prompts;
  use the central wrapper.
- **pi packages:** pin exact versions, read the source before adding or upgrading, load only from the
  explicit list in the session's `ResourceLoader` (never from `~/.pi` or project discovery), and record
  the decision in [docs/research/pi-packages.md](docs/research/pi-packages.md).

## Secrets

This repo is **public**. Never commit secrets, tokens, `.env` files, server IPs or personal data. Use
`.env` locally (gitignored) and GitHub secrets in CI. Required for evals and real-LLM tests:
repository secret `OPENROUTER_API_KEY`.
