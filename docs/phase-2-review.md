# Phase 2 implementation review

Scope: all Phase 2 changes, including API intake, worker/session integration,
forward migration, delivery, web client, watchers and scheduling. Phase 3 has not
started. Findings are resolved and the immutable real-inference evaluation passes.
Required CI passed on `002e5d7`; PR #4 was squash-merged into `dev` as
`ab80704` after the follow-up audit below. Phase 2 is complete.

## Requirement audit

| Planned requirement            | Implementation and verification                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed, source-tagged inbox     | InboxInput stores user, agent_result, event, routine_fire and approval_answer inputs with sequence, source, dedupe key and consumption/reply state. HTTP only creates user inputs; internal ingress validates ownership and payloads. Approval execution remains Phase 3.                                                                                                                     |
| Serialization and debounce     | Retains the token-checked conversation Redis lease and pi ownership. A 1-second quiet window is capped at 10 seconds. One answer links all burst inputs; HTTP replay and client pending-state correlation cover each.                                                                                                                                                                         |
| Steering and stop              | The owning worker polls durable inputs across processes. pi applies corrections after the tool batch. Standalone stop or explicit control aborts inference/tools and delivers a correlated Stopped response. The web composer accepts corrections during work and exposes stop when empty.                                                                                                    |
| Reply owed / ambient contracts | User inputs require a visible reply. Ambient text never streams; only the interaction agent's send_to_user creates notifications. NO_REPLY is ambient-only. One empty-answer recovery and one delivery nudge are bounded and tested. Setup failures also settle user replies.                                                                                                                 |
| Durable delivery and receipts  | Message, Delivery and outbox rows commit together. API senders claim leases, retry unavailable channels, and recover through polling/reconnects. Socket receipts require authenticated client ACKs; push receipts record provider acceptance, not human reading.                                                                                                                              |
| Quiet hours and digests        | User-scoped preference endpoints configure local quiet hours and digest intervals. Local-time checks handle DST/midnight; urgent notifications and explicit replies bypass deferral. Due low-priority notifications group per user/conversation. Push tags collapse retries.                                                                                                                  |
| Per-routine watchers           | BullMQ schedules routines independently. Scratch stores checked fingerprint and last acknowledged occurrence. Empty/unchanged results skip inference. Immutable observations, inbox wakes and outbox events commit atomically. Wakes carry references; channel_read enforces occurrence/owner checks and fences untrusted content centrally. Verified webhook hints re-read an owner's query. |
| Schedule tool                  | Add/list/update/enable/disable/remove; once, interval, cron/timezone and idle timing. Defaults to the user's validated timezone. Postgres/outbox synchronize BullMQ without resetting unchanged timers. Idle fires once per inactivity period. Ambient turns cannot create schedules. Disabled/removed routines cannot notify from stale fires.                                               |
| Side effects and capabilities  | Internal mutation tools write ActionAttempt before execution and use idempotent IDs. Connected accounts remain read-only; arbitrary MCP, external sends and other writes stay blocked. Dependencies and resource discovery are unchanged.                                                                                                                                                     |
| Notification exit criteria     | Real inference covers bursts, corrections, stop, quiet hours/digest, nothing-new and misfired inputs, positive worker/watcher results, requested reminders and a delayed BullMQ schedule fire. Fixture targets: precision 1.0, recall 1.0, zero wrongly silent requested replies.                                                                                                             |

## Findings and resolutions

1. User-prioritized jobs could strand their ambient input. A fresh unique outbox
   wake preserves remaining work; periodic recovery repairs pending inputs and
   routine timers if queue state is lost.
2. Fingerprint persistence could precede a watcher's wake. Observation, scratch,
   inbox and outbox now commit together. Immutable observations also prevent
   queued reads from accidentally seeing a later occurrence.
3. Repeated schedule sync could reset timers. Unchanged timers are preserved;
   timing keys reject stale revised jobs.
