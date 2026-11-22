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
background results, misfired triggers and quiet hours) belong to Phase 2.
