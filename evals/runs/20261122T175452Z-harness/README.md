# Eval: phase 2 inbox completion review

| | |
|---|---|
| Suite | `harness` |
| Status | **passed** (exit 0) |
| Tested commit | `dc83533f5e130d4700a54b5087237d50802e3d9b` (from `feat/phase-2-inbox`) |
| Started / finished (UTC) | 2026-11-22T17:54:53Z / 2026-11-22T17:59:45Z |
| Runner | local |

## Summary

```
PASS relevant-worker-result
{"level":30,"time":1795370170886,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-28eb6f33-c2ba-49bc-97c4-63038597f742","socketId":"pinnAC-SEhd0lktFAAAL","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795370170899,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-a82e873f-e01d-4dbe-9ec0-862bf3c148e3","socketId":"W_1UkSF9BTyKK30dAAAN","open":1,"msg":"socket connected"}
{"level":30,"time":1795370180147,"pid":486930,"hostname":"omarchy","conversationId":"1968ff0b-4112-4937-825d-2a1144ce08ba","runId":"8fe9ee08-a4b7-4938-8fc4-17cace601701","promptTokens":3107,"completionTokens":246,"costUsd":0.00055762,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":9183,"msg":"harness run settled"}
PASS watcher-match
{"level":30,"time":1795370180150,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-a82e873f-e01d-4dbe-9ec0-862bf3c148e3","socketId":"W_1UkSF9BTyKK30dAAAN","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795370180163,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-794a893d-6bc4-40cd-8e76-6e5e1bbace18","socketId":"AuyBWPzsQhYa-CptAAAP","open":1,"msg":"socket connected"}
{"level":30,"time":1795370185376,"pid":486930,"hostname":"omarchy","conversationId":"49b8ebcb-08fd-4d60-a047-0e0835c8132b","runId":"49fc2a14-9322-45ea-a9a8-de8d837fe0e0","promptTokens":786,"completionTokens":244,"costUsd":0.00025516,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":5148,"msg":"harness run settled"}
PASS requested-reminder
{"level":30,"time":1795370185380,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-794a893d-6bc4-40cd-8e76-6e5e1bbace18","socketId":"AuyBWPzsQhYa-CptAAAP","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795370185394,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-82fffa8d-39b9-466d-9c41-04f9528d7efa","socketId":"9jtkHcsJoJdannpBAAAR","open":1,"msg":"socket connected"}
{"level":30,"time":1795370193548,"pid":486930,"hostname":"omarchy","conversationId":"a67e5ff7-0d58-45ed-a47d-d3af00aaa1e8","runId":"998d9d81-e1be-4e65-a2b6-cc9a5c781640","promptTokens":7170,"completionTokens":253,"costUsd":0.00055524,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":8085,"msg":"harness run settled"}
PASS quiet-hours
{"level":30,"time":1795370193623,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-82fffa8d-39b9-466d-9c41-04f9528d7efa","socketId":"9jtkHcsJoJdannpBAAAR","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795370193637,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-c9f5454e-a294-4369-907b-dbeb6274203b","socketId":"DNkFSV1YHHIqiaE1AAAT","open":1,"msg":"socket connected"}
{"level":30,"time":1795370199248,"pid":486930,"hostname":"omarchy","conversationId":"461fa342-8509-4d34-a64e-1fee02629dbe","runId":"f98a15c5-e108-4e98-9478-47056200c3f3","promptTokens":3611,"completionTokens":245,"costUsd":0.00062278,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":5543,"msg":"harness run settled"}
PASS digest
{"level":30,"time":1795370199270,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-c9f5454e-a294-4369-907b-dbeb6274203b","socketId":"DNkFSV1YHHIqiaE1AAAT","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795370199284,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-e62f80bd-1353-4c00-a020-18dd6c13cf63","socketId":"5lPXevVmVVNRzebsAAAV","open":1,"msg":"socket connected"}
{"level":30,"time":1795370199320,"pid":486930,"hostname":"omarchy","conversationId":"9331432a-92e8-4301-a972-3c01ad5e94c5","messageId":"defdea81-01a1-4d53-b34a-416d96274e9e","msg":"user message recorded; turn queued"}
{"level":30,"time":1795370203767,"pid":486930,"hostname":"omarchy","conversationId":"9331432a-92e8-4301-a972-3c01ad5e94c5","runId":"9a6f3f3f-2d7a-4827-8781-bdf0717738b4","promptTokens":4445,"completionTokens":148,"costUsd":0.00036054200000000005,"steps":2,"toolCalls":1,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":3327,"msg":"harness run settled"}
{"level":30,"time":1795370385313,"pid":486930,"hostname":"omarchy","conversationId":"9331432a-92e8-4301-a972-3c01ad5e94c5","runId":"491cefe5-84d0-49a0-8856-5d4329092703","promptTokens":3254,"completionTokens":229,"costUsd":0.0005836799999999999,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":5811,"msg":"harness run settled"}
PASS schedule-end-to-end
{"level":30,"time":1795370385319,"pid":486930,"hostname":"omarchy","userId":"inbox-eval-e62f80bd-1353-4c00-a020-18dd6c13cf63","socketId":"5lPXevVmVVNRzebsAAAV","open":0,"msg":"socket disconnected"}
Inbox: 11/11; notification precision 1, recall 1, wrongly silent 0. Targets: 1.0/1.0/0 on these fixtures.
```

## Files

- `README.md`
- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
