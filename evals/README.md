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
| `harness` | *Planned (plan.md Phase 0):* scenario suite for when and what the assistant replies | — |

Never merge, rebase or delete `eval/*` branches; they are the record.
