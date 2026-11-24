# Eval: phase-6-hardening-completion

| | |
|---|---|
| Suite | `hardening` |
| Status | **passed** (exit 0) |
| Tested commit | `3eefed6828c8555736e9a6192721970c226800f9` (from `feat/phase-6-hardening`) |
| Started / finished (UTC) | 2026-11-24T14:12:59Z / 2026-11-24T14:14:02Z |
| Runner | local |

## Summary

```
{
  fauxCalls: 633,
  toolCalls: 1800,
}
{"level":40,"time":1795529633301,"pid":2152945,"hostname":"omarchy","jobId":"turn-70edafc5-80b2-42c6-9ddf-a34ef31d65be","queue":"conversation-turns","userId":"live-budget-e73b447d-03d0-4b14-94bc-9dcd1534903b","spentUsd":0.00068754,"limitUsd":0.00001,"state":"hard","msg":"user crossed a daily budget limit"}
{"level":30,"time":1795529633346,"pid":2152945,"hostname":"omarchy","jobId":"turn-70edafc5-80b2-42c6-9ddf-a34ef31d65be","queue":"conversation-turns","conversationId":"95db5d7b-6f89-4c1d-b331-96a92d86115b","runId":"f9ac48c5-f599-4614-892e-4da9aef4ee14","promptTokens":4895,"completionTokens":8,"costUsd":0.00068754,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1817,"msg":"harness run settled"}
{"level":30,"time":1795529633425,"pid":2152945,"hostname":"omarchy","jobId":"turn-666befdd-d4bc-494b-886a-cd05e0709b96","queue":"conversation-turns","conversationId":"746cac0c-42eb-4d88-aea5-fd37739b7a3c","runId":"48a20765-e2f1-4bc2-b6b6-d0025b35fd8d","promptTokens":4903,"completionTokens":3,"costUsd":0.00034363,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1898,"msg":"harness run settled"}
{"level":30,"time":1795529633520,"pid":2152945,"hostname":"omarchy","jobId":"turn-541c8cad-b702-433a-a575-5b94c45816b4","queue":"conversation-turns","conversationId":"9e52a76a-fbc3-4db3-82c5-3cd058e35d50","runId":"93923212-35d2-443f-8ed5-21c9d53597f0","promptTokens":4907,"completionTokens":2,"costUsd":0.00068754,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":2004,"msg":"harness run settled"}
{"level":30,"time":1795529633558,"pid":2152945,"hostname":"omarchy","outboxId":"0904b32f-30f6-4018-b386-9b98ccf622ab","eventType":"delivery_ready","msg":"outbox row relayed"}
{"level":30,"time":1795529633563,"pid":2152945,"hostname":"omarchy","outboxId":"658f9f28-b97b-4055-95b4-ede4c7466a2c","eventType":"delivery_ready","msg":"outbox row relayed"}
{"level":30,"time":1795529633570,"pid":2152945,"hostname":"omarchy","outboxId":"e63ca2d7-4d12-4095-8e08-ee4e9b2cec7c","eventType":"delivery_ready","msg":"outbox row relayed"}
{"level":30,"time":1795529634332,"pid":2152945,"hostname":"omarchy","outboxId":"88de8a0c-3774-4619-8f73-cd91e8d6d072","eventType":"agent_run","msg":"outbox row relayed"}
PASS live: arithmetic answer "391"
PASS live: factual answer "Tokyo."
{"level":30,"time":1795529635397,"pid":2152945,"hostname":"omarchy","jobId":"turn-0144eeec-df76-46ea-8b1d-acf7861e7952","queue":"conversation-turns","conversationId":"e625e5ab-4966-4a63-bbf2-e252e79d227a","runId":"3858266d-a826-40e5-b3b8-6345bcc77f82","promptTokens":10244,"completionTokens":296,"costUsd":0.0007585199999999999,"steps":2,"toolCalls":1,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":3875,"msg":"harness run settled"}
{"level":30,"time":1795529635599,"pid":2152945,"hostname":"omarchy","outboxId":"44a39df9-5efd-40b0-a5b6-93c5abb99178","eventType":"delivery_ready","msg":"outbox row relayed"}
{"level":30,"time":1795529639401,"pid":2152945,"hostname":"omarchy","outboxId":"f1f74485-f746-4955-b95b-5645909057d2","eventType":"conversation_turn","msg":"outbox row relayed"}
{"level":30,"time":1795529641192,"pid":2152945,"hostname":"omarchy","outboxId":"a7c4de4e-938a-45f2-a6c5-4342a4b68285","eventType":"delivery_ready","msg":"outbox row relayed"}
{"level":30,"time":1795529641893,"pid":2152945,"hostname":"omarchy","jobId":"turn-8b691b0a-4abc-48c5-a296-0966b775428f","queue":"conversation-turns","conversationId":"e625e5ab-4966-4a63-bbf2-e252e79d227a","runId":"05ace384-755b-4f64-93c1-26a27b82fe1d","promptTokens":10679,"completionTokens":143,"costUsd":0.00076755,"steps":2,"toolCalls":1,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":2451,"msg":"harness run settled"}
PASS live: background agent ran and reported "succeeded"
PASS live: agent findings surfaced to the user ["I've kicked off a background search of your inbox for anything about the Cedar launch. It's running now — I'll report back here as soon as it comes back with wh","Done — your inbox has one message about the Cedar launch (\"Cedar launch update\"). Key points: the launch date moved to 1 December 2026, and the launch budget of"]
PASS live: real model spend recorded for every user [0.00068754,0.00068754,0.0020704319999999997,0.00034363]
PASS live: hard budget refuses after real spend
PASS live: each reply delivered once across instances
29/29 checks passed in 63s (API logs: /tmp/mimir-hardening-BiP1G9)
```

## Files

- `README.md`
- `hardening.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
