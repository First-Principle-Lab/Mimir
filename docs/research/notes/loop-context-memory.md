# Core agent loop, context assembly, and memory for long-lived personal-assistant agents (as of Nov 2026)

Scope: building Mimir's harness (TypeScript/Node, Postgres+pgvector, Redis/BullMQ, OpenRouter). Mimir already does extraction-based memory (ExtractedFact + embeddings, supersede-on-conflict, fact graph, hybrid retrieval). These notes cover the loop around that memory, how context is assembled, and how memory designs compare.

Source-quality note: Anthropic and Manus posts are primary, first-party engineering write-ups. Memory benchmark numbers are mostly vendor self-reports and they conflict; see Q3. Items marked "(training knowledge, not re-fetched this session)" come from widely cited paper abstracts that I did not re-open here. The report writer should treat them as lower-confidence.

---

## Q1. Core loop design: while-loop, streaming, parallel tools, guards, error recovery, idempotency, durable resume

### Takeaway
The canonical loop is: call the model, append its full output, execute any tool calls, append the results, and repeat until there are no tool calls, a step cap is hit, or a terminal or approval tool fires. Every serious framework ships it with a default step cap (Vercel's is 20). The hard part for a long-lived assistant is durability. Plain at-least-once queues (BullMQ) re-run the whole loop and duplicate side effects after a crash. Checkpoint each step to Postgres, and derive tool idempotency keys from (run_id, step_index), never from the model's arguments.

### Cited Findings
- **Vercel AI SDK `ToolLoopAgent` loop semantics.** The loop ends when: (a) the finish reason is not tool-calls; (b) the model calls a tool with no `execute` function; (c) a tool call needs approval; or (d) a `stopWhen` condition is met. The default cap is `isStepCount(20)`, and the SDK warns when that default cuts a loop short. `WorkflowAgent.stream()` has no default limit. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- **Vercel stop conditions.** These are `isStepCount(n)`, `hasToolCall(...names)`, and `isLoopFinished()` (never triggers, can run forever). An array means "stop when any one is met". Custom conditions receive `steps` and return a boolean, for example to stop once estimated cost passes a threshold. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- **Vercel `prepareStep`** runs before every step. It receives `stepNumber`, `steps`, `messages`, `initialMessages` and `responseMessages`. It can swap `model`, sampling settings, `activeTools` and `toolChoice` per step. It can also return a replacement `messages` array that becomes the base for later steps, which is the hook for compaction. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- **"Done tool" pattern.** Set `toolChoice: 'required'` and add a `done` tool with no `execute`. The loop ends when the agent calls `done`, and the final answer is read from that call's arguments. Manual-loop alternative: push `result.responseMessages` after each `generateText` call and break when text is returned. The docs' example caps this at 10 steps. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- **OpenRouter loop rules:**
  - Send the `tools` array on every request, including the follow-up that carries tool results.
  - Append every output item from the model in order before adding tool results, including reasoning items. Omitting them is called out as a common mistake.
  - Tool arguments arrive as a JSON string and must be parsed.
  - Return tool errors as error results, not empty results.
  - Use a maximum iteration count.
  - `parallel_tool_calls` defaults to true for most models; set it to `false` to get one call at a time.

  — [OpenRouter Tool Calling](https://openrouter.ai/docs/features/tool-calling)
- **OpenRouter streaming tool calls (Responses API).** Stream `response.output_text.delta` events to the UI. Collect each `function_call` item at `response.output_item.done`, which carries the full argument string. Run the collected calls on `response.completed`. Treat `response.failed` and `response.incomplete` as errors. — [OpenRouter Tool Calling](https://openrouter.ai/docs/features/tool-calling)
- **Keep errors in context.** Manus argues you should "leave the wrong turns in the context" so the model updates its beliefs and does not repeat the mistake. It calls error recovery one of the clearest signs of real agentic behavior. — [Manus, Context Engineering lessons (Yichao 'Peak' Ji, 2025-07-18)](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Why plain queues break for agents:**
  - A worker that dies mid-run "restarts from step one, spending the same dollars again".
  - You cannot set a visibility timeout reliably because the model is non-deterministic and tools may loop.
  - Redelivery repeats side effects: "a retry of a non-deterministic workflow is not a retry; it is a fresh run."
  - Ad-hoc status flags grow into "a home-grown workflow engine with worse semantics."

  — [Tian Pan, Durable Agents (2026-04-23)](https://tianpan.co/blog/2026-04-23-durable-agents-async-queue-workflow-checkpoint)
- **Idempotency keys.** Do not derive keys from the model's arguments, because a retry may produce different arguments, such as an email with different subject casing. Derive them from "the workflow ID plus the step number". Every external interaction (LLM calls, tool calls, DB writes) should be wrapped in a primitive the engine can dedupe on replay. — [Tian Pan, Durable Agents](https://tianpan.co/blog/2026-04-23-durable-agents-async-queue-workflow-checkpoint)
- **Sagas.** Classify each action as compensable, partially compensable or irreversible. Tag irreversible steps so they are never retried. Compensation (for example, a refund for a charge) is an application decision, not something the engine can make. — [Tian Pan, Durable Agents](https://tianpan.co/blog/2026-04-23-durable-agents-async-queue-workflow-checkpoint)
- **Cached-response replay caveat.** If the prompt template changes between crash and resume, "the cached response may no longer be coherent with the new prompt". Version your workflows. — [Tian Pan, Durable Agents](https://tianpan.co/blog/2026-04-23-durable-agents-async-queue-workflow-checkpoint)
- **The two durable-execution families:**
  - Journal replay (Temporal, Restate): log each completed step, return the recorded result on recovery.
  - Database checkpointing (LangGraph, DBOS): save the state object after each node.

  — [Tian Pan, Durable Agents](https://tianpan.co/blog/2026-04-23-durable-agents-async-queue-workflow-checkpoint)
- **Engine-specific notes (secondary and vendor-adjacent sources):**
  - DBOS runs as a library and writes checkpoints to your existing Postgres. Its Vercel AI SDK integration reportedly shipped in July 2026.
  - Inngest stores step results on its platform. Each call needs its own durable step, which is awkward when tool calls are chosen at runtime, and per-step cost adds up in heavy loops.
  - Temporal's OpenAI Agents SDK integration reportedly reached GA on 2026-03-23.

  Sources: [HackerNoon comparison](https://hackernoon.com/durable-execution-for-ai-agents-langgraph-dbos-inngest-and-temporal-compared), [DEV: DBOS on Postgres](https://dev.to/mr_manushukla/durable-ai-agents-without-temporal-exactly-once-workflows-on-postgres-with-dbos-2026-5a6n), [ZenML: Inngest alternatives](https://www.zenml.io/blog/inngest-alternatives), [DEV: Temporal for AI agents 2026](https://dev.to/jangwook_kim_e31e7291ad98/temporal-for-ai-agents-durable-execution-guide-2026-1f2o). I did not verify these against the official docs.
- **"You don't need Temporal yet."** A post argues durable execution for agents can be done in about 150 lines. — [HackerNoon](https://hackernoon.com/you-dont-need-temporal-yet-durable-execution-for-ai-agents-in-150-lines) (title only; not fetched)
- **Long-running harness persistence (Anthropic).** State moves between context windows through external artifacts, not through the conversation:
  - a JSON feature list where agents may only flip the `passes` field (JSON chosen because models are "less likely to inappropriately overwrite" it than Markdown);
  - a `claude-progress.txt` log;
  - git commits;
  - an `init.sh`.

  Every session starts the same way: read progress and git log, pick the top unfinished item, run a smoke test. Every session ends with a commit and a progress update. — [Anthropic, Effective harnesses for long-running agents (2025-11-26)](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Two-agent pattern.** The "initializer" and the "coding agent" differ only in their initial user prompt. System prompt, tools and harness are identical. — [Anthropic, Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Inferences
- **A Mimir loop shape that fits a single developer, using BullMQ plus a Postgres journal (DBOS-style, without the dependency):**
  - Tables:
    - `agent_run(id, thread_id, status[running|waiting_tool|waiting_human|done|failed], step_index, model, prompt_version, started_at, heartbeat_at)`
    - `agent_step(run_id, step_index, kind[llm|tool], request_hash, response_json, usage_json, status, idempotency_key, created_at)`, unique on `(run_id, step_index, kind, tool_call_id)`
  - The BullMQ job carries only `run_id`. On pickup the worker rebuilds the messages from `agent_step` rows. It skips any LLM or tool step that already has `status=done` and resumes at the first incomplete step.
  - LLM call: persist the full response, including reasoning items, before running any tools.
  - Tool call: compute `idempotency_key = hash(run_id, step_index, tool_call_id_ordinal)` and check `agent_step`. Only call the external API if there is no completed row. Pass the key to the API too when it supports one (Gmail drafts, Stripe and similar).
  - Tag tools as `{sideEffect: none|reversible|irreversible}`. Irreversible tools need a "pending" row plus reconciliation (did the email actually send?) before any retry.
  - Use a heartbeat column plus a BullMQ stalled-job check for crash detection, so the run does not depend on a visibility timeout.
- **Guards:**
  - A step cap (20 for interactive turns, higher for background jobs).
  - A token or cost budget checked in the `prepareStep`-equivalent.
  - Repeated-identical-tool-call detection (same name and args N times, so break or inject a hint).
  - Wall-clock timeout per tool.
  - A provider-error retry with exponential backoff that does not re-append the failed assistant message.
- **Parallel tool calls:** run read-only tools concurrently with `Promise.allSettled`. Serialize side-effecting tools, or disable `parallel_tool_calls` for turns where side-effecting tools are active. Append results in the original call order so serialization stays deterministic (this also keeps the cache stable, see Q2).
- If BullMQ is ever outgrown, DBOS (Postgres-backed, TypeScript, library not service) is the closest match to Mimir's stack. That match is my inference from the sources above.

### Gaps
- I did not read the source of the Claude Agent SDK (TS), OpenAI Agents JS, Mastra, pi-mono or Codex loops. Their exact state-persistence formats (for example Claude Code's JSONL transcripts) are not covered here and need a source dive.
- I found no primary benchmark of BullMQ-checkpoint versus Temporal/DBOS reliability for agent loops.
- OpenRouter docs on how parallel tool-call streaming deltas are interleaved on the Chat Completions API (as opposed to Responses) were not fetched.

---

## Q2. Context engineering: assembly, caching layout, compaction, tool-result clearing, JIT vs pre-load

### Takeaway
Treat context as a scarce "attention budget":

- Keep the prefix byte-stable and append-only so the KV cache hits. Manus calls cache hit rate the single most important production metric, and cached input is about 10x cheaper.
- Mask tools instead of removing them.
- Externalize bulky content to restorable stores, keeping only the ID or URL in context.
- Recite goals or todos near the tail.
- Keep errors in context.
- Compact in tiers: clear tool results first (cheapest), then summarize.

### Cited Findings
- **Context rot.** Recall accuracy drops as context grows. Each token draws on a finite "attention budget" (n² pairwise relationships). — [Anthropic, Effective context engineering (2025-09-29)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **System prompt "right altitude".** Aim between brittle if-else logic and vague guidance. Organize the prompt into XML or Markdown sections. Start minimal on the best model and add instructions only for observed failures. — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Tool sets.** Keep them minimal and non-overlapping. "If a human can't tell which tool to use, an AI agent can't be expected to do better." Tools should return token-efficient output. — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **JIT vs pre-load.**
  - Just-in-time agents hold "lightweight identifiers" (paths, stored queries, links) and load data through tools. They use metadata such as names and timestamps for progressive disclosure.
  - The trade-off is slower runs and the need for good heuristics.
  - The hybrid approach is to pre-load some context and explore the rest. Claude Code loads CLAUDE.md up front and uses glob/grep just in time.

  — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Compaction (Anthropic).**
  - Near the limit, summarize and restart with the summary.
  - Keep decisions, unresolved issues and implementation details. Drop redundant tool outputs.
  - Claude Code keeps the summary plus the 5 most recently accessed files.
  - Tune for recall first, then precision.
  - Tool-result clearing is "one of the safest lightest touch forms of compaction".

  — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Structured note-taking.** Agents keep NOTES.md or todo lists outside the window and reload them later. Claude Plays Pokémon tracked progress across thousands of steps this way. — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Sub-agents.** They explore in a clean context (tens of thousands of tokens) and return condensed summaries, often 1,000–2,000 tokens. Rule of thumb: compaction for conversational flow, notes for milestone work, multi-agent for parallel research. Overall advice: "do the simplest thing that works". — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Manus KV-cache numbers.** The average input:output ratio is about 100:1. On Claude Sonnet, cached input costs $0.30/MTok versus $3/MTok uncached. A single changed token invalidates the cache from that point on. A classic mistake is a timestamp "precise to the second" at the top of the system prompt. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Manus append-only context.** Never edit past actions or observations. Use deterministic serialization, because some JSON libraries do not keep key order stable. At minimum, put a cache breakpoint at the end of the system prompt and account for cache TTL expiry. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Mask, don't remove.** Tool definitions sit near the front of the context, so changing them busts the cache. Removing them also confuses the model when earlier turns reference tools that no longer exist.
  - Manus masks token logits through a state machine.
  - It uses response-prefill modes: Auto, Required (prefill up to the tool-call token) and Specified (prefill up to the start of a function name).
  - Tool name prefixes such as `browser_` and `shell_` let it restrict tool groups per state.

  — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **File system as memory.** Compression should be restorable: "the content of a web page can be dropped from the context as long as the URL is preserved." — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Recitation.** Manus tasks average about 50 tool calls. The agent rewrites a todo.md so the global plan sits in recent attention, which fights lost-in-the-middle drift. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Avoid few-shot ruts.** Repetitive context causes imitation; Manus's example is 20 resumes processed in a repetitive rhythm. Add structured variation: alternate serialization templates, phrasing and order noise. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Anthropic server-side tool-result clearing (`clear_tool_uses_20250919`, beta header `context-management-2025-06-27`).**
  - `trigger` defaults to 100,000 input tokens.
  - `keep` defaults to 3 recent tool use/result pairs.
  - `clear_at_least` sets the minimum tokens cleared, so the cache break is worth it.
  - `exclude_tools` and `clear_tool_inputs` (default false) are also available.
  - Cleared results are replaced with a placeholder.
  - Responses report `context_management.applied_edits` with `cleared_input_tokens`.

  — [Claude Docs, Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **Thinking clearing (`clear_thinking_20251015`).** `keep` defaults to 1 thinking turn when the strategy is specified. It must be listed first among the edits. Keeping thinking preserves the cache. — [Claude Docs, Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **Compaction and memory pairing (Anthropic).** Server-side compaction (`compact_20260112`) is now the primary recommended strategy for long conversations. Client-side SDK `compaction_control` is deprecated; it defaulted to a 100k threshold, allowed a cheaper summary model, and wrapped output in `<summary>` tags. Pair the memory tool (`memory_20250818`) with tool clearing: Claude gets a warning near the threshold and can save information to memory files before results are cleared. — [Claude Docs, Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **Vercel's compaction recipe.** `prepareStep` returns `pruneMessages({ reasoning: 'all', toolCalls: 'before-last-3-messages', emptyMessages: 'remove' })` with a simple chars/4 token estimate. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- **Prompt caching via OpenRouter:**
  - Anthropic needs `cache_control`: up to 4 breakpoints, 5-minute TTL (or `"ttl":"1h"`), writes at 1.25x (5 min) or 2x (1h), reads at 0.1x, minimum 512–4,096 tokens depending on model.
  - OpenAI caches automatically from 1,024 tokens. GPT-5.6+ charges 1.25x for writes and adds explicit `prompt_cache_breakpoint` with a 30-minute or 12-hour TTL.
  - Gemini 2.5+ caches implicitly (about 3–5 minute TTL, reads at 0.25x). With explicit Gemini caching only the last breakpoint is used.
  - DeepSeek reads at 0.1x. Grok and Moonshot read at 0.25x.

  — [OpenRouter Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)
- **OpenRouter sticky routing.** After a cached request, OpenRouter routes follow-ups to the same provider. Conversations are identified by hashing the opening messages, or explicitly by `session_id`, `x-session-id` or `prompt_cache_key`. Sessions expire after 60 minutes idle. Sticky routing is bypassed if you set a manual `provider.order`. Cache hits show in `usage.prompt_tokens_details.cached_tokens`, `cache_write_tokens` and `cache_discount`. — [OpenRouter Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)

### Inferences
- **Context layout for Mimir, most stable first. Cache breakpoints (BP) are marked.**
  1. System prompt: identity, rules, tool-use policy. Static, versioned, no timestamps. **BP1**
  2. Tool definitions: the full, stable set with prefixes (`mail_`, `cal_`, `mem_`, `web_`). Never add or remove tools mid-thread. Gate them with `tool_choice` or `activeTools` where the provider supports it, or with a policy check that returns "tool unavailable in this state" errors. True logit masking is not available through OpenRouter.
  3. Core profile memory block: a small, slowly changing user profile (for example 1–2k tokens) regenerated by the background job, not per turn. **BP2**
  4. Rolling summary of older conversation (compaction output). Changes only on compaction events. **BP3**
  5. Append-only recent messages and tool results.
  6. Per-turn dynamic tail: current date and time, retrieved facts relevant to this turn (hybrid retrieval, top-k about 10–20), active todo/plan recitation, then the user message. **BP4** (Anthropic: on the last message)
- Putting retrieved memory in the tail rather than the system prompt preserves the prefix cache. It costs a slight loss of salience, which recitation and placement near the user message offset.
- **Tiered compaction policy:**
  - Tier 0 (always): store large tool outputs (emails, web pages, search results) in Postgres or blob storage and put a pointer plus a short summary in context. Manus-style restorable compression: keep `email_id`, `url`, `doc_id`.
  - Tier 1: once over about 60% of the model window, or a fixed budget such as 100k, clear tool results older than the last 3, using placeholders that keep the IDs. Only do this when it frees at least a set minimum (for example 5–10k tokens), mirroring `clear_at_least`.
  - Tier 2: once over about 80%, summarize everything before the last N turns with a cheap model into a structured summary (decisions, open tasks, user preferences surfaced, unresolved questions). Before summarizing, run a "memory flush" so the extractor writes durable facts.
  - These thresholds are my suggestions, extrapolated from the Anthropic defaults (100k trigger, keep 3). They are not benchmarked values.
- **Determinism:** serialize tool results with stable key ordering (for example a canonical JSON stringify). Never rewrite past messages except at explicit compaction boundaries.
- **Keep failed tool calls and their error messages** in context, truncated, rather than silently retrying.

### Gaps
- The full parameter set and beta header for Anthropic's server-side `compact_20260112` were not read; it is on a separate docs page.
- I found no published, quantified comparison of summarization prompts or formats for compaction quality.
- OpenRouter does not expose logit masking or Manus-style function-name prefill uniformly. Whether assistant prefill works across providers through OpenRouter was not verified.

---

## Q3. Memory architectures for personal assistants, and how benchmarks compare them

### Takeaway
The field has converged on layering:

- a small always-in-context "core" profile or memory block;
- a large searchable store of facts and episodes;
- raw conversation search as a fallback;
- background ("sleep-time" or "dreaming") consolidation, alongside or instead of making the main agent manage memory synchronously.

Benchmarks are unreliable for picking a winner. Vendor self-reports cluster at 92–96% on LoCoMo and LongMemEval and contradict each other. An independent 2026 study found long-context GPT-5-mini beating Mem0-style flat fact extraction by about 33–35 points, with memory only cheaper after about 10 re-engagements.

### Cited Findings
- **Independent cost/accuracy study (Pollertlam & Kornsuwannawit, arXiv 2603.04814, 2026-03-05).**
  - Memory pipeline: Mem0 OSS with GPT-5-nano extraction, text-embedding-3-small, pgvector HNSW, top_k=20, GPT-5-mini answering.
  - Accuracy, memory vs long-context GPT-5-mini:
    - LoCoMo: 57.68% vs 92.85%
    - LongMemEval: 49.00% vs 82.40%
    - PersonaMem v2: 62.48% vs 69.75% (memory beat LC GPT-OSS-120B at 60.50%)
  - Cost per user at about 100k-token histories:
    - Memory: write $0.0435 per conversation, read about $0.0013 per query.
    - Long context: $0.0293 per request with caching.
    - Break-even at about 10 turns (13 at 30k tokens, 9 at 200k and 500k). Memory saves about 26% at 20 turns.
  - Authors' recommendation: memory for persistent agents re-engaged more than about 10 times; long context for single-session or precision-critical work.
  - Caveat: only Mem0's flat-typed extraction was tested.

  — [arXiv 2603.04814](https://arxiv.org/html/2603.04814v1). This is directly relevant to Mimir: it is nearly the same stack (flat facts + pgvector).
- **Mem0's 2026 benchmark roundup (vendor, published 2026-11-17).**
  - Self-reported scores: Mem0 92.5% LoCoMo (prior version 71.4%, about 7.0K tokens per retrieval, p50 0.88s) and 94.4% LongMemEval (prior 67.8%), BEAM-1M 64.1%, BEAM-10M 48.6%.
  - Zep: claims 94.7% on LoCoMo. ByteRover's table puts Zep at 75.1% and Mem0 at 66.9%. Zep's LongMemEval is about 71.2% with a GPT-4o judge.
  - ByteRover has published both 92.2% and 96.1% on LoCoMo.
  - Scores shift with the answer model, the judge and reranking. No public benchmark fully tests write quality, forgetting, or per-user isolation.

  — [Mem0, AI Memory Benchmarks 2026](https://mem0.ai/library/agent-memory/ai-memory-benchmarks-in-2026); also [Mem0 State of Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- **What the benchmarks test.**
  - LongMemEval: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention (`_abs` questions reward declining to answer).
  - LoCoMo: long multi-session dialogue with temporal and multi-hop questions.
  - BEAM: up to 10M tokens; covers contradiction resolution and telling instructions apart from preferences.
  - DolphinBench and STATE-Bench score completed actions or tasks rather than QA.

  — [Mem0 benchmarks page](https://mem0.ai/library/agent-memory/ai-memory-benchmarks-in-2026)
- **LoCoMo disputes.** LoCoMo has seen public methodology disputes between vendors, and changing the answer model alone moves scores several points. — summarized from search results citing [arXiv 2607.21503](https://arxiv.org/pdf/2607.21503) and related 2026 papers (not fetched in full). Other 2026 papers in this space include Eywa ([2605.30771](https://arxiv.org/pdf/2605.30771)), Agent Zero Memory ([2608.29606](https://arxiv.org/pdf/2608.29606), claims 95.6% LongMemEval and 93.6% LoCoMo, self-reported), and "When does memory help? Cost-aware evaluation in tool-using agents" ([2609.05441](https://arxiv.org/pdf/2609.05441)). None were read beyond search snippets.
- **Zep / Graphiti (arXiv 2501.13956, 2025-01-20).** Graphiti is a "temporally-aware knowledge graph engine" that combines conversational and business data while keeping historical relationships. Abstract claims: DMR 94.8% vs 93.4% for MemGPT; LongMemEval accuracy up to +18.5%; 90% lower latency than baselines. — [arXiv 2501.13956](https://arxiv.org/abs/2501.13956). The bi-temporal edge fields and edge invalidation are from my training knowledge of the full paper, not re-verified here. Graphiti stores validity intervals (valid/invalid time plus system created/expired time) on fact edges and invalidates, rather than deletes, contradicted edges.
- **Letta (formerly MemGPT), current state.** Letta now describes memory as **MemFS**, a git-backed filesystem "shared across the agent's conversations". Its sleep-time feature is called **"dreaming"**: background sub-agents review recent conversations and update memory without interrupting work. It triggers after a configurable number of agent steps or when the context is compacted. An optional "Agent reviews before applying" pass revises the proposed updates. Configured with `/sleeptime`. Storage: 5 MiB free, 50 MiB Pro. — [Letta docs, sleeptime](https://docs.letta.com/guides/agents/architectures/sleeptime)
- **Classic MemGPT.** Core memory blocks are labelled, character-limited and always in context (e.g. `persona`, `human`). They are edited with self-edit tools; archival memory is a vector store and recall memory is conversation search. — (training knowledge of [MemGPT, arXiv 2310.08560](https://arxiv.org/abs/2310.08560) and older Letta docs; not re-verified this session; the current docs page no longer describes blocks)
- **Mem0 paper.** It extracts candidate facts and then chooses ADD, UPDATE, DELETE or NOOP against similar existing memories. It reports about a 26% relative LLM-judge gain over OpenAI memory on LoCoMo, about 91% lower p95 latency and about 90% fewer tokens than full context. — (training knowledge of [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) abstract; not re-fetched; note that the 2026 independent study above contradicts the full-context comparison)
- **Claude consumer memory (current).**
  - Memory is saved "as individual topics during chats", updates "as you chat", and is editable in Settings or by asking in chat ("the update applies to your next conversation").
  - Chat search is RAG over past chats that "will appear as tool calls".
  - Projects are isolated: project chats use project memory plus account memory but never other projects' memory, and account memory can be turned off per project.
  - Incognito chats are excluded.
  - Legacy experience: a synthesized memory summary "updated every 24 hours".

  — [Claude Help Center](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md)
- **ChatGPT memory.** It has "saved memories" (discrete, user-viewable snippets) plus "Reference chat history". Coverage said chat history could not be enabled without saved memories. One 2026 article claims OpenAI merged both into a single background system; this is unverified and conflicts with other coverage. — [MindStudio comparison](https://www.mindstudio.ai/blog/claude-memory-vs-chatgpt-memory-comparison), [tech-insider 2026](https://tech-insider.org/chatgpt-vs-claude-vs-gemini-memory-2026/) (secondary sources, low confidence)
- **File-based memory (Claude Code style).** CLAUDE.md is loaded up front; the API memory tool (`memory_20250818`) is a client-side, file-directory memory the model reads and writes through tool calls. — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [Claude Docs, Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

### Inferences
- **Agent-managed vs background extraction for a personal assistant.** Every major product now runs both paths:
  - a cheap, explicit path where the user or model says "remember X" and a `mem_write` tool commits it immediately;
  - a background consolidation path (Letta dreaming, Claude's ongoing topic memory, the legacy 24-hour summary) that does the bulk of extraction off the hot path.

  Mimir's existing background extraction is the right backbone. Add (a) a small set of memory tools for explicit writes, corrections and forgetting, and (b) a sleep-time consolidation job.
- **Mimir's architecture closely matches the stack that lost by about 35 points** in arXiv 2603.04814 (flat facts, pgvector top-k). Mitigations the evidence supports:
  - Keep raw conversation and episode search as a fallback tool (Claude's chat-search-as-tool), so the model can retrieve verbatim history when facts are lossy.
  - For a single active thread, keep a generous recent raw window (long context wins on accuracy) and rely on facts mainly across sessions, where you pass about 10 re-engagements and memory wins on cost.
  - Use temporal validity on facts (Graphiti-style valid_from/valid_to plus superseded_by) rather than hard deletes. LongMemEval's knowledge-update and temporal categories reward this, and Mimir's supersede-on-conflict is halfway there.
  - Support abstention: the prompt should tell the model to say it doesn't know when no fact is retrieved.
- **Core profile block:** a background job condenses the top facts into a bounded (for example 1–2k-token) "user profile" block that is always in context and cached (Q2, item 3). Retrieval fills the per-turn tail.
- **Evaluate on your own data.** Given the benchmark disputes, build a small in-house eval: 30–100 QA pairs over real Mimir history with categories mirroring LongMemEval (update, temporal, multi-session, abstention). Don't rely on vendor numbers.

### Gaps
- Cognee and LangMem were not researched this session; I found no primary sources for their 2026 designs or benchmark results.
- I could not confirm current Letta memory-block APIs (`memory_replace`, `memory_insert`, `memory_rethink`) from current docs. The docs page now centers on MemFS.
- No independent head-to-head of Zep, Letta, Mem0 and LangMem under one judge and answer model was found. The only independent number is the Mem0-vs-long-context study.
- OpenClaw's MEMORY.md design was not researched.
- ChatGPT's 2026 memory architecture is not confirmed from an OpenAI primary source.

---

## Q4. Multiple sessions/threads per user; always-on thread vs many; context crossing between background agents and main conversation

### Takeaway
Products use many threads over one shared, scoped memory store rather than one infinite thread:

- Claude: account memory plus isolated project memory plus chat search across threads.
- Letta: MemFS shared across conversations.

Background or sub-agents should hand back condensed summaries (about 1–2k tokens) or write to shared memory, never their raw transcripts.

### Cited Findings
- **Claude scoping.** Account memory is shared across non-project chats. Project memory is isolated per project and can be cut off from account memory. Chat search is scoped to the current project. — [Claude Help Center](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md)
- **Letta.** Memory (MemFS) is "shared across the agent's conversations". Background dreaming sub-agents update it asynchronously, triggered by step count or by compaction events. — [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)
- **Sub-agent handoff.** Sub-agents return condensed 1,000–2,000-token summaries to the lead agent from clean contexts. — [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Cross-session continuity through artifacts.** Anthropic's long-running harness passes state between sessions through files (a progress log, a JSON task list, git), not conversation history. Every session starts by reading them. — [Anthropic, Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **OpenRouter session stickiness.** It is per conversation (hash of opening messages, or `session_id`) with a 60-minute idle expiry. This favors stable, distinct thread IDs for cache warmth. — [OpenRouter Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)

### Inferences
- **Recommended model for Mimir:**
  - One "home" thread per user, which feels always-on, plus ad-hoc topic threads.
  - All threads share the user-level fact store and core profile block.
  - Every thread has its own rolling summary and append-only message log.
  - Treat the home thread as a sequence of compaction epochs rather than an unbounded transcript.
- **Background agents** (email triage, reminders, scheduled research) run as their own `agent_run` with their own thread. They communicate back by:
  - (a) writing facts or episodes to memory with `source=background_job_id`;
  - (b) posting a short structured "inbox item" (title, 1–3 sentence summary, links/IDs, needs_user_action flag) into the home thread, as a system-tagged message appended at the tail so the cache is preserved;
  - never by injecting their transcripts.
- **Main to background:** when the main agent spawns a job, pass a self-contained task brief (goal, constraints, relevant fact IDs), not the conversation.
- **Thread-scoped vs user-scoped memory:** add a `scope` column on facts (user | project/thread) to mirror Claude's project isolation.

### Gaps
- I found no published guidance from OpenAI or Anthropic on single always-on thread vs multi-thread design for assistants beyond the product scoping behavior above.

---

## Q5. Model choice per step; structured outputs vs free tool calling; provider-agnostic tool calling via OpenRouter

### Takeaway
Per-step model routing is a first-class harness feature (Vercel `prepareStep` can switch the model per step). Tool-calling reliability varies by provider for the same model, and OpenRouter now measures it ("Tool Call Error Rate", used by Auto Exacto routing). Use cheap models for extraction, summarization and classification; a frontier model for the main turn; and finish-tool or JSON-schema patterns for structured results.

### Cited Findings
- **Vercel `prepareStep`** can override the model per step (for example "switch to a stronger model after early steps") along with `activeTools`, `toolChoice` and sampling. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- **OpenRouter.**
  - Filter models with `supported_parameters=tools`.
  - Tool-calling reliability varies by provider and is shown as Tool Call Error Rate on each model's Performance tab.
  - "Auto Exacto" orders providers for tool-calling requests by that error rate.
  - Interleaved thinking (reasoning between tool calls) raises tokens and latency, and its quality depends on the model.

  — [OpenRouter Tool Calling](https://openrouter.ai/docs/features/tool-calling)
- **Reasoning items must be replayed** in order when continuing a tool loop. — [OpenRouter Tool Calling](https://openrouter.ai/docs/features/tool-calling)
- **Cheaper models for summaries.** Anthropic's (deprecated) client compaction exposed a `model` option for this. — [Claude Docs, Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **Model split in the independent memory study.** GPT-5-nano handled extraction and GPT-5-mini handled answering. The nano extraction stage was one likely factor in the accuracy gap; this is my inference, since the authors flag only that their test was limited to flat extraction. — [arXiv 2603.04814](https://arxiv.org/html/2603.04814v1)
- **Structured-output pattern.** Use `toolChoice: 'required'` plus a `done` tool whose schema is the final output format. — [AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)

### Inferences
- **Per-step routing table for Mimir:**
  - Main conversational turn: frontier model.
  - Fact extraction, compaction summaries and the conflict/supersede judge: a mid-tier model. Don't go too cheap; extraction quality bounds memory quality.
  - Intent classification and routing: a cheap model with JSON-schema output.
  - Background agents: mid-tier, escalating to frontier on failure.
- Switching models mid-thread breaks the prefix cache (caches are per model and provider). Switch at thread or run boundaries, not per step, unless the step is a side computation with its own context.
- **Use JSON-schema `response_format` for non-agentic single calls** (extraction, classification). Use tool calling for the agentic loop. For "final answer in a schema" inside a loop, use the done-tool pattern, which works on any tool-capable model.
- **Normalize at the edge.** Write one internal message format (role, content parts, tool_calls with id/name/args object, tool results with call id, reasoning items opaque) and adapters to OpenRouter Chat Completions or Responses. Parse args defensively (repair or reject invalid JSON and return the error to the model as a tool error). Validate with Zod and feed validation errors back as tool errors.
- Pin `session_id` per thread on OpenRouter for cache stickiness. Avoid manual `provider.order` unless you need it, because it bypasses sticky routing.

### Gaps
- I found no cross-model tool-calling reliability benchmark (BFCL or similar) for 2026 in this session; OpenRouter's per-provider Tool Call Error Rate numbers were not retrieved.
- OpenRouter's `response_format: json_schema` support matrix and the `provider.require_parameters` behavior were not fetched.

---

## Q6. Observability for the loop and evals for harness changes

### Takeaway
Trace every run as `invoke_agent`, with child spans for each model call (`chat`) and each `execute_tool`, following the OpenTelemetry GenAI semantic conventions. These now live in a dedicated repo and are still evolving. Record token, cache and cost usage per step; Mimir's `agent_step` journal can double as the trace store. Evals should combine a fixed replay set with LongMemEval-style memory QA on your own data.

### Cited Findings
- **OTel GenAI semconv** has moved from the main semantic-conventions site to a dedicated repo, `open-telemetry/semantic-conventions-genai`. It covers spans, metrics and events for GenAI clients plus MCP and provider-specific conventions. The schema URL is still "TODO", which suggests the conventions are still in development. — [OTel notice](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/); [semantic-conventions-genai repo](https://github.com/open-telemetry/semantic-conventions-genai)
- **Cache metrics to log.** OpenRouter exposes `cached_tokens`, `cache_write_tokens` and `cache_discount` per response, plus `/api/v1/generation` for per-generation detail. — [OpenRouter Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)
- **Context-edit telemetry.** Anthropic reports `context_management.applied_edits` (`cleared_tool_uses`, `cleared_input_tokens`), and `count_tokens` returns pre- and post-clearing counts. — [Claude Docs, Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **Read memory scores with cost and latency.** A 92-point score at 70K tokens per query is a different product from the same score at 7K. — [Mem0 benchmarks page](https://mem0.ai/library/agent-memory/ai-memory-benchmarks-in-2026)
- **Testing in Anthropic's harness.** Unit tests and curl checks were not enough. End-to-end, user-like verification (browser automation) was needed before marking tasks done. — [Anthropic, Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Inferences
- **Span names and attributes.** The `invoke_agent`, `chat`, `execute_tool` span names and the `gen_ai.*` attributes (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.conversation.id`, `gen_ai.tool.name`, `gen_ai.tool.call.id`) come from my training knowledge of the conventions as of 2025. I could not re-verify them because the docs moved. Check the new repo's `docs/` folder before relying on them.
- **Per-turn trace record** (works with Langfuse, Braintrust or plain Postgres): run_id, thread_id, prompt_version, model and provider, per-step input/output/cached tokens, cost, latency, tool name/args/result size/error, compaction events, retrieved fact IDs, stop reason (end_turn | step_cap | budget | done_tool | error).
- **Harness eval set:**
  - (a) 30–100 recorded real conversations, replayed against new harness versions and scored by an LLM judge on task success and the tool-call trajectory;
  - (b) memory QA probes per LongMemEval category, including abstention;
  - (c) regression metrics: cache hit rate, tokens per turn, step count, and the duplicate side-effect count (should be 0).
  - Run (a) and (b) on every prompt or harness change.

### Gaps
- I did not fetch the exact current OTel GenAI span and attribute names or their stability level from the new repo.
- I did not research Langfuse or Braintrust 2026 features or their OTel ingestion; there are no sources for them in these notes.
- I found no published eval methodology specific to personal-assistant harness regressions.
