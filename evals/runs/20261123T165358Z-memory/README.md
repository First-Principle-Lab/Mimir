# Eval: phase-5-context-memory-readiness

| | |
|---|---|
| Suite | `memory` |
| Status | **failed** (exit 1) |
| Tested commit | `c21d770845fcdd848e0567e1d9c4da1c27b85ef2` (from `feat/phase-5-context-memory`) |
| Started / finished (UTC) | 2026-11-23T16:53:59Z / 2026-11-23T16:54:08Z |
| Runner | local |

## Summary

```
$ bun scripts/eval-memory.ts
{"level":30,"time":1795452844131,"pid":3804608,"hostname":"omarchy","conversationId":"bdbaf725-91f6-4e9b-a113-cd5b2c384e43","trigger":"message","watermarkBefore":null,"windowEnd":"2026-11-23T16:53:46.431Z","inserted":2,"superseded":0,"darkLaunch":false,"durationMs":3680,"msg":"fact extraction (message)"}
{"level":30,"time":1795452844880,"pid":3804608,"hostname":"omarchy","conversationId":"bdbaf725-91f6-4e9b-a113-cd5b2c384e43","trigger":"message","watermarkBefore":"2026-11-23T16:53:46.431Z","windowEnd":"2026-11-23T16:53:49.431Z","inserted":0,"superseded":0,"darkLaunch":false,"durationMs":741,"msg":"fact extraction (message)"}
{"level":30,"time":1795452846871,"pid":3804608,"hostname":"omarchy","conversationId":"bdbaf725-91f6-4e9b-a113-cd5b2c384e43","runId":"2c8a8f2d-8b76-49ea-971a-dc5f3ad71d8d","promptTokens":6035,"completionTokens":38,"costUsd":0.00042777,"steps":1,"toolCalls":0,"model":"~deepseek/deepseek-v4-flash-latest","durationMs":1241,"msg":"harness run settled"}
{"kind":"summary","status":"failed","error":"Invalid extraction labels covered: expected 3 booleans"}
error: script "eval-memory" exited with code 1
```

## Files

- `README.md`
- `memory.jsonl`
- `meta.json`
- `model-config.json`
- `output.log`
