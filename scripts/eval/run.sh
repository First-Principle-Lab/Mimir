#!/usr/bin/env bash
# Run one eval suite and publish the run to its own eval/<date>-<suite>-<topic> branch.
# The branch is the tested commit plus one commit adding evals/runs/<run-id>/.
#
# Usage: scripts/eval/run.sh <suite> "<topic>" [--push]
#   suite: retrieval | query | locomo | harness
# Exit code: the suite's own exit code (0 pass, 1 fail, 2 not run), so CI can gate on it.
set -euo pipefail

suite="${1:-}"
topic="${2:-}"
push="${3:-}"
case "$suite" in
  retrieval | query | locomo | harness) ;;
  *) echo "usage: scripts/eval/run.sh <retrieval|query|locomo|harness> \"<topic>\" [--push]" >&2; exit 64 ;;
esac
[ -n "$topic" ] || { echo "a topic is required: say what this eval run is about" >&2; exit 64; }

root="$(git rev-parse --show-toplevel)"
cd "$root"

# The branch must match what was tested, so refuse to run on uncommitted changes.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "working tree has uncommitted changes; commit them first" >&2
  exit 64
fi

sha="$(git rev-parse HEAD)"
short="$(git rev-parse --short HEAD)"
source_ref="${EVAL_SOURCE_REF:-$(git rev-parse --abbrev-ref HEAD)}"
slug="$(printf '%s' "$topic" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40 | sed -E 's/-+$//')"
day="$(date -u +%Y-%m-%d)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$suite"

branch="eval/$day-$suite-$slug"
n=2
while git show-ref --quiet "refs/heads/$branch" || git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; do
  branch="eval/$day-$suite-$slug-$n"
  n=$((n + 1))
done

work="$(mktemp -d)"
trap 'git worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
out="$work/run"
mkdir -p "$out"

# Eval scripts append rows to results/eval-runs/*.jsonl (gitignored, kept across local runs).
# Record each file's length now and keep only the rows this run adds.
rows_dir="$root/results/eval-runs"
declare -A before=()
if [ -d "$rows_dir" ]; then
  for f in "$rows_dir"/*.jsonl; do
    [ -e "$f" ] && before["$(basename "$f")"]="$(wc -l < "$f")"
  done
fi

started="$(date -u +%FT%TZ)"
set +e
# CI=true makes a missing key or database exit 2 ("not run") instead of a silent local skip.
CI=true bun run "eval-$suite" 2>&1 | tee "$out/output.log"
code="${PIPESTATUS[0]}"
set -e
finished="$(date -u +%FT%TZ)"

if [ -d "$rows_dir" ]; then
  for f in "$rows_dir"/*.jsonl; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    tail -n +"$(( ${before[$name]:-0} + 1 ))" "$f" > "$out/$name"
    [ -s "$out/$name" ] || rm -f "$out/$name"
  done
fi
# Same lookup as openrouter.ts: the gitignored override, else the committed example.
cp packages/backend-core/model-config.json "$out/model-config.json" 2>/dev/null \
  || cp packages/backend-core/model-config.example.json "$out/model-config.json" 2>/dev/null || true

case "$code" in
  0) status="passed" ;;
  1) status="failed" ;;
  2) status="not run" ;;
  *) status="error (exit $code)" ;;
esac

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  runner="ci"
  run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
else
  runner="local"
  run_url=""
fi

TOPIC="$topic" SUITE="$suite" STATUS="$status" CODE="$code" SHA="$sha" SOURCE_REF="$source_ref" \
BRANCH="$branch" RUN_ID="$run_id" STARTED="$started" FINISHED="$finished" RUNNER="$runner" RUN_URL="$run_url" \
OUT_DIR="$out" bun -e '
    const e = process.env;
    const meta = {
      topic: e.TOPIC, suite: e.SUITE, status: e.STATUS, exitCode: Number(e.CODE),
      testedCommit: e.SHA, testedRef: e.SOURCE_REF, branch: e.BRANCH, runId: e.RUN_ID,
      startedAt: e.STARTED, finishedAt: e.FINISHED, runner: e.RUNNER, runUrl: e.RUN_URL || null,
    };
    await Bun.write(e.OUT_DIR + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
  '

{
  echo "# Eval: $topic"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Suite | \`$suite\` |"
  echo "| Status | **$status** (exit $code) |"
  echo "| Tested commit | \`$sha\` (from \`$source_ref\`) |"
  echo "| Started / finished (UTC) | $started / $finished |"
  echo "| Runner | $runner${run_url:+ ([run]($run_url))} |"
  echo
  echo "## Summary"
  echo
  echo '```'
  grep -vE '^\s*$' "$out/output.log" | tail -n 25 || true
  echo '```'
  echo
  echo "## Files"
  echo
  for f in "$out"/*; do echo "- \`$(basename "$f")\`"; done
} > "$out/README.md"

git worktree add --quiet --detach "$work/tree" "$sha"
mkdir -p "$work/tree/evals/runs"
cp -r "$out" "$work/tree/evals/runs/$run_id"
git -C "$work/tree" checkout --quiet -b "$branch"
git -C "$work/tree" add "evals/runs/$run_id"
git -C "$work/tree" -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo mimir-eval)}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo mimir-eval@users.noreply.github.com)}" \
  commit --quiet -m "eval($suite): $topic" -m "Status: $status (exit $code). Tested commit: $sha ($source_ref)."

if [ "$push" = "--push" ]; then
  git -C "$work/tree" push --quiet origin "$branch"
  echo "published $branch"
else
  echo "created $branch (local; push with: git push origin $branch)"
fi

echo "eval_branch=$branch" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "eval_status=$status" >> "${GITHUB_OUTPUT:-/dev/null}"
exit "$code"
