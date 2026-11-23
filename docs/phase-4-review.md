# Phase 4 implementation review

Scope: background agents and in-turn delegation across the agent runtime,
interaction tools, inbox delivery, budgets, recovery, schema and prompts.
Phase 5 has not started. Required CI and final completion status are recorded
in the Phase 4 PR.

## Requirement audit

| Requirement | Implementation and verification |
| --- | --- |
| In-turn delegation through the chosen package | `@tintinweb/pi-subagents` 0.26.2 is ported, not installed (decision in `docs/research/pi-packages.md`). A depth-1 agent's `delegate` tool runs a depth-2 leaf as a fresh in-process pi session with the same pinned runtime, explicit resource loader, a narrowed read-only tool list and the parent's abort signal. Scripted test: a leaf runs in-turn, has no `delegate`, its result returns as an untrusted tool result and only the parent reports to the conversation. Live: `fan-out` delegates one helper per listed item. |
| Long-lived agents on BullMQ | `spawn_agent` creates an `AgentRun` (`trigger: agent`, depth 1, its own root) and an `agent_run` outbox row in one transaction; the relay and a fast path share one job ID and options. `runAgentJob` claims a running slot under a per-user advisory lock, runs the agent and finalizes. Stale unfinished agents are reported interrupted by recovery. |
| spawn / message / cancel / list | Interaction-only tools. `spawn_agent` and `message_agent`/`cancel_agent` are journaled internal actions; `list_agents` is a read. Ownership comes from the run context. Ambient turns cannot spawn (loop prevention); they can list, message and cancel. |
| Brief in, result out; runtime sets status | Briefs are validated (objective, success criteria, context, optional items). The runtime chooses `succeeded`, `failed`, `timeout`, `budget_exceeded`, `interrupted` or `canceled`; agent text never sets it. Finalizing writes the status and posts the `agent_result` inbox input plus its turn in one transaction. Canceled agents post nothing. The parent reads the report as untrusted content with the runtime status. |
| Limits | Depth 2 (leaves cannot delegate), 5 children per run, 5 active and 3 running background agents per user (extra jobs wait), per-run step/USD/time budgets from the definition, and a USD 0.50 ceiling per top-level task summed over the whole tree. Step and run-cost limits stop the agent synchronously before further tools run; spend anywhere in the tree is checked before each tool. Cancel cascades to helpers and aborts in-turn children through their signal. |
| Workers never talk to the user; read-only | Agents get only read tools, `propose_action` and (depth 1) `delegate`; no `send_to_user`, schedule, write, MCP or agent-management tools. Proposals are recorded, never executed; targets the user never named are tagged `unverifiedTargets`. Any real write still goes through the parent's tools, taint and approval cards. |
| Definitions as data | `AgentDefinition` rows (prompt, tools, model role, memory scope, spawn permission, step/USD/time limits) with built-in `researcher` and `reader`; user rows override built-ins by name. The model role selects the model-config entry. |
| Exit: long tasks never block chat | Live `background-research`: the chat reply arrives while the agent is still queued, and a second question is answered before the agent finishes. Agents never take the conversation lock. |
| Exit: task cost under its cap | Enforced by the tree-wide ceiling (scripted: sibling spend stops the root; a spent task neither starts helpers nor calls the model). Every live scenario checks each task's tree cost against the cap. |

## Findings and resolutions

Found during implementation, scripted testing, the requirement review and
exploratory live runs. Each fix has a regression test or a live scenario.

1. Step and cost limits were checked in asynchronous bookkeeping, so an agent
   could make further model calls past its limit. In-memory step and run-cost
   limits now stop the agent synchronously before its tools run, and the
   tree-wide ceiling is checked before every tool call.
2. Zod 4's `toJSONSchema()` defaults to output mode, so fields with defaults
   were required in the schema pi validates calls against (`delegate` rejected
   a call without `agent`). Phase 4 tools publish input-mode schemas. The same
   defect in the Phase 3 write tools (`calendarId`, `attendees`, issue `body`,
   page `text`) is fixed separately in `fix/tool-schema-defaults`.
3. An agent's final status was committed before its result was posted, in a
   separate transaction. A reader could see the status first, and a crash in
   between would lose the report. Both now commit together.
4. With fast synthetic reads the interaction model sometimes did explicitly
   requested background work inline. The prompt and tool description now make
   an explicit background request always delegate.
5. Briefs dropped the user's instructions about how to do the work (a helper
   per item, a proposal for review), and once forbade proposing at all. The
   prompt and tool description now require those instructions in the brief and
   explain that proposals run nothing.
