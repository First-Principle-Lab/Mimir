# Eval: phase-6-retrieval-regression

| | |
|---|---|
| Suite | `retrieval` |
| Status | **passed** (exit 0) |
| Tested commit | `3eefed6828c8555736e9a6192721970c226800f9` (from `feat/phase-6-hardening`) |
| Started / finished (UTC) | 2026-11-24T14:30:14Z / 2026-11-24T14:31:29Z |
| Runner | local |

## Summary

```
   - [relation] utilities transfer: needs to be done before moving in
  query="how much is my Portland rent now" -> recall 100.0% (1/1) OK
[exact-term-lexical] Exact-term lexical recall vs embedding drift
   - [vector|lexical] west wing key card code: XQ7K-429
   - [vector|lexical] moves team: needs west wing code on the day
   - [vector] spare gate PIN: 9012
  query="what is the XQ7K-429 access code" -> recall 100.0% (1/1) OK
[multi-hop-manager] Multi-hop manager reachability via relation edges
   - [vector|lexical] Dana: is my manager
   - [vector|lexical] time off approval: goes through my manager Dana
   - [vector|lexical] dana: manages design
   - [lexical] design team: is managed by Dana
   - [vector] Priya: leads the design org
   - [relation] user: is taking PTO next week
   - [vector|relation] jordan: works on the design team
   - [relation] acme: is the employer of jordan
   - [relation] Dana: reports to Priya
   - [relation] Dana: Dana's VP is Priya
  query="who is my skip-level manager" -> recall 100.0% (1/1) OK
===== RETRIEVAL GATE =====
recall 100.0% (3/3)
  adversarial-supersede: 1/1
  exact-term-lexical: 1/1
  multi-hop-manager: 1/1
GATE PASS
```

## Files

- `README.md`
- `meta.json`
- `model-config.json`
- `output.log`
- `retrieval.jsonl`
