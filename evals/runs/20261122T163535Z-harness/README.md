# Eval: phase 1 read-only pi harness

| | |
|---|---|
| Suite | `harness` |
| Status | **passed** (exit 0) |
| Tested commit | `f5444b78c476be31f943e85fe8368eba1e8de5a7` (from `feat/phase1-pi-harness`) |
| Started / finished (UTC) | 2026-11-22T16:35:35Z / 2026-11-22T16:36:00Z |
| Runner | local |

## Summary

```
$ bun scripts/eval-harness.ts
PASS direct-answer
PASS combined-request
PASS hedged-calendar
PASS local-midnight
PASS weekday
PASS write-refusal
PASS deferred-tool
Harness: 7/7 passed (real model, synthetic tools).
```

## Files

- `README.md`
- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
