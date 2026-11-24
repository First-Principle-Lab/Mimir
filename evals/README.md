# Evals

Every eval run is published to its own branch, `eval/<YYYY-MM-DD>-<suite>-<topic-slug>`. Check out
the branch to see exactly which code was tested and what came out. Runs are **not** committed to `dev`,
`staging` or `main`.

## Run one

```sh
scripts/eval/run.sh retrieval "supersede fix for manager facts"          # creates the branch locally
scripts/eval/run.sh retrieval "supersede fix for manager facts" --push   # …and pushes it
```

Or open GitHub → Actions → **eval** → *Run workflow*, and pick a suite, topic and ref. The nightly
run evaluates `dev` with the topic `nightly`.

The runner refuses to start on uncommitted changes, because the branch has to match what was tested.

## What a run branch contains

The tested commit, plus one commit adding `evals/runs/<run-id>/`:

| File | Contents |
|---|---|
| `README.md` | Topic, suite, status, tested commit, runner, the last lines of output |
| `meta.json` | The same, machine-readable |
| `output.log` | Full output of the suite |
| `*.jsonl` | Result rows the suite wrote during this run (`retrieval.jsonl`, `query.jsonl`, `locomo-*.jsonl`) |
| `model-config.json` | The model configuration at the tested commit |

Status comes from the suite's exit code: `passed` (0), `failed` (1), `not run` (2, for example no
`OPENROUTER_API_KEY`).

## Find runs

```sh
git fetch origin 'refs/heads/eval/*:refs/remotes/origin/eval/*'
git branch -r --list 'origin/eval/*' --sort=-committerdate
git show origin/eval/2026-11-23-retrieval-nightly:evals/runs/   # list the run directory
```

## Suites

| Suite | Script | Needs |
|---|---|---|
| `retrieval` | `scripts/eval-retrieval.ts` — memory recall gate over `fixtures/` (fails under 90% recall) | Postgres (pgvector), `OPENROUTER_API_KEY` |
| `query` | `scripts/eval-query.ts` — response A/B with and without retrieved facts, LLM judge | Postgres, `OPENROUTER_API_KEY` |
| `locomo` | `scripts/eval-locomo.ts` — daily 50-question sample of the public LoCoMo benchmark | Postgres, `OPENROUTER_API_KEY` |
| `harness` | `scripts/eval-harness.ts` — live interaction model, synthetic read tools, deterministic scenario scoring | local Postgres/pgvector, Redis, `JWT_SECRET`, `OPENROUTER_API_KEY` |

Never merge, rebase or delete `eval/*` branches; they are the record.

The `memory` suite (`bun run eval-memory`) exercises the provider boundary,
real-inference context compaction and the transition memory reference. Its frozen
protocol and de-identified workload are in [memory/README.md](memory/README.md).
It requires local Postgres/Redis and the OpenRouter key. It records measured
baseline failures without claiming an external provider comparison; the five
candidate trials remain Phase 7 work.

The `hardening` suite (Phase 6) runs two API processes, the production job wrappers,
restricted-role RLS and multi-user chat/agent/watcher load, followed by actual model
inference. It requires local Postgres/Redis and OPENROUTER_API_KEY, exclusively uses
Redis DB 9 and cleans synthetic data. `HARDENING_SCALE=2` doubles its load. Run it
sequentially with other database-backed suites. It is available in the manual eval
workflow; nightly harness/memory/retrieval suites remain unchanged. Immutable runs
also report `mimir_eval_pass` when an OTLP endpoint is configured; a failed or not-run
suite reports zero. Hosted staging and actual Slack verification are separately
required by [the phase gate](../docs/phase-6-review.md).
