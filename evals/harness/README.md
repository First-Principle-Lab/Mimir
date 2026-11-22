# Harness scenarios

Run `bun run eval-harness` with `OPENROUTER_API_KEY`, or publish an immutable run
with `scripts/eval/run.sh harness "phase 1 read-only harness" --push`.

The runner calls the configured interaction model through the production pi
session, prompt, tool schemas, discovery and policy gate. Integration results
are synthetic; it never accesses a real account. Scoring compares requested
tool calls, forbidden actions, required/forbidden/optional replies, text fragments
and local-date arguments. A missing key exits 2 and is never reported as a pass.

Phase 1 covers direct answers, combined requests, hedged phrasing, time zones,
weekdays, deferred tools and the read-only boundary. CI runs scripted protocol
tests separately from this live-model behavior eval. Inbox groups (bursts,
mid-task corrections, nothing-new results, misfired triggers and quiet hours)
will be added with Phase 2; this suite does not claim coverage for them yet.
