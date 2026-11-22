# Harness scenarios

Run `bun run eval-harness` with `OPENROUTER_API_KEY`, local Postgres/pgvector and
Redis (`DATABASE_URL`, `REDIS_URL`), and `JWT_SECRET`. Apply migrations first.
The runner refuses remote database/Redis hosts and exits 2 without a model key.
Publish immutable evidence from a clean commit with:

```sh
scripts/eval/run.sh harness "phase 1 completion review" --push
```

Each scenario uses authenticated HTTP intake, an isolated BullMQ queue, the
production turn processor and pi session/prompt/tool registry, real model
inference, Postgres journals, Redis pub/sub and an authenticated socket client.
Only account responses and the clock are synthetic. No private account is read.
Fixtures and the private queue are removed after the run.

Deterministic scoring checks tools, forbidden actions, visible replies, content,
write refusals, untrusted instructions and exact calendar intervals. Every turn
also verifies successful inference/token accounting, durable session/run/step
journals, streaming and settlement, and idempotent HTTP/worker replay. Results
include those checks with tool arguments and final text; skipped inference is
never a passing evaluation.

Phase 1 covers direct answers, combined requests, hedged phrasing, local dates,
DST, weekday, invalid zones, discovery, write restrictions, session rehydration
and legacy-history bootstrap. Scripted tests separately cover protocol faults,
policy enforcement and ownership. Inbox groups (bursts, mid-task corrections,
background results, misfired triggers and quiet hours) run in Phase 2 through
scripts/eval-inbox.ts, included by bun run eval-harness. It also covers stop,
positive watcher findings, requested reminders, digest delivery and a real delayed
BullMQ schedule fire. Notification fixture targets are precision/recall 1.0 and
zero wrongly silent requested replies. Scripted tests cover empty-answer recovery
and the single delivery nudge without relying on the model to misbehave.

Phase 3 adds scripts/eval-safe-writes.ts and apps/worker/src/redteam.ts to the
same harness command. Ten live-model scenarios cover approved email, declined
calendar invitations, corrected GitHub cards, Notion, browser forms, tainted
read-to-send, injected mail, unattended drafts, Composio meta-tools and an
accepted-then-failed browser action with an injected provider error. They use
the production schemas, policy, journals, HTTP card decisions, resumed pi run,
BullMQ and socket delivery; only provider account responses/browser submissions
are synthetic. Provider fixtures reject any side effect without a prior journal
row. The safe-write runner appends tool arguments, risk/reason, action counts and
run state to the result rows. Draft notifications may join a low-priority digest;
the delivery clock advances past that window before requiring a socket receipt.
A single-case exploratory run may set
EVAL_SAFE_WRITE_SCENARIO; published completion gates run the full suite without it.

Scripted coverage includes an actual SIGKILL after a synthetic provider accepts
an action, before its success is journaled. Recovery must mark it interrupted
and never repeat it. A separately committed success is reported from the journal.
