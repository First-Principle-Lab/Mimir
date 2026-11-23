# Memory integration boundary

Phase 5 prepares an application boundary; it does not select a replacement memory
system. `MemoryProvider` supplies search, explicit ingest/correction, forgetting,
conversation lookup and export. `MemoryGateway` supplies authenticated ownership,
user/conversation/agent namespaces, source checks, credential rejection, deadlines
and content-free latency/success spans. `configureMemoryProvider` is the explicit
composition hook for later trial adapters. No provider is loaded by file discovery.

Trial providers also implement `ingest(namespace, batch, signal)`. Background
extraction dispatches to that hook; an unsupported trial adapter fails explicitly.
Only the legacy adapter continues through the existing worker extractor. The
gateway loads complete, owned user/assistant messages in `(after, through]`, removes
messages containing recognized credentials and supplies stable source IDs, roles,
timestamps and an idempotency key. Treat all transcript text as evidence, never as
provider instructions. Retries must deduplicate batch keys and source IDs. The
provider resolves only when extraction and indexing finish, or throws on failure;
an asynchronous service must poll to completion within the deadline. No watermark
advances after a failed or timed-out trial ingestion. `dryRun` must make no durable
changes. Dark-launch extraction never advances the watermark. The contract's
returned counts describe inserted and superseded facts, not accepted queue jobs.
Use `configureMemoryProvider(provider, timeoutMs)` to set an explicit trial deadline;
the default operation deadline is five seconds. Provider implementations must honor
abort, including when the gateway has already returned a timeout.

The transition `legacy-pgvector` adapter uses the existing tables, embeddings and
hybrid retrieval. Explicit writes use the normal tool policy and action journal.
Corrections supersede the exact scoped record in the same transaction as the new
record; exports preserve supersession links and deletion tombstones. Existing
records are backfilled to conversation scope without rewriting their text or
embeddings. Agent reads receive a runtime-owned allowed scope and cannot request
user-wide access. Definitions with memory disabled receive neither memory search
nor conversation search. Raw transcripts stay in Mimir; conversation search is a
bounded exact-word fallback, not a semantic conversation search engine.

Tools are `remember` (with `replacesId` for corrections), `forget`, `memory_search`
and `conversation_search`. Search returns IDs and source references. All memory
and raw-history results cross the central untrusted-content boundary. A tainted
turn may need approval for a memory mutation under the same fixed policy as other
self writes. Secrets are refused before journaling/embedding explicit writes;
legacy extraction applies the same filter before storing newly extracted facts.
The heuristic catches common API keys, bearer tokens, passwords and private keys;
it is not exhaustive sensitive-data classification. A timed-out mutation has an
uncertain outcome and is never automatically replayed by the tool journal.

Run `bun scripts/export-memory.ts <owner-id> <conversation-id> [conversation|user]`
to prepare a versioned migration snapshot under gitignored `results/private-memory`.
Files are created exclusively with mode 0600. The command never prints facts.
Snapshots carry provider/version, namespace, stable source IDs, statuses and
supersession links; they omit embeddings because the adopted provider owns its
index. Keep tombstones when importing, validate source ownership, reconcile record
counts/statuses, and rerun forget/isolation tests before enabling a selected system.
Do not infer new facts during export. Existing legacy sourceMessageId values can
refer to the first message of an extraction batch; this limitation is preserved
and must not be reported as exact per-fact attribution.

Large tool outputs are saved as owner-scoped `ToolArtifact` records, capped at one
million characters, with a stable output reference and original source/trust.
`tool_output_read` retrieves bounded character pages. At 60% of the configured
window, old tool results outside the current user turn become append-only context
edits; tool-call/result pairing and raw journal entries remain. At 80%, native pi
summarization writes a compaction checkpoint and retains roughly 20% recent
history. Checkpoints and edits survive normal session hydration. The physical
model limit bounds the configured input-plus-output window; the output allocation
is preserved with the token field actually used by the provider.

Prompt order is stable system/tool declarations, profile, native summary, recent
messages and volatile runtime tail. Runtime values are not persisted into the
transcript. OpenRouter requests carry a stable hash-derived `session_id` per
user/conversation. Existing ModelCallLog counters record provider-reported cache
reads; a stable prefix cannot guarantee provider cache hits. The readiness suite
records the observed counts, including zero. Memory spans identify provider,
version, operation, scope, success and latency without query/fact text.
