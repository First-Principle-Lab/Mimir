# Eval: phase 3 safe writes completion review

| | |
|---|---|
| Suite | `harness` |
| Status | **failed** (exit 1) |
| Tested commit | `9356fca2ac29865b3ae607c48505a52c9b086d89` (from `feat/phase-3-safe-writes`) |
| Started / finished (UTC) | 2026-11-22T19:34:53Z / 2026-11-22T19:35:50Z |
| Runner | local |

## Summary

```
{"level":30,"time":1795376135795,"pid":679060,"hostname":"omarchy","conversationId":"d2ec1ac2-090f-483b-8885-42be92c9a4f8","clientMessageId":"bbe264f6-3d6a-4501-8d6d-d65c6105b6ae","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS invalid-timezone
{"level":30,"time":1795376135809,"pid":679060,"hostname":"omarchy","userId":"harness-eval-abf2c43c-3cf8-48ff-b3a7-e7fee70dcaa5","socketId":"38i3ln3EoHFRgAjBAAAR","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795376135833,"pid":679060,"hostname":"omarchy","userId":"harness-eval-fb5fe37b-2499-4d65-80e2-e3880b18ac2f","socketId":"845ntL-bA7eCiUmrAAAT","open":1,"msg":"socket connected"}
{"level":30,"time":1795376135870,"pid":679060,"hostname":"omarchy","conversationId":"b204e504-18fc-4644-adca-c0ac86bec24f","messageId":"c5cfaa16-cfec-4980-99f2-d66804de6462","msg":"user message recorded; turn queued"}
{"level":30,"time":1795376141640,"pid":679060,"hostname":"omarchy","conversationId":"b204e504-18fc-4644-adca-c0ac86bec24f","runId":"33da184a-e227-4359-b1ff-43d17baedb4f","promptTokens":9027,"completionTokens":203,"costUsd":0.0006889819999999999,"steps":3,"toolCalls":2,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":4645,"msg":"harness run settled"}
{"level":30,"time":1795376141646,"pid":679060,"hostname":"omarchy","conversationId":"b204e504-18fc-4644-adca-c0ac86bec24f","clientMessageId":"8d1a7478-4f35-4c9e-82c8-306847df4d57","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS calendar-write-refusal
{"level":30,"time":1795376141658,"pid":679060,"hostname":"omarchy","userId":"harness-eval-fb5fe37b-2499-4d65-80e2-e3880b18ac2f","socketId":"845ntL-bA7eCiUmrAAAT","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795376141687,"pid":679060,"hostname":"omarchy","userId":"harness-eval-5279f8be-ab95-4205-8926-faf60b4f3d76","socketId":"Lh5dKKKtteQPYQvYAAAV","open":1,"msg":"socket connected"}
{"level":30,"time":1795376141723,"pid":679060,"hostname":"omarchy","conversationId":"05237921-498d-4299-8d69-d01181cf2e83","messageId":"b6ec0184-6dcc-4bb6-ab50-5aa597194158","msg":"user message recorded; turn queued"}
{"level":30,"time":1795376144425,"pid":679060,"hostname":"omarchy","conversationId":"05237921-498d-4299-8d69-d01181cf2e83","runId":"8f5bbd31-3733-415d-b009-56ed77668488","promptTokens":451,"completionTokens":2,"costUsd":0.00009442,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1582,"msg":"harness run settled"}
{"level":30,"time":1795376144445,"pid":679060,"hostname":"omarchy","conversationId":"05237921-498d-4299-8d69-d01181cf2e83","messageId":"6a2adc05-b3bc-4c89-8592-3e9881e553e9","msg":"user message recorded; turn queued"}
{"level":30,"time":1795376146827,"pid":679060,"hostname":"omarchy","conversationId":"05237921-498d-4299-8d69-d01181cf2e83","runId":"2c29062d-5baf-425b-9b8b-8d88188df5df","promptTokens":3537,"completionTokens":4,"costUsd":0.00024815,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1284,"msg":"harness run settled"}
{"level":30,"time":1795376146836,"pid":679060,"hostname":"omarchy","conversationId":"05237921-498d-4299-8d69-d01181cf2e83","clientMessageId":"66fd7272-58c7-4f27-9e5d-f506bbddd58e","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS session-rehydration
{"level":30,"time":1795376146846,"pid":679060,"hostname":"omarchy","userId":"harness-eval-5279f8be-ab95-4205-8926-faf60b4f3d76","socketId":"Lh5dKKKtteQPYQvYAAAV","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795376146865,"pid":679060,"hostname":"omarchy","userId":"harness-eval-8c9b2b3c-7b71-49af-ab25-011d550433b8","socketId":"68-1oPBkC3MwSCcGAAAX","open":1,"msg":"socket connected"}
{"level":30,"time":1795376146898,"pid":679060,"hostname":"omarchy","conversationId":"e0a8e7e4-3964-48e4-8e60-1a4447732eb9","messageId":"5b17a553-34eb-4e9f-961f-25fcd7b72035","msg":"user message recorded; turn queued"}
{"level":30,"time":1795376150447,"pid":679060,"hostname":"omarchy","conversationId":"e0a8e7e4-3964-48e4-8e60-1a4447732eb9","runId":"be3653e8-6b44-4a57-998e-8effa23625c9","promptTokens":1464,"completionTokens":5,"costUsd":0.000131852,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":2475,"msg":"harness run settled"}
{"level":30,"time":1795376150452,"pid":679060,"hostname":"omarchy","conversationId":"e0a8e7e4-3964-48e4-8e60-1a4447732eb9","clientMessageId":"e156c95e-8159-4871-9e03-28c3b1d2eaf6","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS legacy-history
{"level":30,"time":1795376150462,"pid":679060,"hostname":"omarchy","userId":"harness-eval-8c9b2b3c-7b71-49af-ab25-011d550433b8","socketId":"68-1oPBkC3MwSCcGAAAX","open":0,"msg":"socket disconnected"}
Harness: 10/12 passed (real model, HTTP → BullMQ → Postgres → socket; synthetic accounts).
error: script "eval-harness" exited with code 1
```

## Files

- `README.md`
- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
