# Eval: phase-4-followups

| | |
|---|---|
| Suite | `harness` |
| Status | **failed** (exit 1) |
| Tested commit | `a4cfc0c7769985b995574ea42d06b1a6ffd88358` (from `feat/phase-4-followups`) |
| Started / finished (UTC) | 2026-11-23T14:25:42Z / 2026-11-23T14:26:44Z |
| Runner | local |

## Summary

```
{"level":30,"time":1795443985940,"pid":3345916,"hostname":"omarchy","conversationId":"3c48a1fa-26f5-400f-ba20-25bc226608f7","clientMessageId":"90c0ca42-6f95-4b4e-8a81-acaeaf0b8bd9","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS invalid-timezone
{"level":30,"time":1795443985950,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-8ac749ab-23ab-40b9-8e78-94d19ee045db","socketId":"JpZTiRgiWgWoLjOkAAAR","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795443985965,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-ac14533e-4247-4d26-ab39-5c13174b8749","socketId":"w4p7IsywRB3xPJ3TAAAT","open":1,"msg":"socket connected"}
{"level":30,"time":1795443985996,"pid":3345916,"hostname":"omarchy","conversationId":"d6cd8916-35fa-4729-a5d8-fcc0ba543438","messageId":"b87d0e65-bdb9-45eb-844a-13ac9af8f261","msg":"user message recorded; turn queued"}
{"level":30,"time":1795443996060,"pid":3345916,"hostname":"omarchy","conversationId":"d6cd8916-35fa-4729-a5d8-fcc0ba543438","runId":"321ab6eb-6175-44dc-9ff7-d986bb102a07","promptTokens":7874,"completionTokens":283,"costUsd":0.0007700000000000001,"steps":4,"toolCalls":3,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":8979,"msg":"harness run settled"}
{"level":30,"time":1795443996067,"pid":3345916,"hostname":"omarchy","conversationId":"d6cd8916-35fa-4729-a5d8-fcc0ba543438","clientMessageId":"445ee4df-e502-4386-8768-17fdac40fb9b","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS calendar-write-refusal
{"level":30,"time":1795443996080,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-ac14533e-4247-4d26-ab39-5c13174b8749","socketId":"w4p7IsywRB3xPJ3TAAAT","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795443996095,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-975c57d3-6052-4842-a16c-b1864bb9d3c6","socketId":"b3G63N4PAqfppEaZAAAV","open":1,"msg":"socket connected"}
{"level":30,"time":1795443996127,"pid":3345916,"hostname":"omarchy","conversationId":"f28acdea-8b73-4f57-abd5-b15a0e1ad015","messageId":"f42299c9-72f7-44b3-a487-133d2fa8fbca","msg":"user message recorded; turn queued"}
{"level":30,"time":1795443998384,"pid":3345916,"hostname":"omarchy","conversationId":"f28acdea-8b73-4f57-abd5-b15a0e1ad015","runId":"be7a4893-0df4-41ca-8612-081272a8249e","promptTokens":324,"completionTokens":2,"costUsd":0.000092,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1209,"msg":"harness run settled"}
{"level":30,"time":1795443998401,"pid":3345916,"hostname":"omarchy","conversationId":"f28acdea-8b73-4f57-abd5-b15a0e1ad015","messageId":"4191b8da-f7b8-40bc-9080-4185b1710b26","msg":"user message recorded; turn queued"}
{"level":30,"time":1795444001533,"pid":3345916,"hostname":"omarchy","conversationId":"f28acdea-8b73-4f57-abd5-b15a0e1ad015","runId":"caeac1ed-3dc6-47b8-9ad2-a4af3b859497","promptTokens":4946,"completionTokens":4,"costUsd":0.00034678,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":2042,"msg":"harness run settled"}
{"level":30,"time":1795444001539,"pid":3345916,"hostname":"omarchy","conversationId":"f28acdea-8b73-4f57-abd5-b15a0e1ad015","clientMessageId":"5448f8c9-6ec5-4866-bbfb-959a4205b357","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS session-rehydration
{"level":30,"time":1795444001551,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-975c57d3-6052-4842-a16c-b1864bb9d3c6","socketId":"b3G63N4PAqfppEaZAAAV","open":0,"msg":"socket disconnected"}
{"level":30,"time":1795444001572,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-0930365e-1fc6-44d8-a1ca-a9c3695f966c","socketId":"ng0TgF9heLzTjvL8AAAX","open":1,"msg":"socket connected"}
{"level":30,"time":1795444001603,"pid":3345916,"hostname":"omarchy","conversationId":"b01587d6-905d-43aa-b7f8-2814d1dbc66e","messageId":"d58b4360-50b2-4e12-974b-c415de0fdbfc","msg":"user message recorded; turn queued"}
{"level":30,"time":1795444003952,"pid":3345916,"hostname":"omarchy","conversationId":"b01587d6-905d-43aa-b7f8-2814d1dbc66e","runId":"fc11f7a4-b2a4-48cc-aef3-3fb3f4e694fa","promptTokens":4929,"completionTokens":5,"costUsd":0.00034573,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1234,"msg":"harness run settled"}
{"level":30,"time":1795444003958,"pid":3345916,"hostname":"omarchy","conversationId":"b01587d6-905d-43aa-b7f8-2814d1dbc66e","clientMessageId":"df87f87d-b2b5-4561-b6bd-0d51cb18a6d5","answered":true,"msg":"user message replayed (idempotent hit)"}
PASS legacy-history
{"level":30,"time":1795444003972,"pid":3345916,"hostname":"omarchy","userId":"harness-eval-0930365e-1fc6-44d8-a1ca-a9c3695f966c","socketId":"ng0TgF9heLzTjvL8AAAX","open":0,"msg":"socket disconnected"}
Harness: 11/12 passed (real model, HTTP → BullMQ → Postgres → socket; synthetic accounts).
error: script "eval-harness" exited with code 1
```

## Files

- `harness.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
- `README.md`
