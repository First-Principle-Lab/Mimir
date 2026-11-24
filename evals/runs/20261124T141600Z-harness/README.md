# Eval: phase-6-hardening-completion

| | |
|---|---|
| Suite | `harness` |
| Status | **failed** (exit 1) |
| Tested commit | `3eefed6828c8555736e9a6192721970c226800f9` (from `feat/phase-6-hardening`) |
| Started / finished (UTC) | 2026-11-24T14:16:01Z / 2026-11-24T14:16:02Z |
| Runner | local |

## Summary

```
$ bun scripts/eval-harness.ts && bun scripts/eval-inbox.ts && bun scripts/eval-safe-writes.ts && bun scripts/eval-agents.ts && bun apps/worker/src/redteam.ts
4 | 
5 | function parseConfig(): Config {
6 |   const result = configSchema.safeParse(process.env);
7 |   if (!result.success) {
8 |     const issues = result.error.issues.map((i) => i.path.join("."));
9 |     throw new Error(`Invalid environment config. Missing or malformed: ${issues.join(", ")}`);
                  ^
error: Invalid environment config. Missing or malformed: OTEL_EXPORTER_OTLP_HEADERS
      at parseConfig (/home/too_geeky/projects/fpl/Mimir/packages/backend-core/src/config/config.ts:9:15)
      at getConfig (/home/too_geeky/projects/fpl/Mimir/packages/backend-core/src/config/config.ts:15:25)
      at /home/too_geeky/projects/fpl/Mimir/packages/backend-core/src/observability.ts:19:13
      at requestImportModule (2:1)
Bun v1.3.11 (Linux x64 baseline)
error: script "eval-harness" exited with code 1
```

## Files

- `README.md`
- `meta.json`
- `model-config.json`
- `output.log`
