# Subagent and Multi-Agent Orchestration Patterns for LLM Agent Harnesses (as of Nov 2026)

Research date: 2026-11-22. Primary sources were fetched in this session unless marked "(not re-fetched this session)". Those items come from well-known posts whose URLs and content I am confident of, but the report writer should treat them as slightly lower confidence.

## 1. How leading harnesses implement subagents mechanically

### Takeaway
The harnesses have settled on one core primitive: **agent-as-tool**. The parent calls a tool such as `Agent`/`Task`/`spawn_agent`/`sessions_spawn` with a natural-language brief. The child runs in a **fresh context window** with a restricted tool set and often a cheaper model, and **only its final message returns** to the parent. Around that primitive they add the same knobs: fork mode (the child inherits the parent transcript), background/non-blocking runs with completion notifications, resume by ID, depth limits, and concurrency caps. "Handoff" (control transfers to the specialist) is the second pattern. It is used mainly in customer-facing routing (OpenAI Agents SDK, Google ADK `transfer_to_agent`).

### Cited Findings
**Claude Code (Anthropic), current docs**
- Subagents are Markdown files with YAML frontmatter. The body is the system prompt, and only `name` and `description` are required. Optional fields: `tools`/`disallowedTools`, `model` (sonnet/opus/haiku/full ID/`inherit`), `permissionMode`, `maxTurns`, `memory` (user/project/local), `background`, `isolation: worktree`, `skills`, `hooks`, `mcpServers`, `omitClaudeMd`, `effort` — [Claude Code docs: Subagents](https://code.claude.com/docs/en/sub-agents)
- Context isolation: "Each subagent starts with a fresh context window. It doesn't see your conversation history, invoked skills, or files already read. Claude writes a delegation message, and the subagent works from that." The initial context is its own system prompt, environment details, the task message, CLAUDE.md files, a git status snapshot, preloaded skills, and a roster of sibling agents — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Return contract: only the subagent's final result returns to the parent, and intermediate output stays in the child's context. Claude Code **scans the final report for instruction-like text** before the parent reads it, as a prompt-injection mitigation. The scan marks text and never removes it — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- When `maxTurns` is reached, output comes back marked as partial and the subagent can be resumed — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Some tools are always removed from subagents, including `AskUserQuestion` and plan-mode tools, so subagents cannot interrupt the user directly. Background subagents get a smaller built-in tool set — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Forks are the exception to fresh context. A fork inherits the parent conversation and the exact tool pool, runs on the parent's model, and is on by default in interactive sessions (`CLAUDE_CODE_FORK_SUBAGENT=0` turns it off) — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Nesting: subagents can spawn subagents. The default depth limit is 3 layers (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, and 1 disables nesting). At the limit the Agent tool is withheld. The default concurrency cap is 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Custom subagents spawned from the main conversation start in the background by default, and results arrive later as a completion notification — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Resume: `SendMessage` to an agent ID or name resumes it with its full history. Transcripts are stored as JSONL per agent and deleted after 30 days by default. "No agent message counts as your approval for a permission prompt" — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Persistent per-agent memory: a `memory:` scope gives a directory whose `MEMORY.md` (first 200 lines or 25KB) is loaded into the system prompt — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Model precedence: per-invocation `model` → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` env → parent model — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- "Agent teams" are a different mechanism: a coordinated set of separate sessions with shared task tools (`TaskCreate/TaskList/TaskUpdate`) and cron tools, as opposed to subagents that report to one parent. I could not read the full teams page — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Third-party handbooks disagree on when fork mode and background-by-default became defaults (one cites v2.1.198). Treat version numbers as unverified — [Claude Code handbook (3rd party)](https://joeyyu23.github.io/claude-code-handbook/en/book2-advanced/05-subagents)

**OpenAI Codex**
- Subagents shipped in Codex app and CLI in early March 2026 — [Impress Watch](https://forest.watch.impress.co.jp/docs/news/2094681.html). They are experimental and opt-in (`/experimental` or the `multi_agent` flag in config.toml) — [OpenAI Codex multi-agent docs](https://developers.openai.com/codex/multi-agent)
- Codex does not spawn subagents unless the user explicitly asks for subagents or parallel work — [OpenAI Codex concepts](https://developers.openai.com/codex/concepts/subagents)
- Tools exposed: `spawn_agent`, `send_input`, `resume_agent`, `wait`, `close_agent`. A CSV batch fan-out tool additionally needs `enable_fanout` — [HexDocs codex_sdk subagents guide (3rd party)](https://hexdocs.pm/codex_sdk/10-subagents.md)
- Built-in roles are `default`, `worker` (implementation) and `explorer` (read-heavy). Custom agents are TOML files in `~/.codex/agents/` or `.codex/agents/` with `name`, `description`, `developer_instructions`. `agents.max_concurrent_threads_per_session` caps open child threads (`max_threads` is a legacy alias) — [Codex docs (now at learn.chatgpt.com)](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- "When many agents are running, Codex waits until all requested results are available, then returns a consolidated response." Subagents return summaries, not raw intermediate output — [Codex docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Subagents inherit the parent's sandbox and approval settings, and a custom agent file "can't replace those settings". In non-interactive runs, an action that needs new approval fails and the error surfaces to the parent — [Codex docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- A secondary source reports defaults of 6 concurrent threads and nesting depth 1 (no grandchildren). This is not confirmed in the official docs I read — [SaveDelete](https://savedelete.com/article/openai-codex-subagents-parallel-ai-coding/)
- July 2026 community report: after the GPT-5.6 rollout, `spawn_agent` stopped accepting `agent_type`/`model`/`reasoning_effort` (a `multi_agent_v2` config). This shows per-child model tiering being toggled by the vendor — [OpenAI Community](https://community.openai.com/t/codex-cli-can-no-longer-spawn-subagents-with-specific-models-or-reasoning/1386290)
- OpenAI's Agents API (announced Sept 10, 2026) runs cloud agents on the Codex harness with a `multi_agent` setting including `max_concurrent_subagents` — [OpenAI](https://openai.com/index/introducing-the-agents-API/)

**OpenAI Agents SDK**
- Two patterns. **Handoffs**: "Control moves to the specialist agent." **Agents as tools** (`asTool()`/`as_tool()`): "The manager keeps ownership of the reply." "Handoffs are the clearest fit when a specialist should own the next response rather than merely helping behind the scenes" — [OpenAI orchestration guide](https://developers.openai.com/api/docs/guides/agents/orchestration)
- Guidance: "Start with one agent whenever you can". Split "only when the next branch truly needs different instructions, tools, or policy". "Splitting too early creates more prompts, more traces, and more approval surfaces without necessarily making the workflow better" — [OpenAI orchestration guide](https://developers.openai.com/api/docs/guides/agents/orchestration)
- Handoffs "can also carry structured metadata or filtered history". The details are in per-language SDK docs that I did not fetch — [OpenAI orchestration guide](https://developers.openai.com/api/docs/guides/agents/orchestration); [Agents SDK JS multi-agent guide](https://openai.github.io/openai-agents-js/guides/multi-agent)

**Google ADK**
- Workflow agents `SequentialAgent`, `ParallelAgent`, `LoopAgent` control how sub-agents execute deterministically. LLM-driven `transfer_to_agent(agent_name=...)` hands off the conversation. `AgentTool` wraps an agent so the parent "call[s] it explicitly, effectively treating the sub-agent's entire workflow as a single function call" — [ADK multi-agent docs](https://adk.dev/agents/multi-agents); [Google Developers Blog: multi-agent patterns in ADK](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/)
- Draft-and-review is a SequentialAgent inside a LoopAgent that enforces the exit condition — [Google Developers Blog](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/)
- The adk.dev patterns page says the Python/TypeScript workflow-agent classes are being phased out (deprecation warnings, removal planned). This conflicts with newer ADK 2 codelabs that still use them, so check versions — [adk.dev workflow patterns](https://adk.dev/workflows/patterns/)

**OpenClaw (open-source personal-assistant harness, closest analog to Mimir)**
- `sessions_spawn` is **non-blocking**. It returns a run ID once startup is accepted, and the child runs in its own session `agent:<agentId>:subagent:<uuid>`. When finished, the child **announces** its result back to the requester's chat channel — [OpenClaw docs: subagents](https://docs.openclaw.ai/tools/subagents)
- The announce step runs inside the child's session. The special reply `ANNOUNCE_SKIP` keeps the child silent. Announce replies are normalized to Status/Result/Notes, and **Status comes from the runtime outcome, not model text** (seen in docs mirror search snippets) — [OpenClaw docs: announce](https://docs.openclaw.ai/tools/subagents/announce)
- Parameters include `task`, `label`, `agentId`, `model`, `thinking`, `runTimeoutSeconds`, `cleanup`, `context` (`"fork"` copies requester transcript, default fresh), `sandbox`, `visible`. Sub-agents do not get session/message tools by default. There is cascade stop and a per-agent spawn limit — [OpenClaw docs](https://docs.openclaw.ai/tools/subagents)
- Depth 2 is a leaf: `sessions_spawn` is always denied there. Sub-agent sessions auto-archive after `archiveAfterMinutes` (default 60) (from search snippets of docs versions; versions differ on which tool profiles include `sessions_spawn`) — [OpenClaw docs](https://docs.openclaw.ai/tools/subagents)
- Docs recommend a cheaper model for sub-agents via `agents.defaults.subagents.model`, with the main agent kept on a higher-quality model — [OpenClaw docs](https://docs.openclaw.ai/tools/subagents)

**Anthropic multi-agent research system (June 13, 2025)**
- Orchestrator-worker: a lead agent (Opus 4) plans, saves the plan to memory, spawns parallel subagents (Sonnet 4), synthesizes, and decides whether to loop. A separate CitationAgent attributes claims at the end — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

**Manus Wide Research (July 2025)**
- One sub-agent per item. "Every subagent in Wide Research is a fully capable, general-purpose Manus instance" with a fresh context and the full toolset, not role-based. The main agent decomposes the request into independent sub-tasks and aggregates the results (for example, 100 agents for sneaker comparisons, output as a sortable table) — [Manus: Introducing Wide Research](https://manus.im/blog/introducing-wide-research); [Manus: Wide Research solves the context problem](https://manus.im/blog/manus-wide-research-solve-context-problem); [VentureBeat](https://venturebeat.com/ai/youve-heard-of-ai-deep-research-tools-now-manus-is-launching-wide-research-that-spins-up-100-agents-to-scour-the-web-for-you)
- Manus has not published benchmarks against a single agent — [VentureBeat](https://venturebeat.com/ai/youve-heard-of-ai-deep-research-tools-now-manus-is-launching-wide-research-that-spins-up-100-agents-to-scour-the-web-for-you)

**Devin (Cognition)**
- "Devin Manages Devins" (March 2026): a manager Devin splits a large task, spawns child Devins in isolated VMs, and tracks progress through an internal MCP. It targets week-long, multi-PR work — [Cognition: Multi-Agents: What's Actually Working (Apr 22, 2026)](https://cognition.com/blog/multi-agents-working)

**LangGraph**
- The supervisor vs swarm benchmark (June 2025, modified Tau-bench with distractor domains): single-agent performance declined as irrelevant context grew. Swarm slightly beat supervisor, because the supervisor's "translation" step paraphrased sub-agent output. Adding a `forward_message` tool, which passes a sub-agent's response straight to the user, plus removing handoff messages, reportedly improved the supervisor by about 50%. The 50% figure comes from third-party coverage — [LangChain blog: Benchmarking Multi-Agent Architectures](https://blog.langchain.com/benchmarking-multi-agent-architectures); [blockchain.news summary](https://blockchain.news/news/evaluating-multi-agent-architectures-performance-benchmark)

### Inferences
- For Mimir, the agent-as-tool primitive (manager keeps the reply) is the right default. Handoffs fit a chat-routing product, but a personal assistant should keep one consistent voice that owns the user conversation. This matches Poke's "personality agent + execution agents" split (see Q3).
- OpenClaw is the closest structural match (chat-channel assistant, non-blocking spawn, announce back, runtime-derived status, fork option, depth-2 leaf, cheaper default sub-agent model). Its design is a good template for a BullMQ-backed implementation.
- Every mature harness strips user-interaction tools from children and returns a single final message. Mimir should do the same: children never message the user directly. They post results to the parent, which decides what the user sees. The exception would be an explicit `forward_message`-style passthrough.

### Gaps
- Letta multi-agent (shared memory blocks, `send_message_to_agent_async`), CrewAI, AutoGen, Magentic-One (Task Ledger/Progress Ledger orchestrator), Amp's "oracle"/subagents, and Cursor background agents: not fetched in this session, so mechanics are unverified here. Magentic-One's design is described at [Microsoft Research (Nov 2024, not re-fetched)](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/).
- Grok "bots" and "SuperBot bots": I found no reliable primary sources on their subagent mechanics.
- Codex official depth-limit default was not confirmed.
- I did not inspect source code of the Claude Agent SDK or OpenAI Agents SDK. The Claude Agent SDK exposes the same subagent concept as Claude Code (it is the Claude Code harness as a library), but I did not fetch its docs this session.

## 2. The debate: Cognition "Don't Build Multi-Agents" vs Anthropic's multi-agent research system, and later evidence

### Takeaway
The debate has largely resolved into a consensus by 2026. **Parallelize reads and "intelligence", keep writes and decisions single-threaded.** Multi-agent clearly pays off for breadth-first, parallelizable, read-heavy work (research, triage, per-item fan-out, clean-context review). It hurts on sequential, tightly coupled tasks where sub-decisions conflict. Google/MIT's 2025 controlled study measured 39–70% degradation for multi-agent on sequential tasks against an 80.8% gain on parallelizable ones.

### Cited Findings
- Cognition, "Don't Build Multi-Agents" (June 12, 2025): two principles, "Share context, and share full agent traces, not just individual messages" and "Actions carry implicit decisions, and conflicting decisions carry bad results". The Flappy Bird example shows subagents building mismatched pieces. The post recommended a single-threaded linear agent, with context compression for long tasks — [Cognition (not re-fetched this session)](https://cognition.ai/blog/dont-build-multi-agents)
- Anthropic (June 13, 2025): the multi-agent setup beat single-agent Opus 4 by **90.2%** on an internal research eval. Token usage explained **80%** of BrowseComp performance variance (95% together with tool-call count and model choice). Agents use about **4x** the tokens of chat and multi-agent systems about **15x**. Parallelization cut research time by up to **90%** — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic's own caveat: multi-agent is a poor fit for "tasks that require shared context, many inter-agent dependencies, or real-time coordination". "Most coding tasks" fall here — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cognition follow-up, "Multi-Agents: What's Actually Working" (Walden Yan, **April 22, 2026**): "we've found a narrower class of patterns that do [work]: setups where multiple agents contribute intelligence to a task while writes stay single-threaded." The original warnings "still hold" for parallel-writer swarms. Unstructured swarms are "mostly a distraction", and the practical shape is "map-reduce-and-manage" — [Cognition](https://cognition.com/blog/multi-agents-working)
- In the same post, the patterns that work are:
  - Generator-verifier (Devin + Devin Review) catches about 2 bugs per PR, about 58% of them severe. It works best when the reviewer has **no shared prior context** ("completely clean context also helps it go deeper").
  - The "Smart Friend" advisor works when both models are strong. With a weak primary (SWE-1.5 at about 950 tok/s plus a Sonnet 4.5 advisor), the primary set the quality ceiling. Delegation works as "a capability router rather than a difficulty escalator."
  - Manager Devins delegate to child Devins.

  [Cognition](https://cognition.com/blog/multi-agents-working)
- Google Research/MIT, "Towards a Science of Scaling Agent Systems" (arXiv 2512.08296, Dec 2025) tested 5 architectures across 180 configurations. All multi-agent variants **degraded sequential-task performance by 39–70%** (PlanCraft −70%). Centralized coordination **improved parallelizable tasks by 80.8%**. Independent, non-communicating parallel agents **amplified errors 17.2x**, while centralized systems contained errors best. A predictive model picked the best coordination strategy for 87% of unseen configurations — [arXiv 2512.08296](https://arxiv.org/abs/2512.08296); [Google Research blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
- MAST, "Why Do Multi-Agent LLM Systems Fail?" (Cemri et al., UC Berkeley, NeurIPS 2025): it analyzed 7 MAS frameworks on 200+ tasks and found 14 failure modes in 3 categories: specification issues, inter-agent misalignment, task verification (Cohen's κ 0.88). It notes performance gains over single-agent baselines "often remain minimal". ChatDev reached only 33.33% correctness on ProgramDev — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657v3); [Berkeley Sky MAST](https://sky.cs.berkeley.edu/project/mast/)
- LangChain benchmark: a single agent degrades as distractor context (more tools/domains) grows, and its token use rises, while the supervisor and swarm stayed flat. This is the strongest case for subagents as **context/tool isolation**, not parallelism — [LangChain blog](https://blog.langchain.com/benchmarking-multi-agent-architectures)
- LangChain "How and when to build multi-agent systems" (June 2025) reconciled both posts. Multi-agent suits "read" tasks more than "write" tasks, and context engineering is the core job — [LangChain blog (not re-fetched this session)](https://blog.langchain.com/how-and-when-to-build-multi-agent-systems/)
- OpenAI: "Start with one agent whenever you can" — [OpenAI orchestration guide](https://developers.openai.com/api/docs/guides/agents/orchestration). Codex: parallel agents for "read-heavy work such as exploration, tests, triage, and summarization". "Be more careful with parallel write-heavy work" — [Codex docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### Inferences
- For a personal assistant, most valuable subagent uses are **read/intelligence** tasks: research a topic, triage the inbox, look up N items, review a draft or plan with clean context. Write actions (sending email, booking, editing calendar, committing to memory) should funnel through one owner, either the main agent or a single execution agent per task, with idempotent tool calls.
- The 15x token multiplier and the sequential-task penalty mean Mimir should **not** decompose every request. Most personal-assistant requests are short and sequential ("move my 3pm and tell Bob") and should run single-agent. Fan-out only when the task decomposes into independent reads.
- Context isolation is itself a benefit, separate from parallelism (LangChain result). Spawning a child with a narrow tool set can beat loading 40 integration tools into the main agent, even when nothing runs in parallel.

### Gaps
- I found no independent 2026 replication of Anthropic's 90.2% figure, and no head-to-head personal-assistant benchmark (most evidence is research/coding/planning).
- MAST's 2025 data covers older frameworks (ChatDev, MetaGPT, etc.) and models (GPT-4, Claude 3). Failure rates with 2026 frontier models are not established.

## 3. Long-running background work: persistent vs ephemeral subagents (reporting, resume, cancel, memory)

### Takeaway
Production harnesses treat a background subagent as a **durable, addressable session/run**, not a function call. It has an ID, a persisted transcript, a non-blocking spawn, push-style completion notification ("announce"), resume by ID with full history, explicit stop/cascade-stop, timeouts, and auto-archive. Memory sharing goes through external stores (files/DB/MEMORY.md), never through shared live context. Reporting upward is a known weak point: models do not naturally report back, so the runtime must enforce it.

### Cited Findings
- Poke (The Interaction Company) uses a two-tier design. A user-facing "personality"/interaction agent delegates to background **execution agents** that have no direct user access, report results back to Poke, and run in parallel. The architecture is hidden from the user — [Poke system prompt compilation (3rd party, unverified)](https://www.mintlify.com/x1xhlol/system-prompts-and-models-of-ai-tools/commercial/poke); [TechCrunch, Apr 8 2026](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/)
- Cognition reportedly acquired The Interaction Company (Poke) to bring its conversational style into Devin. The valuation ("low nine figures") comes from a secondary source — [mezha.net](https://mezha.net/eng/?p=3145190)
- Claude Code: background subagents run concurrently, and results arrive as a completion notification. Permission prompts from background children surface in the main session and name the requesting subagent. `SendMessage` resumes an agent by ID with its full history. A subagent the user stopped won't auto-resume. Transcripts persist as JSONL and are cleaned up after 30 days — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Claude Code per-agent persistent memory lives in a directory with `MEMORY.md` auto-loaded (200 lines/25KB cap) — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- OpenClaw: `sessions_spawn` returns a run ID immediately, and the child announces to the requester channel on completion. Announce status comes from the runtime outcome. There is a `runTimeoutSeconds`, cascade stop, a Stop button for abortable runs, `sessions_history` to inspect child output, and auto-archive (default 60 min) — [OpenClaw docs](https://docs.openclaw.ai/tools/subagents); [OpenClaw announce](https://docs.openclaw.ai/tools/subagents/announce)
- Codex: `spawn_agent`/`send_input`/`resume_agent`/`wait`/`close_agent` cover the same lifecycle — [HexDocs codex_sdk (3rd party)](https://hexdocs.pm/codex_sdk/10-subagents.md)
- Anthropic research system: "Resume agents from checkpoints instead of restarting". Rainbow deployments avoid breaking agents mid-run. Subagents run synchronously, which "simplifies coordination but bottlenecks information flow". Async would "complicate consistency and error handling" — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cognition on manager/child, as open problems: "Agents assume they share state with their children when they don't." Children "don't report back to managers by default". Propagating one child's discoveries to siblings is unsolved — [Cognition 2026](https://cognition.com/blog/multi-agents-working)

### Inferences
- Mapping to Mimir's stack:
  - Store each execution agent as an `agent_runs` row in Postgres: id, parent_id, root_task_id, depth, status, brief, model, budget, transcript ref, result, created/finished.
  - Execute as a BullMQ job. Completion triggers an "announce" job that injects a structured result message into the parent conversation (or wakes the interaction agent).
  - Resume means re-enqueueing with the stored transcript. Cancel means a status flag the worker checks between turns, plus BullMQ job removal, cascading to children via parent_id.
- Persistent vs ephemeral:
  - Keep execution agents **ephemeral by default**: a run with a transcript that is archived after completion.
  - Make "persistent" agents, such as a standing inbox watcher or a recurring brief, scheduled re-invocations of a **named agent definition plus a durable memory file/row**, not a long-lived context window. This mirrors Claude Code `memory:` plus cron, and avoids context rot.
- Status must come from the runtime (job succeeded/failed/timeout/budget-exceeded), not from model text (the OpenClaw pattern). This addresses Cognition's "children don't report back" problem, because the harness always reports.

### Gaps
- No primary technical documentation from Poke on how execution agents are resumed, cancelled, or share memory. Details are inferred from leaked prompts and press.
- Grok Bot "bots" and SuperBot "bots": no reliable sources found.

## 4. Communication contracts: brief in, result out; avoiding the telephone game and duplicate work

### Takeaway
**Downward:** a self-contained brief with objective, output format, tool/source guidance, and explicit boundaries (what not to do, and what siblings cover), plus either a curated context slice or a full fork when the child needs the parent's reasoning. **Upward:** a short distilled result (about 1–2k tokens), with bulky artifacts written to external storage and passed by reference, and a runtime-set status field. The telephone game is avoided by references instead of paraphrase, by `forward_message`-style passthrough, and by keeping the synthesizer close to the user.

### Cited Findings
- Anthropic: each subagent task needs "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries". Vague instructions caused duplicated work and gaps — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic: "Subagents can write outputs to external storage and pass lightweight references back", which avoids the "game of telephone" and cuts token overhead — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic context engineering (Sept 29, 2025): each subagent "returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)". Just-in-time context passes "lightweight identifiers (file paths, stored queries, web links, etc.)" — [Anthropic Engineering: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Claude Code: the child sees only the delegation message plus its own system prompt, CLAUDE.md, and environment. A fork is the alternative when the full transcript is needed — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Cognition 2026 on how much context to share:
  - The reviewer should get **clean context** and only the diff.
  - The advisor ("Smart Friend") should get a **fork of the full context**, because partial context gave "less-informed answers".
  - Managers trained on small-scope delegation over-prescribe instructions when they lack deep context.
  - A communication bridge lets the user's instructions filter reviewer findings, which prevents loops and out-of-scope work.

  [Cognition](https://cognition.com/blog/multi-agents-working)
- Cognition 2025: share full traces, not individual messages — [Cognition (not re-fetched)](https://cognition.ai/blog/dont-build-multi-agents)
- LangChain: a supervisor paraphrasing sub-agent output introduced errors, and a `forward_message` tool that passes a sub-agent's response verbatim fixed much of it — [LangChain blog](https://blog.langchain.com/benchmarking-multi-agent-architectures)
- OpenClaw normalizes announce output to Status/Result/Notes, with Status from the runtime — [OpenClaw docs](https://docs.openclaw.ai/tools/subagents/announce)
- MAST failure categories include specification issues (poor task/role spec) and inter-agent misalignment (information withholding, ignoring other agents' input, task derailment) — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657v3)

### Inferences
- Proposed Mimir contract:
  - **Downward (`SpawnBrief`):**
    - `objective`, `success_criteria`, `output_schema` (or "free text summary ≤ N tokens")
    - `context` (an explicit list of facts and memory refs selected by the parent, or `fork: true`)
    - `allowed_tools`, `forbidden_actions` (for example "do not send messages; draft only"), `siblings_cover` (to prevent duplicates)
    - `budget` (turns/tokens/$/wall-clock), `deadline`, `model_tier`
  - **Upward (`AgentResult`):**
    - `status` (set by runtime: ok/partial/failed/timeout/cancelled/budget_exceeded)
    - `summary` (≤ about 1.5k tokens), `artifacts` (Postgres rows or object keys, by reference), `proposed_actions` (writes the child wants the parent to approve or execute)
    - `open_questions`, `provenance` (source URLs/tool outputs)
- `proposed_actions` puts Cognition's "single writer" rule into code: read-only research children return proposals, and the parent or one designated executor performs writes.
- Add a `forward_to_user` path so a child's well-formed final text (for example a drafted reply) is not re-paraphrased by the interaction agent.

### Gaps
- I found no quantitative study comparing structured-JSON results against free-text summaries for subagent returns.

## 5. Planning and reflection: explicit planners and evaluator loops vs todo-list tools and self-management

### Takeaway
Frontier harnesses have mostly **dropped separate planner agents** in favor of the model planning in-context with a **todo-list / notes tool** (Claude Code TodoWrite, NOTES.md, and the lead agent saving its plan to memory). Evaluator loops survive only where the evaluator is **grounded**: tests/execution, an external rubric/judge, or a clean-context reviewer. The evidence says ungrounded self-critique ("reflect and retry") gives little or no reliable gain.

### Cited Findings
- Anthropic context engineering lists structured note-taking: "the agent regularly writes notes persisted to memory outside of the context window", for example "Claude Code creating a to-do list, or your custom agent maintaining a NOTES.md file" — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic research system: the lead agent uses extended thinking as a planning scratchpad and saves its plan to memory, because context over 200k gets truncated. Interleaved thinking helps subagents assess results after each tool call. Planning happens inside the orchestrator, not in a separate planner agent — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic "Building Effective Agents" (Dec 19, 2024) catalogs prompt chaining, routing, parallelization, orchestrator-workers, and evaluator-optimizer. It advises starting with the simplest solution and adding complexity only when it demonstrably helps. Evaluator-optimizer fits "when we have clear evaluation criteria, and when iterative refinement provides measurable value" — [Anthropic (not re-fetched this session)](https://www.anthropic.com/research/building-effective-agents)
- Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet": LLMs struggle to self-correct reasoning without external feedback. Code self-debugging improves when execution results are fed back — [arXiv 2310.01798](https://arxiv.org/pdf/2310.01798)
- Kamoi et al. (TACL 2024) critical survey: there is no reliable evidence of successful intrinsic self-correction with prompting on general tasks. Self-correction works when reliable external feedback exists. "The bottleneck is in the feedback generation", and prior work often over-evaluated self-correction — [ACL Anthology TACL 2024](https://aclanthology.org/2024.tacl-1.78.pdf)
- Cognition 2026: a generator-verifier loop with a **clean-context reviewer** works (about 2 bugs/PR, about 58% severe). Context separation is the reason it works. Same-context self-review is weaker. A bridge using user instructions to filter findings prevents infinite loops — [Cognition](https://cognition.com/blog/multi-agents-working)
- Google ADK keeps LoopAgent (draft → review, with an exit condition) as a first-class pattern — [Google Developers Blog](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/)
- Google/MIT: multi-agent setups hurt sequential planning (PlanCraft −70%) — [arXiv 2512.08296](https://arxiv.org/abs/2512.08296)

### Inferences
- For Mimir:
  - Replace the standalone planner with a **`todo`/`plan` tool**: a Postgres-backed checklist the main agent and execution agents read and update. The model then decomposes in-context. That plan also serves as durable state for resume and the user-visible progress view.
  - Keep a reflector only as a **grounded verifier**: check tool results (did the calendar event actually get created? does the email draft include the requested points?) or run a clean-context reviewer on high-stakes outputs, with a hard cap of 1–2 iterations.
  - Drop the generic "evaluate and retry everything" loop. It burns tokens without reliable gains.
- The classifier-first front door is the same kind of brittle pre-structuring that harnesses moved away from. Letting the main model pick tools/subagents (with good descriptions) matches the field.

### Gaps
- I found no 2026 ablation from a major lab that quantifies TodoWrite-style planning against an explicit planner agent. The direction of the field is clear from docs, but not quantified.

## 6. Cost and latency controls: depth limits, budgets, concurrency caps, model tiering

### Takeaway
Every harness ships hard structural limits: depth (1–3), concurrency (Codex is configurable, Claude Code defaults to 20), and per-run turn/time caps. It also uses **effort-scaling heuristics in the prompt** (how many agents for how hard a task) and **model tiering** (strong orchestrator, cheaper workers). Tiering has a known ceiling: the quality of the agent that *decides* sets the outcome.

### Cited Findings
- Claude Code: depth limit 3 by default (configurable, 1 disables nesting), concurrency cap 20, `maxTurns` per subagent (returns partial and can be resumed), per-agent `model` and `effort`, and a global `CLAUDE_CODE_SUBAGENT_MODEL` override — [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Codex: `agents.max_concurrent_threads_per_session`, and model/effort per role. "Subagent workflows consume more tokens than comparable single-agent runs" — [Codex docs](https://learn.chatgpt.com/docs/agent-configuration/subagents). A secondary source reports a 6-thread / depth-1 default — [SaveDelete](https://savedelete.com/article/openai-codex-subagents-parallel-ai-coding/)
- OpenClaw: depth-2 leaf (no spawn), per-agent spawn limit, `runTimeoutSeconds`, a cheaper `agents.defaults.subagents.model` — [OpenClaw docs](https://docs.openclaw.ai/tools/subagents)
- Anthropic effort-scaling embedded in the prompt:
  - simple fact-finding: 1 agent and 3–10 tool calls
  - comparisons: 2–4 subagents with 10–15 calls each
  - complex research: more than 10 subagents

  The early failure was spawning 50 subagents for simple queries. The lead model was Opus and the workers Sonnet — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Multi-agent costs about 15x chat tokens — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cognition: a weak primary with a strong advisor underperformed, because "the quality ceiling was set by the primary". Tiering works as "capability routing" when both models are strong — [Cognition 2026](https://cognition.com/blog/multi-agents-working)
- Codex removed per-spawn model/effort selection after the GPT-5.6 rollout (July 2026, community report), which shows tiering knobs can change under you — [OpenAI Community](https://community.openai.com/t/codex-cli-can-no-longer-spawn-subagents-with-specific-models-or-reasoning/1386290)

### Inferences
- Defaults for Mimir:
  - `MAX_DEPTH=2` (interaction → execution agent → leaf worker that cannot spawn), `MAX_CHILDREN_PER_RUN≈5`, global BullMQ concurrency per user ≈ 3–5.
  - Per-run budget (max turns, max tokens/USD via OpenRouter usage accounting, wall-clock timeout). A budget breach yields `status=budget_exceeded` with a partial result, never a silent kill.
  - Put effort-scaling guidance in the main agent's spawn tool description.
- Tiering via OpenRouter:
  - Keep the interaction agent and any agent that *decides or writes* on a strong model.
  - Use cheap/fast models for leaf read workers (fetch-and-summarize, extraction, per-item fan-out) and for the injection-scan/verification step.
  - Don't put a weak model in charge and escalate.
- Track cost per root task (sum over the agent_runs tree) in Postgres, and expose it in Grafana (already in the repo) to catch runaway spawning.

### Gaps
- No public data on per-task cost distributions for consumer personal assistants (Poke etc.).

## 7. Failure modes: runaway spawning, stale context, cross-agent prompt injection, partial failures

### Takeaway
The documented failure modes are:
- **over-spawning and endless search** (Anthropic)
- **conflicting implicit decisions among parallel writers** (Cognition)
- **false assumptions of shared state and missing upward reports** (Cognition 2026)
- **error amplification in independent parallel agents**, measured at 17.2x (Google/MIT)
- **specification, misalignment and verification failures** (MAST's 14 modes)
- **self-replicating prompt injection** that spreads agent-to-agent, faster with shared global history

Mitigations are structural: limits, single writer, runtime-owned status, provenance tagging, and scanning child outputs.

### Cited Findings
- Anthropic early failures: spawning 50 subagents for simple queries and endlessly searching for nonexistent sources. Fixes were prompt-level effort rules and explicit boundaries — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cognition 2025: "conflicting decisions carry bad results". Parallel subagents without shared context make incompatible implicit choices — [Cognition (not re-fetched)](https://cognition.ai/blog/dont-build-multi-agents)
- Cognition 2026: "Agents assume they share state with their children when they don't". Children don't report back by default. Propagating one child's discoveries to siblings is unsolved. Manager over-prescription backfires — [Cognition](https://cognition.com/blog/multi-agents-working)
- Google/MIT: independent agents amplified errors 17.2x, and centralized coordination contained errors best — [arXiv 2512.08296](https://arxiv.org/abs/2512.08296)
- MAST: 14 failure modes across specification, inter-agent misalignment, and task verification — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657v3)
- Prompt Infection (Lee & Tiwari, Oct 2024): self-replicating LLM-to-LLM injection. A compromised agent passes the payload on, ultimately reaching agents that hold privileged tools. The self-replicating version outperformed non-replicating variants. A shared global message history spread infection faster than local messaging. The proposed defense is "LLM Tagging" (marking message origin), combined with other safeguards — [arXiv 2410.07283](https://arxiv.org/html/2410.07283v1); [survey summary arXiv 2505.12567](https://arxiv.org/pdf/2505.12567)
- "Share-Borne AI Virus: Memory-Hopping Attacks Across LLM Agents" (2026): a single seed artifact reached 60–100% of agents in 30-agent simulations through shared memory. This is from a search snippet only, not verified in full — [arXiv 2609.35576](https://arxiv.org/pdf/2609.35576)
- A 2026 paper, "The Show-Up Attack: When Subagents Win Over Their Supervisor", addresses subagent-to-supervisor manipulation. Only the title was seen, content not verified — [arXiv 2610.27574](https://arxiv.org/pdf/2610.27574)
- Claude Code defenses:
  - It scans subagent final reports for instruction-like text before the parent reads them.
  - Tool calls triggered still go through permission checks.
  - "No agent message counts as your approval for a permission prompt."
  - Subagents inherit and cannot exceed parent permissions in some modes.

  [Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- Codex: subagents inherit the parent sandbox/approvals and cannot override them. Actions needing new approval in non-interactive runs fail and surface to the parent instead of proceeding — [Codex docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Partial failure handling: Claude Code returns partial output on `maxTurns` and allows resume. Anthropic resumes from checkpoints and combines retries with letting the model adapt to tool failures. OpenClaw derives announce status from the runtime outcome — [Claude Code docs](https://code.claude.com/docs/en/sub-agents); [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system); [OpenClaw announce](https://docs.openclaw.ai/tools/subagents/announce)
- Stale context: Cognition prefers clean context for reviewers and full fork for advisors. Subagents acting on stale context is a "false shared state" problem — [Cognition 2026](https://cognition.com/blog/multi-agents-working)

### Inferences
Consolidated recommendations for Mimir's new core harness (single-developer, TS/Node, Postgres, BullMQ, OpenRouter):
1. **One user-facing agent, no classifier front door.** The interaction agent is a single tool-using loop. Subagents are tools it chooses: `spawn_agent(brief)`, `check_agent(id)`, `message_agent(id, text)`, `cancel_agent(id)`. Handoffs are not used.
2. **Default to doing it inline.** Spawn only when one of three things holds: (a) the work is long-running and should run in the background (the Poke pattern), (b) it is a read-heavy, independent fan-out (research, N lookups), or (c) context/tool isolation helps (a large integration toolset, or untrusted web content).
3. **Single writer.** Leaf/read workers get read-only tools and return `proposed_actions`. Exactly one agent per root task (the execution agent owning it, or the interaction agent) performs side-effecting writes, with idempotency keys stored in Postgres.
4. **Durable runs on BullMQ.**
   - Each agent run is a Postgres row plus a BullMQ job, with parent_id/root_id/depth.
   - Completion enqueues an announce event to the parent (the runtime sets status).
   - Resume means re-enqueueing with the transcript. Cancel cascades via the tree.
   - Use timeouts, and archive transcripts after N days.
5. **Typed contracts.** Use the `SpawnBrief` and `AgentResult` described in Q4. Results run about 1–2k tokens, artifacts go by reference, and include a `forward_to_user` passthrough.
6. **Context policy per agent type.** Use fresh context plus a curated slice by default. Use a fork for "advisor/second opinion" agents. Use clean context (output only) for verifiers.
7. **Planning through a todo tool, not a planner agent.** Use a Postgres-backed task checklist visible to the user and to resume logic.
8. **Reflection only when grounded.**
   - Verify via tool readback, schema checks, or a clean-context reviewer on high-stakes outputs.
   - Cap at 1–2 rounds, and feed the user's original constraints into the reviewer to prevent scope creep.
9. **Hard limits.**
   - max depth 2, with leaves unable to spawn
   - max children per run about 5
   - per-user concurrency 3–5
   - per-run turn/token/USD/wall-clock budgets, plus a per-root-task cost ceiling
   - effort-scaling rules in the spawn tool description
10. **Model tiering.** Use strong models for the interaction agent and writer/decider agents, and cheap models for leaf read workers and scanners. Do not use a weak model as the decider.
11. **Injection containment.**
    - Tag every message with its origin (user / agent:<id> / tool:<name> / web).
    - Treat child results as data, and scan them for instruction-like text before they reach the parent.
    - Children never inherit more permissions than the parent. Agent messages never count as user approval for sensitive actions.
    - Don't share one global message history across agents: share memory through curated, provenance-tagged stores.
    - This builds on the repo's recent "prompt injection" commit.

### Gaps
- I did not verify the full content of the 2026 papers "Share-Borne AI Virus" and "The Show-Up Attack". Only titles or snippets were seen.
- I found no empirical measurement of how often subagents act on stale context in production assistants.
