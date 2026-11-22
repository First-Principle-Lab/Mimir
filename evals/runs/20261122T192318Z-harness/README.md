# Eval: phase 3 safe writes completion review

| | |
|---|---|
| Suite | `harness` |
| Status | **failed** (exit 1) |
| Tested commit | `b16d48a6ad7d576ec163284aa5a4cf668f04d8e4` (from `feat/phase-3-safe-writes`) |
| Started / finished (UTC) | 2026-11-22T19:23:19Z / 2026-11-22T19:24:15Z |
| Runner | local |

## Summary

```
{"level":30,"time":1795375439759,"pid":656034,"hostname":"omarchy","conversationId":"dda5295e-2398-4897-9787-fd9ddcbdcb09","clientMessageId":"785b593a-650e-4859-99b0-a49b4313164e","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS invalid-timezone
{"level":30,"time":1795375439771,"pid":656034,"hostname":"omarchy","userId":"harness-eval-0c01d535-accf-482f-ae0d-78eb2ef1dd53","socketId":"HfH6XUvNG51cw4nTAAAR","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795375439785,"pid":656034,"hostname":"omarchy","userId":"harness-eval-facd42b8-c1a2-4733-baec-7eb8c5dc1ce5","socketId":"FMsgDSgeKdBfXoysAAAT","open":1,"msg":"socket connected"}
{"level":30,"time":1795375439817,"pid":656034,"hostname":"omarchy","conversationId":"ad6d689d-3d21-4cb5-89c3-04d67d240ac2","messageId":"249f21c2-1ed3-46fc-b2ff-eff5367ab945","msg":"user message recorded; turn queued"}
{"level":30,"time":1795375447472,"pid":656034,"hostname":"omarchy","conversationId":"ad6d689d-3d21-4cb5-89c3-04d67d240ac2","runId":"2145a13a-45a7-4aa5-b52d-2472d3e3ad4f","promptTokens":4064,"completionTokens":203,"costUsd":0.0005903752,"steps":4,"toolCalls":3,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":6531,"msg":"harness run settled"}
{"level":30,"time":1795375447477,"pid":656034,"hostname":"omarchy","conversationId":"ad6d689d-3d21-4cb5-89c3-04d67d240ac2","clientMessageId":"77f38f75-9501-4f44-90d2-b0193251c2f8","answered":true,"msg":"user message replayed (idempotent hit)"}
FAIL calendar-write-refusal: write request did not explain the read-only limitation
{"level":30,"time":1795375447486,"pid":656034,"hostname":"omarchy","userId":"harness-eval-facd42b8-c1a2-4733-baec-7eb8c5dc1ce5","socketId":"FMsgDSgeKdBfXoysAAAT","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795375447500,"pid":656034,"hostname":"omarchy","userId":"harness-eval-7dbf1e90-d587-4871-ac29-c9d97bf3df9b","socketId":"SooOrR0PHmN-g0VWAAAV","open":1,"msg":"socket connected"}
{"level":30,"time":1795375447532,"pid":656034,"hostname":"omarchy","conversationId":"d768375d-4e6c-4c99-af2a-89ec658037c6","messageId":"bc02232c-81ba-41da-85c9-3e22647d93f8","msg":"user message recorded; turn queued"}
{"level":30,"time":1795375449900,"pid":656034,"hostname":"omarchy","conversationId":"d768375d-4e6c-4c99-af2a-89ec658037c6","runId":"71e396e5-c926-4a7a-ace5-1e67529fdc79","promptTokens":433,"completionTokens":2,"costUsd":0.0000919,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1289,"msg":"harness run settled"}
{"level":30,"time":1795375449914,"pid":656034,"hostname":"omarchy","conversationId":"d768375d-4e6c-4c99-af2a-89ec658037c6","messageId":"57536aa9-9010-4e22-a07d-85add7a1979e","msg":"user message recorded; turn queued"}
{"level":30,"time":1795375452403,"pid":656034,"hostname":"omarchy","conversationId":"d768375d-4e6c-4c99-af2a-89ec658037c6","runId":"9e135e16-8b18-4f0b-a89a-72077b3ff0a7","promptTokens":3519,"completionTokens":4,"costUsd":0.00049378,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1373,"msg":"harness run settled"}
{"level":30,"time":1795375452409,"pid":656034,"hostname":"omarchy","conversationId":"d768375d-4e6c-4c99-af2a-89ec658037c6","clientMessageId":"145a5cda-d45e-4b80-9315-1236221f1018","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS session-rehydration
{"level":30,"time":1795375452418,"pid":656034,"hostname":"omarchy","userId":"harness-eval-7dbf1e90-d587-4871-ac29-c9d97bf3df9b","socketId":"SooOrR0PHmN-g0VWAAAV","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795375452437,"pid":656034,"hostname":"omarchy","userId":"harness-eval-2ed7bd16-fd6c-40a7-96ff-04c27bf0d78e","socketId":"AIdqoL56C7-M6CGyAAAX","open":1,"msg":"socket connected"}
{"level":30,"time":1795375452469,"pid":656034,"hostname":"omarchy","conversationId":"5086d35a-1b78-4e32-9b6a-cf489cdb9d8c","messageId":"c153b89a-8609-429e-85bc-fb5b83af7040","msg":"user message recorded; turn queued"}
{"level":30,"time":1795375454884,"pid":656034,"hostname":"omarchy","conversationId":"5086d35a-1b78-4e32-9b6a-cf489cdb9d8c","runId":"88928f57-2f70-4d0c-bbef-b18b39f29395","promptTokens":447,"completionTokens":5,"costUsd":0.0000947,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1333,"msg":"harness run settled"}
{"level":30,"time":1795375454889,"pid":656034,"hostname":"omarchy","conversationId":"5086d35a-1b78-4e32-9b6a-cf489cdb9d8c","clientMessageId":"de727100-f782-426a-bda6-055370f79e13","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS legacy-history
{"level":30,"time":1795375454900,"pid":656034,"hostname":"omarchy","userId":"harness-eval-2ed7bd16-fd6c-40a7-96ff-04c27bf0d78e","socketId":"AIdqoL56C7-M6CGyAAAX","open":0,"msg":"socket disconnected"}
Harness: 10/12 passed (real model, HTTP → BullMQ → Postgres → socket; synthetic accounts).
error: script "eval-harness" exited with code 1
```

## Files

- `README.md`
- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
