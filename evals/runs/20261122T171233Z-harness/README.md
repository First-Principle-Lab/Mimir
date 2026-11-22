# Eval: phase 1 completion review end to end

| | |
|---|---|
| Suite | `harness` |
| Status | **passed** (exit 0) |
| Tested commit | `180297cc2ac4e330b3cfc9e141420f134ad3e000` (from `feat/phase1-pi-harness`) |
| Started / finished (UTC) | 2026-11-22T17:12:33Z / 2026-11-22T17:13:13Z |
| Runner | local |

## Summary

```
{"level":30,"time":1795367589480,"pid":389521,"hostname":"omarchy","conversationId":"78ed5064-837b-4dc8-ba5f-b89f8204b3c8","runId":"b48cf18d-b6f3-4831-94a5-f3c7daab9e01","promptTokens":775,"completionTokens":132,"costUsd":0.00018386,"steps":2,"toolCalls":1,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":4384,"msg":"harness run settled"}
{"level":30,"time":1795367589486,"pid":389521,"hostname":"omarchy","conversationId":"78ed5064-837b-4dc8-ba5f-b89f8204b3c8","clientMessageId":"1ad1a7ef-20bb-481b-be0d-fb0b06418172","answered":true,"msg":"user message replayed (idempotent hit)"}
{"level":30,"time":1795367589488,"pid":389521,"hostname":"omarchy","conversationId":"78ed5064-837b-4dc8-ba5f-b89f8204b3c8","messageId":"861af6d5-fa81-4fd8-bb1e-c13f173fb16f","runId":"b48cf18d-b6f3-4831-94a5-f3c7daab9e01","msg":"turn already answered; skipping"}
PASS calendar-write-refusal
{"level":30,"time":1795367589490,"pid":389521,"hostname":"omarchy","userId":"harness-eval-45d61941-8eea-4755-bc9a-42b0521db44e","socketId":"YgLknaefKuj2QYkRAAAT","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795367589505,"pid":389521,"hostname":"omarchy","userId":"harness-eval-17ca885b-2701-4901-bff2-9e1f559512e2","socketId":"tQtukbgJOhi4o9iEAAAV","open":1,"msg":"socket connected"}
{"level":30,"time":1795367589536,"pid":389521,"hostname":"omarchy","conversationId":"90fd765a-a200-4897-ba6e-b84b4f38ec7a","messageId":"3fdfc19a-46f8-451d-aeff-0c81f21fcdb7","msg":"user message recorded; turn queued"}
{"level":30,"time":1795367591085,"pid":389521,"hostname":"omarchy","userId":"harness-eval-17ca885b-2701-4901-bff2-9e1f559512e2","eventName":"new_message","channel":"socket","msg":"user event delivered"}
{"level":30,"time":1795367591098,"pid":389521,"hostname":"omarchy","conversationId":"90fd765a-a200-4897-ba6e-b84b4f38ec7a","runId":"d8eb2c07-7990-4867-8896-d6243f3a9759","promptTokens":2194,"completionTokens":2,"costUsd":0.00015386,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1541,"msg":"harness run settled"}
{"level":30,"time":1795367591111,"pid":389521,"hostname":"omarchy","conversationId":"90fd765a-a200-4897-ba6e-b84b4f38ec7a","messageId":"2fdf4292-07dc-4171-838b-825439e9ff8a","msg":"user message recorded; turn queued"}
{"level":30,"time":1795367592254,"pid":389521,"hostname":"omarchy","userId":"harness-eval-17ca885b-2701-4901-bff2-9e1f559512e2","eventName":"new_message","channel":"socket","msg":"user event delivered"}
{"level":30,"time":1795367592266,"pid":389521,"hostname":"omarchy","conversationId":"90fd765a-a200-4897-ba6e-b84b4f38ec7a","runId":"abe62a03-095f-4258-b752-97227fb9c36d","promptTokens":2208,"completionTokens":4,"costUsd":0.00015512,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1133,"msg":"harness run settled"}
{"level":30,"time":1795367592272,"pid":389521,"hostname":"omarchy","conversationId":"90fd765a-a200-4897-ba6e-b84b4f38ec7a","clientMessageId":"882c20a1-c83f-42f0-8616-f3c01691abec","answered":true,"msg":"user message replayed (idempotent hit)"}
{"level":30,"time":1795367592274,"pid":389521,"hostname":"omarchy","conversationId":"90fd765a-a200-4897-ba6e-b84b4f38ec7a","messageId":"2fdf4292-07dc-4171-838b-825439e9ff8a","runId":"abe62a03-095f-4258-b752-97227fb9c36d","msg":"turn already answered; skipping"}
PASS session-rehydration
{"level":30,"time":1795367592276,"pid":389521,"hostname":"omarchy","userId":"harness-eval-17ca885b-2701-4901-bff2-9e1f559512e2","socketId":"tQtukbgJOhi4o9iEAAAV","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795367592296,"pid":389521,"hostname":"omarchy","userId":"harness-eval-ccd44823-741a-4322-9b5a-c94f39a5592a","socketId":"qd321cZZAvewE7h4AAAX","open":1,"msg":"socket connected"}
{"level":30,"time":1795367592328,"pid":389521,"hostname":"omarchy","conversationId":"149a70a2-e1ea-4c49-96cb-28719a6ed244","messageId":"23caedca-849f-4e91-aa88-842118af4308","msg":"user message recorded; turn queued"}
{"level":30,"time":1795367593719,"pid":389521,"hostname":"omarchy","userId":"harness-eval-ccd44823-741a-4322-9b5a-c94f39a5592a","eventName":"new_message","channel":"socket","msg":"user event delivered"}
{"level":30,"time":1795367593731,"pid":389521,"hostname":"omarchy","conversationId":"149a70a2-e1ea-4c49-96cb-28719a6ed244","runId":"cd216269-4d9d-4176-a133-f1a96f885f69","promptTokens":152,"completionTokens":5,"costUsd":0.00004316,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1381,"msg":"harness run settled"}
{"level":30,"time":1795367593737,"pid":389521,"hostname":"omarchy","conversationId":"149a70a2-e1ea-4c49-96cb-28719a6ed244","clientMessageId":"c85016b6-4cf8-46ff-b09d-9141150ca303","answered":true,"msg":"user message replayed (idempotent hit)"}
{"level":30,"time":1795367593740,"pid":389521,"hostname":"omarchy","conversationId":"149a70a2-e1ea-4c49-96cb-28719a6ed244","messageId":"23caedca-849f-4e91-aa88-842118af4308","runId":"cd216269-4d9d-4176-a133-f1a96f885f69","msg":"turn already answered; skipping"}
PASS legacy-history
{"level":30,"time":1795367593742,"pid":389521,"hostname":"omarchy","userId":"harness-eval-ccd44823-741a-4322-9b5a-c94f39a5592a","socketId":"qd321cZZAvewE7h4AAAX","open":0,"msg":"socket disconnected"}
Harness: 12/12 passed (real model, HTTP → BullMQ → Postgres → socket; synthetic accounts).
```

## Files

- `README.md`
- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