6. Per-item fan-out relied on prose and was unreliable; the researcher
   correctly preferred parallel direct calls for single lookups. Briefs now
   take an explicit `items` list (one helper each), and the worker prompt keeps
   single lookups direct.
7. In one exploratory run a depth-2 leaf proposed sending mail to the address
   in an injected invoice footer. It stayed inside the task tree and nothing
   executed, but proposals now carry `unverifiedTargets`: recipients and sites
   the user never named. Only the user's own messages vouch for a target, since
   a model-written brief once quoted the injected address.
8. Definitions stored a model role that was ignored; it now selects the
   model-config entry, falling back to the interaction model.
9. `list_agents` returned model-written briefs as trusted output; it is now
   untrusted.
10. Agents loaded tools directly and `spawn_agent` always enqueued on the
    production queue, so evals could neither give agents synthetic accounts nor
    isolate their queue. Both are injectable, like the turn processor's tools.
    The relay and fast path now share one job ID and option set.

The completion review re-read the whole phase diff before integration and
found three more defects, each fixed in `8cd29b8` with a regression test that
fails on the previous code:

11. A retried agent job restarted from its brief with only unread messages,
    silently dropping corrections an earlier attempt had consumed. The opening
    prompt now includes every message the agent received.
12. In-turn helpers left active by a crashed attempt stayed `running` until the
    stale sweep. A new attempt now marks them interrupted.
13. Spawn limits, unknown definitions and messages to finished agents were
    refused inside the action journal, so the model was told the action might
    have reached a provider and the identical call stayed blocked for the run.
    They are now refused in `prepare`, before journaling; the locked check in
    `createAgentRun` still guards races.

Evaluation corrections: two scenarios were reworded after their first runs.
The proposal case gained the finance email it assumed and plainer wording ("I'll
review it before anything is sent"), and the fan-out case asks for a helper per
project. A Bun quirk (`toMatchObject` writes asymmetric matchers into its
subject) is worked around in the scripted test.

## Verification and limits

- Frozen install, lint, workspace typecheck, all **268 tests** (forced
  uncached) and the duplication check pass locally; the eval scripts pass a
  focused TypeScript check. Web and desktop code are unchanged.
- The migration is forward-only and additive: three new nullable/defaulted
  `AgentRun` columns with indexes, `AgentDefinition` with two built-in rows and
  `AgentMessage`. A live-database diff against the Prisma schema shows no drift
  in the new objects.
- Scripted tests (faux model, real Postgres and Redis) cover journaled spawn and
  replay, ambient spawn blocking, tool narrowing, proposals, runtime-set status,
  atomic result posting, replay without repost, in-turn delegation, depth and
  fan-out limits, step and tree-cost budgets, cascade cancel with an abort
  mid-call, cross-user ownership, steering through `message_agent`, running and
  active per-user limits, stale-agent recovery, the runtime context listing,
  target tagging and a chat turn → agent → ambient notification round trip.
- Limits: there is no agent UI yet (users manage agents through chat). A chat
  "stop" aborts the current turn but not background agents. User-owned
  definitions are supported by the schema and lookup but have no API yet (the
  hook for named bots). Mail in the live gate is synthetic. pi stays pinned at
  1.6.0 and no dependency changed.

## Published evidence

The completion gate is
[`eval/2026-11-23-harness-phase-3-4-completion`](https://github.com/First-Principle-Lab/Mimir/tree/eval/2026-11-23-harness-phase-3-4-completion).
It tests `64d4e1dd533ae760feffd59f6e8995f1a4cf5a09`: Phase 4 with findings 11–13 fixed, merged with `dev`
(Phase 3 and #7), which is the tree that lands in `dev`. The earlier pre-review run
[`eval/2026-11-23-harness-phase-4-subagents`](https://github.com/First-Principle-Lab/Mimir/tree/eval/2026-11-23-harness-phase-4-subagents)
on `9b26a46` also passed 38/38 and 12/12; its figures follow. Both use actual
OpenRouter inference using `~deepseek/deepseek-v4-flash-latest` for both the
interaction agent and agents:

- **38/38 scenarios pass:** 12 Phase 1 (now also forbidding `spawn_agent` on
  short requests), 11 Phase 2, 10 Phase 3 and 5 Phase 4 cases.
- **12/12 red-team checks pass.**
- Phase 4 task costs, each against the USD 0.50 cap: background research
  USD 0.0006, cancel USD 0 (canceled before it ran), correction USD 0.0015
  (re-briefed through cancel and respawn, 2 helpers), proposed write
  USD 0.0011, fan-out USD 0.0024 (3 helpers).
- In `background-research` the chat reply arrives while the agent is queued,
  and a second question is answered before the agent finishes.

Exploratory single-scenario runs during development are not gate evidence.
