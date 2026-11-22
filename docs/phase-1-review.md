# Phase 1 completion review

Review date: 2026-11-22. Scope: the entire Phase 1 change in PR #3, including
its forward migrations, retained integrations, API, worker, and web client.
Phase 2 remains unstarted. Required CI on the latest PR head is the final gate;
a skipped live CI job does not replace the recorded real-inference evaluation.

## Requirement audit

| Phase 1 requirement | Implementation and review evidence | Result |
|---|---|---|
| Delete the classifier-first pipeline | Old API classifier/ack/draft/approval handlers; worker planners, reflectors, orchestrator, triggers, dormancy, poll/surface logic; obsolete prompts, attack scripts, tests, and Prisma models removed. Searches found no remaining runtime references to the deleted pipeline. Old recurring schedulers are removed at worker boot. | Pass |
| Headless pi spike, no coding tools, inline extensions, host UI | Bun worker runs `SessionManager.inMemory`, private working/agent directories, `noTools: "builtin"`, discovery disabled, and an explicit inline extension. Tests bind a host confirmation callback and verify active tools. Actual inference runs through this session construction. | Pass |
| Choose a subagent package | Source review selected `@tintinweb/pi-subagents` 0.26.2 as the Phase 4 port reference. Direct loading is unsuitable because of filesystem/config/MCP discovery assumptions. Decision and source links are in `docs/research/pi-packages.md`. | Pass; implementation belongs to Phase 4 |
| Pin pi dependencies | `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are exactly 1.6.0 in the worker manifest and lockfile. | Pass |
| SessionHost and durable session/run/step journals | Conversation ownership, Redis lock, lock-loss abort/checks, concurrent-open reservation, immediate idle eviction, database hydration, ordered `SessionEntry`/`AgentStep` writes, atomic reply/run completion, and replay protection. Scripted integration tests plus live queued turns and rehydration scenarios exercise these paths. | Pass |
| Read-only ToolSpecs and discovery | Production registry provides memory, web, and connected-account read tools with risk/side-effect/idempotency/provenance/output-budget metadata. Built-in coding tools, write tools and arbitrary MCP tools are absent. Policy tests block unknown and registered writing tools; live tests cover email/calendar write refusal and deferred Notion discovery. | Pass |
| Static interaction prompt, no classifier/router | Model chooses tools directly. Prompt includes the OpenClaw Execution Bias and Promised Work sections and Phase 1 capability limits. No keyword classifier is introduced. | Pass |
| Per-turn time, timezone, running agents, facts | Context is injected before the latest user input without persisting it. Includes local weekday/date/offset, exact local-day boundaries, optional retrieved facts, and an explicit statement that background agents are unavailable. Unit tests cover facts and invalid zones; live tests cover date rollover, DST and UTC fallback. | Pass |
| Store/enqueue/return API, streamed replies | Authenticated HTTP intake transaction stores message plus outbox, returns 202, and enqueues BullMQ. Worker stores the final answer before publishing Redis events. Actual socket clients receive deltas, final-message notification and settlement. Correlation, replay, reconnect/poll recovery and preservation of provisional streamed text are covered. | Pass |
| Direct, combined and timezone exit scenarios | All twelve live scenarios pass through HTTP → BullMQ → pi/OpenRouter → Postgres → Redis → socket.io. Results include requested tool arguments, final text, token counts, journal counts and replay checks. | Pass; immutable run linked below |
| No reachable write tool | Read-only production registry checked for every live turn, policy tests, unknown-tool rejection, and two actual-inference write-refusal scenarios. Synthetic integration handlers cannot touch real accounts. | Pass |

## Findings and resolutions

1. **Evaluation bypassed the worker path.** The previous seven-scenario runner
   called `openSession` directly. Replaced it with authenticated HTTP intake,
   an isolated BullMQ queue, the production turn processor, real Postgres/Redis,
   and authenticated socket clients. Only account responses and the clock are
   substituted. Every scenario checks successful inference/accounting, durable
   journals, streaming/settlement, and HTTP/worker replay without duplicate work.
   CI now provides the required Postgres and Redis services and runs migrations.
2. **DST day boundaries were wrong in actual inference.** The initial expanded
   probe passed 11/12: New York's fallback day started at 05:00Z instead of 04:00Z.
   Runtime context now computes the two local-date boundaries independently and
   provides their exact UTC instants. Regression tests cover 23/25-hour days,
   Kolkata rollover, and a zone whose clock skipped midnight. The repeated live
   evaluation passes the previously failing case.
3. **Failed tools bypassed trust marking and output budgets.** Errors now pass
   through the same central renderer as successful results. A malicious, long
   upstream error is capped and fenced in the regression test. Live invoice
   results also contain an untrusted instruction that must not control the reply.
4. **Conversation lease loss was ignored.** Failed renewal or a changed token
   now aborts the session; ownership is checked before journal and final-reply
   writes. A lock-replacement test verifies that stale final text is neither
   journaled nor delivered and that cleanup preserves the replacement token.
5. **SessionHost could initialize twice concurrently.** It now reserves a
   conversation before awaiting SDK initialization; a concurrent-open test
   verifies rejection of the second opener.
6. **Deployment generation limits were ignored.** The configured interaction
   output-token limit and temperature now reach the OpenRouter provider payload
   through pi's request hook. A regression verifies the limits while preserving
   messages and tool declarations. pi owns transport/retry behavior and Mimir
   retains its whole-turn timeout; context compaction remains Phase 5 work.
7. **Recovery polling erased partial streamed replies.** The web client now
   preserves a pending stream until its matching durable reply appears, with a
   regression covering both retention and replacement.

All findings above are resolved. The final published run, its tested SHA, and
required CI state are recorded in PR #3 and the evidence section below.

## Validation

- Workspace lint, typecheck, and tests: 204 passing tests across six workspaces.
- The rewritten eval runner also passes a focused TypeScript check with Bun's
  module resolution. The repository-wide standalone scripts typecheck has
  existing errors in the unrelated memory eval scripts; it is not a workspace
  CI gate and those scripts were not changed by this review.
- Frozen dependency install, migration command, duplication check, and Next.js
  static export pass. Native Tauri compilation is outside this phase's CI gate.
- A fresh temporary database was migrated through all pre-Phase-1 migrations,
  seeded with synthetic chat/fact rows, then upgraded through both Phase 1
  migrations. Both rows survived, all three journal tables existed, and all
  seven obsolete tables were absent. The temporary database was then removed.
- Twelve real-model scenarios: arithmetic, combined email/calendar, hedged
  calendar request, local-midnight interval, Tokyo weekday/date, email write
  refusal, deferred Notion discovery, New York DST interval, invalid timezone,
  calendar write refusal, next-turn rehydration, and legacy-history bootstrap.

This evaluates the implemented Phase 1 agent path with synthetic accounts. It
does not certify live OAuth provider behavior, native desktop packaging, staging
load, or the inbox/background/write features assigned to later phases.

## Published evidence

- Tested implementation commit: `180297cc2ac4e330b3cfc9e141420f134ad3e000`.
- Model: `~deepseek/deepseek-v4-flash-latest`, real OpenRouter inference.
- Final result: **12/12 passing scenarios**, including all Phase 1 exit groups,
  DST, write refusals, discovery, legacy history and session rehydration.
- Immutable branch: [`eval/2026-11-22-harness-phase-1-completion-review-end-to-end`](https://github.com/First-Principle-Lab/Mimir/tree/eval/2026-11-22-harness-phase-1-completion-review-end-to-end/evals/runs/20261122T171233Z-harness).
  Its `meta.json` identifies the exact tested SHA; `harness.jsonl` contains
  per-scenario calls, replies, inference usage and delivery/persistence evidence.
- Reproduce with local Postgres on 5434, Redis on 6380, `JWT_SECRET`, and
  `OPENROUTER_API_KEY`: `scripts/eval/run.sh harness "phase 1 completion review end to end" --push`.
- The subsequent evidence-recording commit changes documentation only. Required
  CI for the latest PR head is tracked in [PR #3](https://github.com/First-Principle-Lab/Mimir/pull/3).

This evaluates the implemented interaction path with synthetic account data.
Actual Gmail/Calendar/GitHub/Notion OAuth and provider transports retain their
separate integration-test coverage; this run does not access personal accounts,
exercise the rendered browser/Tauri UI, or claim Phase 2 notification behavior.

## CI checkpoint

Both required checks passed on `8a29fa081e3090fb678d1295354f333de9e12068`:
[promotion direction](https://github.com/First-Principle-Lab/Mimir/actions/runs/45048285805/job/137287582891)
and [lint, typecheck, tests and build](https://github.com/First-Principle-Lab/Mimir/actions/runs/45048285805/job/137287582881).
There were no unresolved review threads or merge conflicts. Together with the
resolved review findings and published 12/12 real-inference run, this satisfies
the Phase 1 review and evaluation requirements. Subsequent documentation-only
updates still require passing CI on the latest PR head before handback.
PR #3 remains open for integration into `dev`; Phase 2 has not started.
