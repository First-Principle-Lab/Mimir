# Late-stage memory system evaluation

Decision: adopt an existing memory system. Evaluate Mem0, Letta, Cognee,
Supermemory and Graphiti after Mimir's application and staging prerequisites
are ready. This document plans the work; it contains no benchmark results or
provider selection.

## Sequence and prerequisites

1. Complete Phase 4's agent lifecycle and Phase 5's context, adapter, migration
   inputs and shared evaluation fixtures.
2. Complete Phase 6's staging, isolation, budgets and observability work and
   the phase completion gates. Keep existing facts usable during preparation.
3. In Phase 7, install/configure and run all five candidates, then publish the
   comparison report. Choose and integrate a system using the measured results.
4. Verify the final integration and migration in staging before production
   promotion. User-visible memory features use the selected provider's adapter.

Mimir supplies the application boundary: authentication, user/agent namespaces,
tool policy, secret filtering, source identifiers, timeouts and usage tracking.
The adopted system supplies memory storage, extraction, update and retrieval.
Preparation does not include building a new extraction/retrieval engine or
extending Mimir's current graph as a competing product.

## Candidates

| Candidate | Required trial |
| --- | --- |
| Mem0 | Supported memory ingestion, update, retrieval and deletion through the common adapter |
| Letta | Its supported memory interface; document any required agent/runtime coupling |
| Cognee | Its supported ingestion and retrieval path, including graph preparation costs |
| Supermemory | Its supported memory API; record account, service and rate-limit requirements |
| Graphiti | Its supported temporal graph ingestion, updates and retrieval, including infrastructure costs |

Verify current versions, supported APIs, licenses and hosted/self-hosted options
when trials begin. Record the mode actually tested for each candidate; the table
does not claim that all offer the same deployment or integration model. Missing
access or infrastructure leaves that trial incomplete, with the blocker recorded.

## Shared workloads and measurements

Use identical transcripts, questions, expected facts and source references for
each candidate. Freeze the dataset, quality thresholds and latency budgets before
runs. Use a held-out set for final comparison, after tuning on a separate set.
Keep extraction/embedding models and budgets comparable where supported, and
record unavoidable differences, native defaults and any extra services.

| Priority | Cases | Measurements |
| --- | --- | --- |
| Speed | Cold/warm ingestion and retrieval, growing history, concurrent users | p50/p95 ingestion and retrieval latency, time until a new fact is searchable, added end-to-end chat latency, throughput and timeouts |
| Long chats | Increasing message/token counts, many sessions, distant facts among noise, multi-hop questions, changed preferences and dates | Recall and answer correctness by history size and fact age, evidence attribution, stale-fact errors and degradation as history grows |
| Relevant fact extraction | Annotated durable facts, transient chatter, repeated facts, corrections, contradictions and irrelevant content | Precision, recall/F1, invented facts, missed facts, duplicates, irrelevant retained facts and correction handling |

Reuse suitable retrieval/query/LoCoMo fixtures and add realistic de-identified or
synthetic Mimir chats. Report dataset sizes and token counts. Evaluate with actual
models through the prepared Mimir path; mocked responses support fault tests but
do not count as candidate performance evidence. Match self-hosted hardware where
possible and identify managed services whose hardware cannot be controlled.

Also test user/agent isolation, forget/delete, export/migration, provenance,
sensitive-data filtering and outage recovery. Record model/API and infrastructure
costs, including graph construction, background processing and operational work.
Do not rank a fast system as the winner if it misses the agreed quality or
isolation requirements.

## Evidence, report and selection

Add a `memory-systems` suite to `scripts/eval/run.sh` during Phase 7. Save exact
versions/configuration, dataset identifiers, tested commit, raw measurements and
per-case results on immutable `eval/...` branches. Keep private content and
credentials out of this public repository. Distinguish failed, incomplete and
passing runs; a skipped or inaccessible candidate is not an evaluated candidate.

After all five trials finish, publish
`docs/research/memory-systems-evaluation.md` covering:

- The environment, protocol, configurations, repeated runs and evidence links.
- Side-by-side speed, long-chat and extraction results, including tail latency,
  costs, failures and limitations; distinguish measured results from vendor claims.
- Integration effort, hosting/licensing, data controls and migration feasibility.
- A recommendation with explicit tradeoffs and any unmet requirements. If no
  candidate qualifies, report that outcome and reassess systems/configurations.

Then integrate the selected system, verify retained-fact migration and rerun the
relevant actual-inference, security and latency gates. Adapt CI to the selected
provider and confirm the complete agent path in staging before launch.
