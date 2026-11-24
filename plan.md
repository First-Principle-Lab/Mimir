# Mimir harness rebuild plan

**Status:** active plan, created 2026-11-22. It replaces the agent parts of
[implementation-plan-final.md](implementation-plan-final.md) (Phases 4, 7, 8, 9 and the agent/context
parts of 10). Phases 14 (production hardening) and 15 (launch readiness) of that file still apply and
are folded into Phases 6–7 below. Repo rules for contributors and coding agents are in [AGENTS.md](AGENTS.md).
The memory decision below supersedes planned custom memory-engine enhancements in the older plan.

Progress as of 2026-11-24: Phase 0 infrastructure is merged into `dev`. Phase 1
is implemented and reviewed in PR #3. The review fixes trust-boundary, lock,
session-opening, model-limit, streaming and DST findings and evaluates actual
inference through HTTP intake, BullMQ, durable journals and socket delivery.
The full requirement/evidence matrix is in [the Phase 1 review](docs/phase-1-review.md).
Phase 1's published real-inference run and required CI passed; PR #3 is merged into
`dev`. Phase 2's [completion review](docs/phase-2-review.md), 230 tests,
23/23 real-inference scenarios and required CI passed on `002e5d7`; PR #4 was
squash-merged into `dev` as `ab80704`. Phase 3 is implemented and reviewed in
[PR #5](https://github.com/First-Principle-Lab/Mimir/pull/5): journaled write tools,
exact-argument approval cards, 255 passing tests, 33/33 real-inference scenarios
and 12 red-team checks on `b135214`. The [completion review](docs/phase-3-review.md)
records the requirement audit, 14 resolved findings and immutable evidence; PR #5 was
squash-merged into `dev` as `6831b62`. Phase 4 adds background agents, in-turn
delegation, budgets and cascade cancel; its [completion review](docs/phase-4-review.md)
records 13 resolved findings. A Phase 3 schema defect found afterwards was fixed in
#7. The integrated gate on `64d4e1d` (Phases 3–4 with #7) passed 268 tests, 38/38 real-inference
scenarios and 12 red-team checks: `eval/2026-11-23-harness-phase-3-4-completion`.
Phase 3/4 follow-ups #8 and #9 are integrated into `dev` at `9427cd2`.
Phase 5 is implemented and reviewed on `feat/phase-5-context-memory`; its
[requirement and completion-gate review](docs/phase-5-review.md) records 22 resolved
findings, 303 passing tests, 42/42 actual-inference harness scenarios plus 12 red-team
checks, 6/6 memory answers with live readiness checks, and 3/3 retrieval details.
The final implementation tested is `d445654`; immutable runs and the audited
legacy extraction misses are linked in the review. Required PR CI passed on `2831c6e`; PR #10 was squash-merged into `dev` as `edbc2e7`.
Phase 5 is complete. Phase 6 implementation and local hardening review are on
`feat/phase-6-hardening`; [the whole-phase review](docs/phase-6-review.md) records
local evidence and the remaining hosted-staging/Slack gate. Phase 6 is not yet
marked complete, and Phase 7 has not started. The five-provider
comparison remains Phase 7 after staging readiness.
Existing chats retain their latest 50 text messages on first pi use and durable
facts are preserved. Phase 2 adds inbox/notification scenarios, durable reminders
and read-only watchers to the Phase 0/1 harness runner.

## Decisions

1. **Scrap the current agent logic completely.** The classifier-first harness has been tested by hand and
   doesn't work. There is no baseline comparison: it is deleted, not measured.
2. **Use pi as the harness:** the `@earendil-works/pi-coding-agent` SDK (v1.6.0, MIT), TypeScript, inside
   the existing worker. Not Rust: the rest of Mimir is ~24k lines of TypeScript and pi is TypeScript.
3. **Mimir owns** the parts pi doesn't do for a multi-user server: durable storage in Postgres, background
   work on BullMQ, multi-tenancy, the policy gate, delivery, and memory integration controls.
4. **Reuse pi packages where they fit a multi-user server; port the rest.** The survey and the
   adopt / port / skip list are in [docs/research/pi-packages.md](docs/research/pi-packages.md).
5. **Every change goes dev → staging → main (production) through CI. Every eval run is saved on its own
   `eval/...` branch.** See [Branches, CI/CD and evals](#branches-cicd-and-evals).
6. **Adopt an existing memory system rather than build a new memory engine.** Prepare Mimir first,
   then evaluate **Mem0, Letta, Cognee, Supermemory and Graphiti** near the end of the rebuild.
   Select from measured speed, long-chat recall and relevant fact extraction, with a comparison report
   after all five evaluations. No provider is selected yet. Existing facts remain available during
   the transition; new custom extraction, embedding, graph and retrieval enhancements are superseded.

Background research: [docs/research/harness-design.md](docs/research/harness-design.md) (how 13 assistants
are built, and the recommended design) and its notes in [docs/research/notes/](docs/research/notes/).
Features that come after the harness: [docs/post-harness-features.md](docs/post-harness-features.md).

## Architecture

```
web / desktop ──HTTP──▶ api ──enqueue input──▶ BullMQ ──▶ worker
     ▲                   │                                  │
     └──── socket.io ◀───┴──── Redis pub/sub ◀──── delivery ┤
                                                            ▼
                                         ┌─────────── Mimir harness ───────────┐
                                         │ SessionHost (one AgentSession per    │
                                         │ active conversation, evicted on idle)│
                                         │  pi-coding-agent SDK                 │
                                         │   ├ Mimir extensions (inline)        │
                                         │   │  tools · policy gate · persist · │
                                         │   │  delivery · context tail · memory│
                                         │   ├ pi built-ins: MCP, tool_search   │
                                         │   └ adopted packages (pinned)        │
                                         └──────────────┬───────────────────────┘
                                                        ▼
                                  Postgres (sessions, runs, action attempts, facts)
```

How Mimir maps onto pi:

| Need                     | pi mechanism                                                 | Mimir side                                                                       |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| One conversation's agent | `createAgentSession()` per conversation                      | `SessionHost` in the worker keeps active sessions in memory and evicts idle ones |
| Durable history          | `SessionManager.inMemory()` hydrated from stored entries     | `session_entry` table; every `message_end` is persisted before it is delivered   |
| No coding tools          | `noTools`                                                    | Only Mimir tools are registered                                                  |
| Tools                    | inline extension, `pi.registerTool()`                        | `ToolSpec` registry (risk tier, idempotency, output budget, provenance)          |
| Policy gate              | `pi.on("tool_call")` can return `{ block, reason }`          | Fixed tier rules → taint rule → later a reviewer model                           |
| "Ask the user"           | `session.bindExtensions({ uiContext })`                      | `confirm` → approval card, `select` → choice card, sent over the socket          |
| New message mid-task     | `session.steer()` / `session.followUp()` / `session.abort()` | Per-conversation inbox with debounce; "stop" → `abort()`                         |
| Streaming                | `session.subscribe()` events                                 | Forwarded to socket.io; `agent_settled` closes the turn                          |
| MCP / deferred tools     | `createMcpExtension()`, `createToolSearchExtension()`        | Per-user Composio and custom MCP servers injected from the database              |
| Background agents        | — (in-process children die with the process)                 | `agent_run` rows + BullMQ jobs; results posted back to the parent's inbox        |
| Models                   | `pi-ai` model runtime                                        | OpenRouter; models per role in `model-config.json`                               |

**Only one run per conversation at a time** (Redis lock). The API never runs the model: it writes the
input, enqueues it, and returns.

## What gets deleted

All of this goes in Phase 1, on `dev`. `main` (production) keeps serving v1 until the new harness passes staging.

- `packages/backend-core/src/prompts/classification.md` and `classifyMessage` / `parseClassification` /
  `rewriteQuery` / dedup / spawn helpers in `apps/api/src/agent/agent.ts`
- The branch logic in `apps/api/src/routes/message.ts` (the route becomes: authenticate, store input,
  enqueue, return)
- `apps/worker/src/agent/planner.ts`, `reflector.ts`, the orchestrator fan-out, `tasks-registry.ts`,
  `agent-execution.ts`, `dormancy.ts`, `one_shot`, trigger classification (`trigger-eval.ts`,
  `trigger-tools.ts`, `triggers.ts`)
- Filter-before-surfacing (`filter_agent.md`, `filter_email.md`, `surface.md`) and the per-integration
  confirmation flows (`apps/api/src/email/email-action.ts`, `calendar/calendar-action.ts`,
  `agent/agent-draft.ts`)
- Prompts used only by the above (`planning.md`, `reflection.md`, `aggregation.md`, `execution_engine.md`,
  `one_shot.md`, `dedup_judgment.md`, `rewrite.md`, `trigger_*.md`, `*_propose.md`, `*_resolve.md`, …).
  Read each one before deleting; useful wording moves into tool descriptions.
- `scripts/intent-iteration/`, `scripts/phase7-attack/`, `scripts/phase8-attack/` and the tests that
  only cover deleted code
- Prisma models used only by the old logic, dropped in a forward migration (decide per table in Phase 1)

## What stays

- Auth, users, socket.io, Redis pub/sub, web push, Tauri desktop, Grafana, Docker, Render config
- `packages/connection-provider` (Composio, OAuth, connection health) and the integration API clients
  (`apps/worker/src/integrations/*`), which get wrapped as `ToolSpec`s
- BullMQ, the outbox relay, `budget.ts`, usage accounting
- Existing memory records and retrieval remain available for compatibility and later export/migration;
  their evaluation fixtures are reused. The long-term backend is selected in Phase 7.
- Mail/calendar/GitHub polling and webhooks, reshaped as watchers that post `event` inputs

## Phases

Each phase is one or more PRs into `dev`. Completion requires the dedicated review,
resolved findings, actual-inference evaluation and required CI described in the
[phase completion gate](AGENTS.md#phase-completion-gate).

### Phase 0 — Branches, CI/CD, eval infrastructure

- `dev` / `staging` branches next to `main` (production), promotion rules, CI, deploy pipeline, eval-branch publishing
  (this PR)
- Harness eval suite skeleton in `evals/harness/`: scenario format, runner, deterministic scoring.
  Scenarios have a set of expected tool calls, `must_not` actions, and whether a visible reply is
  required, forbidden or optional. Test groups: combined requests, hedged phrasing, message bursts,
  mid-task corrections, nothing-new worker results, misfired triggers, quiet hours, time zones and
  day of week.
- **Exit:** CI green on `dev`; `scripts/eval/run.sh` publishes an `eval/...` branch from CI and locally.

### Phase 1 — Delete the old agent logic, stand up pi (read-only)

- Delete everything under [What gets deleted](#what-gets-deleted)
- Spike: confirm the pi SDK runs headless in the worker with in-memory sessions, `noTools`, inline
  extensions and a host `uiContext`; pick one subagent package (see the survey)
- Pin `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` to exact versions
- `SessionHost`, `session_entry` persistence, `agent_run` / `agent_step` journal
- `ToolSpec` registry with **read tools only** (email search, calendar list, memory search, …) plus
  `tool_search`
- New interaction-agent system prompt, with no keyword rules. Copy OpenClaw's "Execution Bias" and
  "Promised Work" sections. The per-turn context tail includes local time and timezone, running agents
  and retrieved facts.
- The message route becomes "store input, enqueue, return"; replies stream back over the socket
- **Exit:** direct-answer, combined-request and time-zone scenarios pass; no write tool is reachable.

### Phase 2 — Inbox and response rules

- Typed inbox per conversation (`user`, `agent_result`, `event`, `routine_fire`, `approval_answer`),
  each tagged with its source
- Debounce bursts (1–3 s quiet window, with a maximum wait); steer at the next tool boundary;
  "stop" → abort
- The harness decides whether a reply is owed: a user input requires one. Background turns run in
  _ambient_ mode and may speak only through `send_to_user(text, urgency, reason_code)`, or stay silent
  with `NO_REPLY`. One recovery retry for an empty reply; one nudge for undelivered text.
- Delivery queue with receipts on top of the outbox and web push; quiet hours and digests at delivery
- Watchers become one BullMQ job per routine with a scratch row, a cheap check before waking the model,
  a dedupe key, and a record of what the user was already told. Port ideas from `pi-durable-bot` and
  `@ai-outfitter/channels`.
- `schedule` tool (port the `pi-schedule-prompt` contract onto BullMQ)
- **Exit:** notification precision/recall and "wrongly silent" targets met on the eval groups.

### Phase 3 — Safe writes

- Risk tiers on every `ToolSpec`; the `tool_call` policy gate: fixed tier rules, then the taint rule
  (once untrusted content is in context, external sends need a card). Composio meta-tools are gated on
  the inner action, not the wrapper's name.
- Approval card rendered from the **real tool arguments**; the run waits in `waiting_human` and resumes
- `action_attempt` rows written before every side effect, with an idempotency key from the draft ID or
  run step. An attempt interrupted by a crash is reported as **interrupted** and never retried
  automatically.
- Unattended outbound email waits as a draft
- One central wrapper that marks untrusted text; strip model-written links and images to unknown domains
- Write tools: email draft/send, calendar create/update, Notion, GitHub, browser
- **Exit:** zero duplicate side effects under crash-injection tests; `apps/worker/src/redteam.ts` passes.

### Phase 4 — Subagents and background agents

- In-turn delegation through the chosen subagent package; long-lived agents as `agent_run` rows on BullMQ
- Tools: `spawn_agent` / `message_agent` / `cancel_agent` / `list_agents`
- Contracts: a brief going in and a result coming out. The **runtime** sets the result status and posts
  it to the parent's inbox.
- Limits: nesting depth 2, about 5 children per run, 3–5 concurrent runs per user, budgets per run and
  per top-level task; cancel cascades to children
- Workers never talk to the user, and read-only workers propose writes instead of making them
- Agent definitions stored as data (prompt, tools, model, memory scope) — the hook for named bots later
- **Exit:** long tasks never block the chat; cost per top-level task stays under its cap.

### Phase 5 — Context and memory integration readiness

- Prompt layout from most to least stable (system prompt without timestamps → tools → profile → summary
  → recent messages → per-turn tail) for prompt-cache hits; pin OpenRouter `session_id` per conversation
- Compaction in tiers: store large outputs by reference; clear old tool results at ~60% of the window;
  summarize at ~80%
- Define a provider-independent memory adapter and tool contracts for remember, search, correction,
  forget and conversation search. Mimir owns authorization, user/agent scopes, provenance, secret
  filtering and timeouts; the selected system supplies durable memory, extraction and retrieval.
- Prepare export/migration of existing facts and a shared, de-identified evaluation dataset. Include
  short and long chats, multiple sessions, relevant facts among noise, corrections and changing facts.
  Record current behavior as a transition reference, not a candidate custom memory engine.
- Document latency budgets and quality thresholds before comparison runs. Prepare integration hooks
  and observability without choosing a backend or expanding the existing custom memory engine.
- **Exit:** context/cache behavior is stable; the adapter contract, migration inputs, fixtures and
  measurement protocol are ready for the late-stage comparison in Phase 7.

### Phase 6 — Hardening and staging readiness

From the old plan's Phases 14–15:

- Run more than one API instance (Redis socket registry and adapter)
- Row-level security for user-scoped tables
- Cost limits: soft and hard budget
- Load test polling fan-out and subagent fan-out
- End-to-end verification
- Error-handling audit
- Grafana alerts to Slack

**Exit:** Mimir's chat, tools, background agents and delivery hold under concurrent multi-user load
in staging, with budgets and observability ready. This completes the application prerequisites for
memory trials; final production promotion follows Phase 7.

### Phase 7 — Memory system evaluation, report and adoption

- Start only after Phases 4–6 and their completion gates are satisfied. Follow the shared
  [memory evaluation protocol](docs/memory-evaluation-plan.md).
- Run **Mem0, Letta, Cognee, Supermemory and Graphiti** through Mimir's prepared integration path,
  using actual model inference and the same transcripts, questions and expected facts. Record exact
  versions, deployment modes, models, configuration, hardware where applicable, and costs.
- Measure ingestion and retrieval latency (p50/p95), time until new facts are searchable and added
  chat latency. Evaluate recall across increasing chat lengths and sessions, temporal corrections,
  relevant fact extraction precision/recall and invented or irrelevant facts.
- Compare operational fit too: user isolation, deletion/export, source attribution, failure handling,
  hosting/licensing requirements and cost. Mark unavailable or incomplete runs explicitly; vendor
  claims and skipped runs cannot substitute for experiments.
- After all five evaluations finish, publish `docs/research/memory-systems-evaluation.md` with raw
  evidence, results, limitations, tradeoffs and a recommendation. Publish runs through the existing
  immutable `eval/...` workflow. Selection follows this report; it is not predetermined.
- Integrate the selected existing system, migrate retained facts, and rerun the memory and harness
  gates through the final Mimir path. Gate its quality and latency in CI, then verify staging and
  promote through the normal release process. Do not build a replacement custom engine if trials
  disappoint; report the gap and reassess available systems/configurations.
- **Exit:** all five have completed evaluations, the comparison report is published, the chosen system
  works through Mimir with passing migration, isolation, quality and latency checks, and required CI
  and staging checks pass before production promotion.

### Phase 8 — SEO (final phase)

- Start after Phase 7 and its completion gate. Keep SEO as the final planned phase.
- Review the [SEO reference saved by the user](https://x.com/illyism/status/2123675279210242167)
  and turn the applicable recommendations into an implementation checklist for Mimir's public pages.
  The link is saved for later review; its contents have not been verified yet.
- Audit public-page metadata, canonical URLs, sitemap/robots rules, structured data where applicable,
  crawlability and page performance. Keep private chats and authenticated user content out of indexing.
- **Exit:** applicable SEO work is implemented, reviewed and validated on the deployed public pages,
  with results recorded and required CI passing. Ranking changes are measured after launch.

After Phase 8, build the backlog in [docs/post-harness-features.md](docs/post-harness-features.md).
Phases 1–7 leave hooks for all of it: tool risk tiers, the `uiContext` bridge, agent definitions as data,
and memory scope through the selected provider.

## Testing

| Layer                          | Tool                                                                   | Runs                                                                                |
| ------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Unit                           | `bun test` per workspace                                               | Every PR and push (CI `checks` job)                                                 |
| Integration (Postgres + Redis) | `bun test`, real pgvector + Redis service containers                   | Every PR and push                                                                   |
| Lint / typecheck / build       | ESLint, `tsc`, `turbo build`                                           | Every PR and push                                                                   |
| Harness scenarios              | `evals/harness` runner, deterministic scoring; LLM judge only for tone | PRs touching the harness (Phase 0 onward); results published to `eval/...` branches |
| Memory retrieval gate          | `scripts/eval-retrieval.ts`                                            | Every PR when the `OPENROUTER_API_KEY` secret is set                                |
| Memory system comparison       | Shared `memory-systems` suite, added to the eval runner in Phase 7     | All five candidates after staging readiness; selected provider gated after adoption |
| Red-team / injection           | `apps/worker/src/redteam.ts`                                           | Phase 3 onward, as an eval suite                                                    |
| Crash injection                | kill the worker mid-tool and resume                                    | Phase 3 onward                                                                      |
| Real-LLM end-to-end            | tests that skip without `OPENROUTER_API_KEY`                           | Eval runs and staging                                                               |

Rules: every PR adds or updates tests for what it changes; a PR that changes agent behavior links the
`eval/...` branch of its eval run.

## Branches, CI/CD and evals

Details and day-to-day rules are in [AGENTS.md](AGENTS.md).

- `dev` is where work lands (feature branches → PR → `dev`); `staging` only takes PRs from `dev`;
  `main` (production) only takes PRs from `staging` (or `hotfix/*`). CI enforces the direction.
- `.github/workflows/ci.yml` runs lint, typecheck, tests (with Postgres + Redis), the duplication check,
  the build and the Docker image builds.
- `.github/workflows/deploy.yml` deploys `staging` and `main` after CI passes, through Render deploy hooks
  stored as GitHub Environment secrets. It skips with a notice until the hooks exist.
- `.github/workflows/eval.yml` runs eval suites on demand (with a topic), nightly on `dev`, and publishes
  each run to `eval/<date>-<suite>-<topic>`. That branch holds the code that was tested plus
  `evals/runs/<id>/` (README with topic, status and summary; `meta.json`; full log; result rows).
- `staging` starts at the current `main` (v1, `d1177a5`); `dev` starts from it too and carries this setup.

## Open decisions and risks

- **pi version churn:** pi publishes often. Pin exact versions and upgrade deliberately with the eval
  suite as the gate.
- **pi-durable:** it would give us durability, child tasks and sleep/wake for free, but it is experimental
  and has no Postgres storage. Revisit after Phase 4.
- **Package supply chain:** follow the rules in the [pi package survey](docs/research/pi-packages.md#rules-for-third-party-pi-packages).
- **Multi-tenant packages:** many packages read config from files; such packages need config injected
  per session, or a fork.
- **Memory selection:** Mem0, Letta, Cognee, Supermemory and Graphiti remain candidates until the
  Phase 7 comparison report. Long-chat recall, fact relevance and latency must be measured on the
  same Mimir workload. Access, hosting and model differences must be recorded rather than hidden.
- **Render environments:** separate staging services and deploy hooks must be created by hand
  (see AGENTS.md → Deployments).
