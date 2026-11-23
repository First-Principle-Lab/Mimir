# Memory readiness protocol (v1)

Frozen before the first Phase 5 run. This is the transition reference and adapter
readiness gate. It does not select or rank external providers. Phase 7 runs all
five candidates after the staging prerequisites in plan.md.

The six synthetic fixtures reconstruct task patterns observed with authorization
in ChatGPT and Claude: application lists with a changed output channel, a company
research article requiring primary evidence, corrections to dated plans, and
precise project details far back in noisy conversation. All names, dates,
identifiers and wording are synthetic. Raw private history must never enter git,
stdout, result rows or published eval branches.

Two development cases are separate from four held-out cases. Do not tune on the
held-out results; any protocol/fixture change requires a new version. The history
sizes are 16, 128 and 512 intervening user/assistant pairs. Record actual message
counts, characters and estimated tokens rather than calling them unlimited chats.
Use the same transcript and queries for every candidate. Ingest in 16-message
batches to match incremental application use, then test the held-out question.
Record ingestion time, search time, answer correctness, extracted facts and
unsupported facts, per-case and aggregate results. Search and answer output must
carry source references. The baseline uses the existing extraction and retrieval
implementation behind the common gateway. It is not an additional candidate.

Phase 5 mandatory gates: all owner/scope, correction/forget, credential rejection,
timeout, output-reference, prompt-order/session-ID and compaction/reload checks
pass. Live pi inference must answer each ready-path scenario correctly. Baseline
extraction misses and false positives are reported honestly as transition defects;
they are not hidden by manually seeding the measured extraction workload.

Before Phase 7 comparisons, the fixed qualification targets are: >=95% fact
precision, >=90% fact recall and grounded answer correctness in each history-size
bucket; zero invented facts, stale current facts after corrections, isolation
leaks or resurfaced deleted facts. Retrieval p95 <=3 seconds warm and <=5 seconds
cold; added chat latency p95 <=5 seconds; new facts searchable p95 <=30 seconds.
Ingestion is measured separately from retrieval. Report p50/p95 over at least
three repeats and label smaller samples descriptive only. Freeze hardware,
versions, models, native defaults, concurrency and budgets before those trials.
Record tokens/cost and graph/background preparation separately. Missing access or
infrastructure means incomplete, never pass. A low-latency quality failure cannot
win. Live service cache-read counters are observations: zero hits are a result,
not proof that a provider supports caching. Mimir tests stable request prefixes
and records provider-reported cached tokens without inventing a hit-rate floor.
