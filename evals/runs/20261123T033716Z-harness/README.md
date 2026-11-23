# Eval: phase-3-review-fixes

| | |
|---|---|
| Suite | `harness` |
| Status | **failed** (exit 1) |
| Tested commit | `b1352144202d2450a115b800e6c9a945c16760a3` (from `feat/phase-3-safe-writes`) |
| Started / finished (UTC) | 2026-11-23T03:37:17Z / 2026-11-23T03:42:45Z |
| Runner | local |

## Summary

```
{"level":30,"time":1795405149888,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-88143f9f-343f-455a-aecf-30bdc900cbc2","socketId":"o7CY_MvuTdsms8GFAAAN","open":1,"msg":"socket connected"}
{"level":30,"time":1795405157780,"pid":1578978,"hostname":"omarchy","conversationId":"02b80175-ea3d-489b-81f4-e9083e9f659e","runId":"86641a43-3345-46b4-bd25-d9d3bcd6971e","promptTokens":5024,"completionTokens":260,"costUsd":0.000445424,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":7790,"msg":"harness run settled"}
PASS watcher-match
{"level":30,"time":1795405157784,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-88143f9f-343f-455a-aecf-30bdc900cbc2","socketId":"o7CY_MvuTdsms8GFAAAN","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795405157807,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-9f2dfaa0-0627-46d4-b665-c95f85d1e93e","socketId":"GbjiLWKmneB-wJUnAAAP","open":1,"msg":"socket connected"}
{"level":30,"time":1795405164492,"pid":1578978,"hostname":"omarchy","conversationId":"3104c846-73ef-4d27-8f2b-e3347f91eaa8","runId":"a62487c9-291e-486a-9e79-f7cb07ccd4de","promptTokens":4713,"completionTokens":244,"costUsd":0.000424998,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":6555,"msg":"harness run settled"}
PASS requested-reminder
{"level":30,"time":1795405164496,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-9f2dfaa0-0627-46d4-b665-c95f85d1e93e","socketId":"GbjiLWKmneB-wJUnAAAP","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795405164518,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-e8a62107-e4d7-4e73-b069-b959c50969c4","socketId":"uSlzU0cS1iuaZzGIAAAR","open":1,"msg":"socket connected"}
{"level":30,"time":1795405170080,"pid":1578978,"hostname":"omarchy","conversationId":"da951e74-3a2c-4ed2-a66c-d78b62947990","runId":"16e09ff4-ffc1-4b1c-9e74-0ea612a3dc34","promptTokens":7039,"completionTokens":253,"costUsd":0.000556822,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":5468,"msg":"harness run settled"}
PASS quiet-hours
{"level":30,"time":1795405170162,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-e8a62107-e4d7-4e73-b069-b959c50969c4","socketId":"uSlzU0cS1iuaZzGIAAAR","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795405170184,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-b492e294-3040-437d-90d9-a8c5d95d981c","socketId":"YNN7nbf9jgv00uWHAAAT","open":1,"msg":"socket connected"}
{"level":30,"time":1795405177283,"pid":1578978,"hostname":"omarchy","conversationId":"87f461ec-b707-49ba-88a5-f31243d7bd40","runId":"a3ea242e-452c-4a39-9ea8-4788dadadace","promptTokens":2986,"completionTokens":255,"costUsd":0.000330736,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":6999,"msg":"harness run settled"}
PASS digest
{"level":30,"time":1795405177315,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-b492e294-3040-437d-90d9-a8c5d95d981c","socketId":"YNN7nbf9jgv00uWHAAAT","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795405177338,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-a5c82739-1d00-4b7a-9d67-647b08b0ce25","socketId":"tgmfMttM6Ipp1bl-AAAV","open":1,"msg":"socket connected"}
{"level":30,"time":1795405177382,"pid":1578978,"hostname":"omarchy","conversationId":"12dda3ce-16bd-4b09-9023-1f6cdd27e298","messageId":"fdce9672-aac8-47eb-b57d-d5592824443d","msg":"user message recorded; turn queued"}
{"level":30,"time":1795405184446,"pid":1578978,"hostname":"omarchy","conversationId":"12dda3ce-16bd-4b09-9023-1f6cdd27e298","runId":"ac9a9ecb-24a9-4c56-bbe9-69cce1b7b4dc","promptTokens":4811,"completionTokens":152,"costUsd":0.000386722,"steps":2,"toolCalls":1,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":5989,"msg":"harness run settled"}
{"level":30,"time":1795405365743,"pid":1578978,"hostname":"omarchy","conversationId":"12dda3ce-16bd-4b09-9023-1f6cdd27e298","runId":"867ed6fc-e0db-46e2-90ff-e4b38824101a","promptTokens":10200,"completionTokens":219,"costUsd":0.0007446600000000001,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":8172,"msg":"harness run settled"}
PASS schedule-end-to-end
{"level":30,"time":1795405365748,"pid":1578978,"hostname":"omarchy","userId":"inbox-eval-a5c82739-1d00-4b7a-9d67-647b08b0ce25","socketId":"tgmfMttM6Ipp1bl-AAAV","open":0,"msg":"socket disconnected"}
Inbox: 11/11; notification precision 1, recall 1, wrongly silent 0. Targets: 1.0/1.0/0 on these fixtures.
error: Module not found "scripts/eval-safe-writes.ts"
error: script "eval-harness" exited with code 1
```

## Files

- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
- `README.md`