4. Already-told state initially advanced when queued. It now advances on client
   ACK or push acceptance.
5. Queued fires could notify after cancellation. Intake filters stale routines;
   the notification tool checks current active ownership before writing.
6. Retained Phase 1 jobs have message-keyed runs without inbox IDs. Compatibility
   intake links existing runs, preserving answered-job replay without inference.
7. Abort signals did not reach ToolSpecs. The wrapper forwards signals and stops
   waiting on interrupted reads, so stop settles even if an upstream read hangs.
8. One expanded worker-result fixture put notification authorization only in
   untrusted worker text. It now includes the actual prior user request as native
   history; a worker's claim is never promoted into a trusted instruction.

9. The first published gate hit provider latency beyond the scheduling fixture's
   20-second deadline. The scheduler correctly rejected the past instant. The
   fixture now schedules beyond the whole-turn timeout and waits for the actual
   delayed BullMQ fire; no production clock or scheduling policy is bypassed.

## Validation and limits

- Workspace lint, typecheck, **227 tests** across six workspaces, duplication
  check and static web export pass locally. Both evaluation scripts also pass
  a focused TypeScript check.
- A temporary database was migrated through Phase 1, seeded with synthetic chat
  history, then upgraded through Phase 2. The message/default reply list survived;
  all seven new tables existed. The temporary database was removed afterward.
- Scripted tests cover blocked-read stop, steering, recovery, replay, locks,
  source/receipt ownership, quiet-hour DST, digest grouping, watcher dedupe,
  immutable reads, scheduler replay and stale fires.
- Live evaluations use synthetic accounts and local Postgres/Redis. Provider
  transports retain separate integration tests. Gmail webhook hints match the
  login mailbox; alternate connected mailboxes use per-routine polling.
- Delivery is at least once with stable IDs and receipt dedupe. Socket emission
  and push acceptance do not establish human reading. Native desktop compilation
  succeeds here but Linux bundling fails at linuxdeploy; packaging is outside the
  CI gate, and the required static export passes.

## Published evidence

- Tested commit: `dc83533f5e130d4700a54b5087237d50802e3d9b`.
- Model: `~deepseek/deepseek-v4-flash-latest`, actual OpenRouter inference.
- Result: **23/23 scenarios pass**: all 12 Phase 1 regressions plus 11 Phase 2
  scenarios. Notification precision **1.0**, recall **1.0**, wrongly silent **0**
  on these fixtures. The final reminder fires at its requested time on BullMQ.
- Immutable evidence: [eval/2026-11-22-harness-phase-2-inbox-completion-review-2](https://github.com/First-Principle-Lab/Mimir/tree/eval/2026-11-22-harness-phase-2-inbox-completion-review-2/evals/runs/20261122T175452Z-harness).
  Its meta.json records the tested SHA; harness.jsonl and output.log contain the
  scenario results and inference/delivery evidence.
- The previous published run records the scheduling fixture's deadline failure;
  no eval branch was amended, merged, rebased or deleted.
- Subsequent Phase 2 changes only record evidence and strengthen regression tests.
  Required CI passed on the final feature head `002e5d7`, before Phase 3 began.

## Follow-up review

The follow-up audit rechecked the requirement matrix against intake, pi turn
ownership and steering, response tools, delivery leases and receipts, routine
observations, scheduler synchronization, migration and web reply correlation.
No additional implementation defect was found. Three regression tests now cover
an ACK arriving during an active delivery, recovery after a sender's lease
expires, and stale fires after a routine's timing changes or it is disabled.

Frozen install, lint, typecheck, all **230 tests** (forced uncached), duplication
check and the static export pass. The runtime, prompts and tool descriptions are
unchanged from the published 23/23 inference run. Required CI passed on
`8baa55a5b5bb47bd6072dc9cfdf092a2364846f6` and the final test/review head
`002e5d7aaf01eb9d5df9ef5366c0777f42842bd8`. The phase completion gate passed
before PR #4 was merged and Phase 3 started.
