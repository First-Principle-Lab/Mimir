# How Commercial Personal AI Assistants / Agent Products Are Architected (as of Nov 2026)

Tagging convention used throughout:
- **[OFFICIAL]** = vendor docs, vendor engineering blog, or on-record founder statement
- **[RE]** = reverse-engineered: leaked system prompts, source-code analysis, third-party teardown, or reimplementation
- **[SPEC]** = speculation / inference by a third party or by me
- **[PRIOR]** = from researcher's prior knowledge of a well-known source; URL given but page was NOT re-fetched in this session (verify before quoting)

Research date: 2026-11-22. Dates of sources are given inline.

---

## Q1. Per-product architecture breakdown (agent loop, interaction/execution split, subagents, memory, triggers, approvals)

### Takeaway
The dominant production pattern for personal assistants is **one user-facing "interaction" agent with tools** (including a "do nothing"/`wait` tool and a "delegate to worker" tool) sitting on top of **persistent, parallel execution agents**, with triggers/events delivered *into the interaction agent's conversation as tagged messages* rather than routed by a classifier. Coding harnesses (Claude Code, Codex) are a plain single while-loop ("call model, run tools, repeat until no tool calls") with isolated-context subagents that return only summaries. Approvals are increasingly implemented as a separate model-based reviewer plus allow/ask rules plus "drafts wait for Send."

### Cited Findings

#### Poke (The Interaction Company of California; acquired by Cognition, July 2026)
- Status: Cognition (maker of Devin) acquired The Interaction Company; announced ~July 23-24, 2026, reportedly low nine figures; Poke continues to run; founders join Cognition; planned use of Cognition's SWE-1.7 model "for some tasks" next year [OFFICIAL via press] — [TechCrunch, 2026-07-24](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/); [Dealroom](https://dealroom.co/news/140804-devin-maker-cognition-acquires-poke-the-ai-agent-native-to-apple-message/)
- Scale: "hundreds of thousands" of users; >100M messages in prior three months; first AI agent approved on Apple Messages for Business (June 2026); channels iMessage, SMS, Telegram, WhatsApp in some markets; co-founder Marvin von Hagen admitted it has been "expensive to run" [OFFICIAL via press] — [TechCrunch, 2026-07-24](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/)
- Date conflict: TechCrunch says Poke "launched in March 2026", while the leaked prompt references a launch on September 8, 2025 (likely beta/public launch vs. later GA; unresolved) — [TechCrunch](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/) vs [systemprompts.org mirror](https://www.systemprompts.org/poke-system-prompt/)
- Two-layer architecture: the user-facing agent ("Poke") texts the user; the execution agent ("Poke agent") describes itself as the "execution engine" and its final output is forwarded to Poke, not to the user, and "should contain no preamble" [RE, leaked prompt] — [systemprompts.org mirror of Poke prompt](https://www.systemprompts.org/poke-system-prompt/)
- Inbound messages to the interaction agent are **tagged by source**: user, agent results, triggered automations, incoming email, developer notes, periodic reminders; **only user messages are treated as direct instructions** [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- Tools named in the leaked prompt: `send_message_to_agent` (spawn or message agents; "DEFAULT BEHAVIOR: When calling send_message_to_agent, do NOT send any message to the user"), `display_draft` (show drafts for confirmation), `wait` (silently ignore unhelpful updates / cancel bad triggers), `react_to_message`, `query_media` ("NEVER announce query_media tool usage"), `task` (subagents for search, Notion, Linear, browser), `compose_draft`/`execute_draft`/`send_email`/`compose_calendar_draft`, `create_trigger` (+edit/delete), `query_interesting_recent_user_data`. No `remember` tool: memory is automatic [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- Plain assistant text (non-tool output) goes straight to the user, and is "split by newlines into many messages"; formatted blocks are kept together; "you can react or output an empty string to say nothing when natural" [RE, 2025-09-15 leak] — [EliFuzz/awesome-system-prompts](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md)
- Triggers: "An automation is an email-based trigger, and a reminder is a cron-based trigger." Notify/remind requests default to Poke texting the user [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- Automation messages cannot cause actions without human approval: "Do not take actions on these without prior approval from human messages!"; "Never mention the technical term 'trigger'"; for non-trivial automations "ask if they want to be notified every time it happens" [RE, 2025-09-15] — [EliFuzz](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md)
- Approvals: "ALWAYS confirm this draft with the user before sending it to an agent"; "Make sure you get user confirmation before sending, forwarding, or replying to emails"; yes/no confirmations accept text or positive/negative emoji reactions; if an execution agent asks for confirmation of an already-approved action, Poke tells the agent to proceed without messaging the user [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/); [EliFuzz](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md)
- Multiple leak generations exist: pre-Apple-Messages era, Sept 2025, and a June 2026 leak (posted 2026-06-08) with **separate prompts for the main agent and an email-processing sub-agent**; one commenter suggested the June 2026 text may be "distilled" [RE] — [note.com/veltrea, 2026-08-22](https://note.com/veltrea/n/n9e4c7a3476cd?hl=en); search summary of [x.com/ziwenxu_](https://x.com/ziwenxu_/status/2063892254100509007?lang=en)
- A leak reportedly references ~$50/user/month actual cost [RE, unverified secondary] — search-result summary pointing to [mana.am](https://mana.am/en/blog/poke-sms-ai-agent/) / [HoangYell](https://hoangyell.com/system-prompts-ai-tools-leaked-explained/)
- OpenPoke reconstruction (Shlok Desai, 2025-09-22): Interaction Agent is the only user-facing component; Execution Agents each have own system prompt, history, toolset; run in parallel and **persist after finishing** so follow-ups resume the same agent with full context; Interaction Agent checks a roster of existing agents and routes to a matching one or spawns a new one [RE + reimplementation] — [shloked.com/writing/openpoke](https://www.shloked.com/writing/openpoke); [Composio OpenPoke](https://composio.dev/content/open-poke)
- OpenPoke memory: conversation summarized at a threshold (100 msgs) with temporal anchors, older summaries cascaded/compressed; per-agent full action logs; inbox used as external long-term memory [reimplementation, not confirmed for Poke] — [shloked.com](https://www.shloked.com/writing/openpoke)
- OpenPoke triggers: SQL table, scheduler checks every minute; **each trigger belongs to the agent that created it**, and when it fires that agent reactivates and routes output to the Interaction Agent [reimplementation] — [shloked.com](https://www.shloked.com/writing/openpoke)

#### Grok Bot (xAI; runs on Cursor's cloud, tied to Cursor/X plans)
- Launched beta 2026-08-11 for SuperGrok Heavy, Cursor Ultra, Cursor Teams Premium; expanded 2026-08-21; 1.0 out of beta November 2026 [third-party, citing docs/changelog] — [flaviocopes.com, updated 2026-11-19](https://flaviocopes.com/grok-bot/)
- "An agent with access to a real computer in the cloud" (browser, filesystem, terminal); connectors + "any MCP or API"; chat primary, voice calls/notes secondary [OFFICIAL] — [docs.x.ai/grok-bot/overview](https://docs.x.ai/grok-bot/overview)
- **Multiple named Bots** each with own conversation, memory, role, skills, routines; all share **one** persistent cloud computer (not separate security boundaries); up to 50 Bots+groups [third-party summarizing docs] — [flaviocopes](https://flaviocopes.com/grok-bot/); shared computer confirmed [OFFICIAL] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- **Primary Bot** = front door: asking it "what's new" returns updates "for every Bot working for you"; it handles everyday requests, checks in when blocked, and routes to specialist Bots [OFFICIAL overview + third-party] — [docs.x.ai overview](https://docs.x.ai/grok-bot/overview); [flaviocopes](https://flaviocopes.com/grok-bot/)
- Routines: "Ask a Bot to repeat a task, and it becomes a routine that runs on the schedule you set"; skills are saved steps from a walkthrough [OFFICIAL] — [docs.x.ai overview](https://docs.x.ai/grok-bot/overview). Routines fire on schedule or events (Slack message, GitHub event, email arrival, @bot on X); every run costs usage even when nothing found; limits 50 routines/Bot, 300 runs/hour; warning that 15-min schedule = 96 runs/day [third-party] — [flaviocopes](https://flaviocopes.com/grok-bot/)
- Notification bar: "Overheard" template "sends a short weekday digest when something clears the bar" and "never posts on your behalf" [OFFICIAL] — [docs.x.ai overview](https://docs.x.ai/grok-bot/overview)
- **Auto Review**: model-based check of each action (commands, connected apps, computer use) before it runs; "model-based and should complement, not replace, least privilege and explicit approval boundaries"; up to 20 "Allow automatically" + 20 "Ask first" rules (≤1,000 chars each, natural language), "Ask first" wins; built-in safety checks always apply; doesn't check every side effect (e.g., memory writes) [OFFICIAL] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy). Cursor team docs call it "an independent review model" [OFFICIAL-adjacent] — [cursor.com/docs/grok-bot/teams](https://cursor.com/docs/grok-bot/teams)
- Approval cards: Allow once / Always allow (saves rule) / Deny; **chat-originated cards don't expire; cards from routines/background work expire after 30 minutes**; email from routines, incoming messages, or unrequested work "waits as a draft until you press Send"; approval "does not reverse work already completed" [OFFICIAL] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Vault: logins/Secure Form values filled "without being shown to the model"; saved card fills at checkout "without a separate approval each time"; docs and changelog reportedly disagree on per-purchase approval [OFFICIAL + third-party] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy); [flaviocopes](https://flaviocopes.com/grok-bot/)
- Multi-Bot handoffs: groups of 2-6 Bots; recommended explicit handoffs naming output paths, evidence, open items, next owner; unrestricted group chats "noisy" and wasteful [third-party] — [flaviocopes](https://flaviocopes.com/grok-bot/)

#### Claude Code / Claude Agent SDK / Routines / Cowork / Memory (Anthropic)
- Core loop is a single while-loop: call model, run requested tools, repeat; `queryLoop()` async generator in `query.ts`; all interfaces (CLI, headless, Agent SDK, IDE) converge on it; read-only tools run concurrently, state-changing serially [RE, source analysis of v2.1.88] — [arXiv 2604.14228, "Dive into Claude Code", 2026-04-14](https://arxiv.org/html/2604.14228v1)
- Subagents (Agent/Task tool) re-enter the loop with an **isolated context**; **only a summary returns to the parent**; transcripts stored in sidechain files; "bubble" permission mode escalates subagent permission prompts to parent [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- 27 hook event types (PreToolUse, PostToolUse, PermissionRequest etc.); PreToolUse can deny/ask/modify input [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- Five context shapers before each model call, cheapest first: budget reduction of large tool outputs → snip → microcompact → context collapse → auto-compact (model summary as last resort) [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- Permissions: deny > ask > allow; modes include plan, default, acceptEdits, auto (ML classifier), dontAsk, bypassPermissions; cites Anthropic data that users approve ~93% of prompts → rationale for not relying on prompts alone (approval fatigue) [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- Routines (research preview, 2026-04-14): saved Claude Code sessions on Anthropic cloud, started by schedule, HTTP API call, or GitHub event; Cowork scheduled tasks run only while the computer is on [OFFICIAL + secondary] — [claude.com: Introducing routines](https://claude.com/resources/articles/introducing-routines-in-claude-code); [code.claude.com scheduled tasks docs](https://code.claude.com/docs/en/web-scheduled-tasks.md)
- Anthropic multi-agent Research system: orchestrator-worker; lead agent (Opus 4) spawns parallel subagents (Sonnet 4) +CitationAgent; beat single-agent Opus 4 by 90.2% on internal eval; multi-agent uses ~15× chat tokens; vague delegation caused duplicated work → each subagent needs objective, output format, tool guidance, boundaries; poor fit when agents need shared context or have many dependencies [OFFICIAL, June 2025] — [anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Claude memory (consumer app): project-scoped memories, user-viewable/editable memory summary, incognito chats that neither read nor write memory; imports processed in a once-daily batch [OFFICIAL, 2025] — [claude.com/blog/memory](https://claude.com/blog/memory); [Engadget](https://www.engadget.com/claude-can-now-compartmentalize-as-part-of-a-major-memory-upgrade-170000194.html)
- "Building effective agents": distinguishes workflows (predefined code paths, incl. a "routing" workflow that classifies input and sends to specialized handlers) from agents (LLM dynamically directs its own process/tool use); advises starting simple and adding complexity only when it demonstrably helps [PRIOR, Dec 2024] — [anthropic.com/research/building-effective-agents](https://www.anthropic.com/research/building-effective-agents)

#### OpenAI (ChatGPT agent, Pulse, Tasks, Codex)
- ChatGPT agent (July 2025) merged Operator (browser actions) and Deep Research into one agent on its own virtual computer (text browser, visual browser, terminal, APIs); asks permission before consequential actions; user can interrupt/take over/stop [OFFICIAL] — [openai.com/index/introducing-chatgpt-agent](https://openai.com/index/introducing-chatgpt-agent/). Page now carries a notice that it's outdated [OFFICIAL] — same URL
- Pulse (Sept 2025): asynchronous research "once a day" from past chats, memory, feedback; done overnight, delivered as morning cards; "Curate" feedback; Gmail/Calendar opt-in for background reading; required memory enabled [OFFICIAL] — [Introducing ChatGPT Pulse](https://openai.com/index/introducing-chatgpt-pulse/); [help.openai.com Pulse](https://help.openai.com/en/articles/12293630)
- **Pulse is being retired**; help center says proactive updates are moving into **Scheduled Tasks** [OFFICIAL, current help page] — [help.openai.com/en/articles/12293630](https://help.openai.com/en/articles/12293630)
- Codex harness ("Unrolling the Codex agent loop", Michael Bolin, 2026-01-23): loop "repeats until the model stops emitting tool calls and instead produces a message for the user"; "each turn always ends with an assistant message"; prompt = server system msg + sandbox developer msg + developer_instructions + AGENTS.md aggregation (more specific later, 32 KiB cap) + skills metadata + env context + user msg; **append-only to preserve prefix cache** (config changes appended as new messages, not edited); stateless requests resend full history (ZDR); auto compaction via `/responses/compact` returning encrypted `compaction` item [OFFICIAL] — [openai.com/index/unrolling-the-codex-agent-loop](https://openai.com/index/unrolling-the-codex-agent-loop)
- "Harness engineering" (Ryan Lopopolo, 2026-02-11): engineer's job shifts to designing environments, specifying intent, and building feedback loops for agents [OFFICIAL] — [openai.com/index/harness-engineering](https://www.openai.com/index/harness-engineering)
- Agents SDK: two multi-agent primitives — handoffs (transfer control of the conversation to another agent) and agents-as-tools (manager keeps control, calls subagents as tools); plus guardrails [PRIOR] — [openai.github.io/openai-agents-python](https://openai.github.io/openai-agents-python/)

#### Google (Gemini Spark, Proactive Assistance)
- Gemini Spark (I/O, 2026-05-19): 24/7 personal agent on Gemini 3.5 Flash and the Antigravity harness, running on dedicated Google Cloud VMs; tasks can be emailed to a dedicated Gmail address; uses Chrome; progress via Android "Halo"; MCP for third-party services; Google says it's "designed to check with you before taking major actions," but Decrypt reports launch disclaimer says it can share info or make purchases without asking; US AI Ultra beta [OFFICIAL via press] — [TechCrunch, 2026-05-19](https://techcrunch.com/2026/05/19/google-introduces-gemini-spark-a-24-7-agentic-assistant-with-gmail-integration/); [The Next Web](https://thenextweb.com/news/google-gemini-spark-agentic-assistant-gmail-io-2026); [Decrypt](https://decrypt.co/368389/); [Tom's Guide](https://www.tomsguide.com/ai/google-gemini/google-unveils-gemini-spark-a-24-7-personal-ai-agent-that-could-be-a-game-changer-for-agentic-ai)
- Gemini "Proactive Assistance" (teardown April 2026): inputs = on-screen content, notifications, user-selected apps (Gmail, Calendar, Contacts, Messages); processed "entirely in a private, encrypted space on your device" [RE, app teardown] — [9to5Google, 2026-04-27](https://9to5google.com/2026/04/27/gemini-proactive-assistance/); [Android Authority](https://www.androidauthority.com/google-gemini-proactive-assistance-3661314/)

#### Manus (now part of Meta)
- Context-engineering post (Yichao "Peak" Ji, 2025-07-18): KV-cache hit rate is the most important production metric; ~100:1 input:output token ratio; stable prompt prefix, append-only context, deterministic serialization; **mask tools via a state machine instead of removing them mid-task**; agent rewrites a `todo.md` each step to keep goals in recent attention; file system as unlimited external memory; keep errors/failed actions in context so model learns [OFFICIAL] — [manus.im blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). Manus site banner says Manus "is now part of Meta" [OFFICIAL] — [manus.im](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

#### Lindy
- Began as no-code trigger/condition/action agent builder; relaunched Feb 2026 as consumer AI executive assistant over iMessage/SMS; builder still powers enterprise [secondary] — [usecarly.com](https://www.usecarly.com/blog/what-is-lindy-ai/); [Zapier](https://zapier.com/blog/what-is-lindy/)
- iMessage engineering: originally a Swift daemon on a data-center Mac Mini tailing Messages' `chat.db-wal`; account permanently banned by Apple; later moved to Linq [OFFICIAL] — [lindy.ai/engineering/imessage-api](https://www.lindy.ai/engineering/imessage-api)
- **Inbound debouncing**: waits 3 seconds after each inbound message, resets on any new message, then bundles the burst into one request; native typing indicator shown while agent works [vendor case study] — [Linq: how Lindy shipped into iMessage](https://skywalker-next.linqapp.com/blog/how-lindy-shipped-an-ai-assistant-into-imessage)
- Replies saved as drafts for approval [secondary] — [usecarly.com](https://www.usecarly.com/blog/what-is-lindy-ai/)

#### Dot (New Computer)
- Shut down: announced early Sept 2025, stopped working 2025-10-05; founders cited diverging visions; coverage also linked it to companion-app safety scrutiny [OFFICIAL via press] — [TechCrunch, 2025-09-05](https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down)

### Inferences
- [SPEC] Poke's design is the closest public analogue to Mimir. Its key idea is that "what to say and when" is decided by **one LLM turn over a unified, source-tagged inbox** (user msgs, agent results, trigger fires, emails), with silence as an explicit tool (`wait`) and the reply as the default plain-text output. That replaces the routing classifier with tool choice.
- [SPEC] Grok Bot's two-tier design (Primary Bot front door, specialist Bots behind it) is the same interaction/execution split, but exposed to users as named entities instead of hidden.
- [SPEC] Across Poke, Grok Bot, Lindy, and Gemini Spark, the approval primitive is the same: **side-effecting output from unattended runs becomes a draft that the user approves**. Grok adds a separate model-based reviewer and natural-language allow/ask rules.

### Gaps
- No official Interaction Company engineering blog describing internals was found; all Poke internals are from leaks/reimplementations.
- Grok Bot docs page on "what a Bot remembers" and Vault page were not directly read; model(s) behind Grok Bot and Auto Review are undocumented.
- Not researched in this pass (time budget): Martin, Friday, Limitless/Rewind (status unverified; I believe Limitless was acquired by Meta in late 2025 but did not verify), Apple Intelligence/Siri agent, Google Jules, Project Mariner, Astra, OpenAI Agents SDK current docs, Claude Cowork architecture details.

---

## Q2. Front classifier/router vs. single model with tools — what changed and why?

### Takeaway
None of the strong products found use a front JSON intent classifier with hard-coded branches for the user-facing turn. The interaction agent is a single model call with tools (delegate, wait/silence, draft, react, trigger CRUD), and "routing" means the model picks which existing agent to message. Classifiers show up in narrow places: email importance pre-filtering (OpenPoke), permission/action review (Grok Auto Review, Claude Code auto mode). The industry trend is merging separate tools into one agent (Operator + Deep Research → ChatGPT agent; Pulse → Scheduled Tasks).

### Cited Findings
- Poke's interaction agent picks its action through tools (`send_message_to_agent`, `wait`, `display_draft`, `react_to_message`, `create_trigger`); plain text output = reply to user [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- OpenPoke: interaction agent checks the roster of existing agents and routes to a matching one or spawns a new one (the routing is an LLM tool decision, not a classifier) [RE] — [shloked.com](https://www.shloked.com/writing/openpoke)
- Claude Code: a single loop, and every interface converges on one `queryLoop()` [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1). Codex: one loop until the model emits a message instead of tool calls [OFFICIAL] — [OpenAI Codex loop](https://openai.com/index/unrolling-the-codex-agent-loop)
- OpenAI merged Operator and Deep Research into a single agent because each worked best in different situations and users had to pick [OFFICIAL] — [Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/)
- Pulse (a separate proactive product) is being retired, and its job folded into Scheduled Tasks [OFFICIAL] — [help.openai.com](https://help.openai.com/en/articles/12293630)
- Anthropic presents "routing" as a workflow pattern for well-defined categories and recommends agents (the LLM directing its own tool use) for open-ended problems [PRIOR] — [Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- Anthropic's research system scales effort through prompting (1 agent with 3-10 tool calls for simple queries, more than 10 subagents for complex ones), with the lead model deciding, not a classifier [OFFICIAL] — [Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)
- Classifier-like components that remain: OpenPoke's email monitor runs an LLM classifier for urgency, required action, OTPs, and sender importance before anything reaches the interaction agent [reimplementation] — [shloked.com](https://www.shloked.com/writing/openpoke). Claude Code's "auto" permission mode uses an ML classifier [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1). Grok's Auto Review is a separate reviewer model [OFFICIAL] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)

### Inferences
- [SPEC] For Mimir, the six intents (answer_directly, spawn_agent, one_shot, manage_cancel, manage_list, ask_clarification) map cleanly onto tools on a single interaction agent: reply as plain text, `send_message_to_agent` (new or existing), `wait`, `list_agents`/`cancel_agent`, and clarifying through a normal reply. Keyword hard rules become prompt guidance plus few-shot examples.
- [SPEC] Keep classifiers where the decision is high-volume and cheap: event triage before the interaction agent, and action safety review. Don't put one in front of the conversational turn.

### Gaps
- No vendor post was found that explicitly says "we removed our intent classifier and here's why." The trend is inferred from architectures and product consolidation.

---

## Q3. How do they decide whether an incoming event is worth interrupting the user? Batching, digests, thresholds?

### Takeaway
Two layers. First, a cheap pre-filter or importance threshold on raw events. Second, the interaction agent decides with silence as an explicit, first-class tool (`wait`). Unattended work produces drafts instead of actions. Digests on a schedule (morning brief, weekday digest "when something clears the bar") are the main batching mechanism. Pulse's once-a-day overnight design was later folded into scheduled tasks.

### Cited Findings
- Poke: "If you get an update from the agent that is not worth telling the user about, use the wait tool"; bad or misfired triggers are cancelled silently ("DO NOT execute it and DO NOT tell the user about it") [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- Poke: for non-trivial automations, ask up front whether the user wants a notification every time [RE] — [EliFuzz 2025-09-15](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md)
- One analysis argues Poke's human-like feel comes mostly from knowing when to stay silent. The same paying user worries it will hold back information he wanted, such as missed invoices [RE + opinion] — [note.com/veltrea, 2026-08-22](https://note.com/veltrea/n/n9e4c7a3476cd?hl=en)
- OpenPoke: email polled every minute; LLM classifier scores urgency, required actions, OTP codes, and sender importance; only mail above a threshold goes to the interaction agent, which "mentions them naturally"; processed IDs are tracked for dedup [reimplementation] — [shloked.com](https://www.shloked.com/writing/openpoke)
- Grok Bot "Overheard": short weekday digest "when something clears the bar"; templates for daily briefings and Monday plans [OFFICIAL] — [docs.x.ai overview](https://docs.x.ai/grok-bot/overview). Approval cards from background work expire after 30 min [OFFICIAL] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Grok Bot: every routine run consumes usage even when nothing is found; warning that frequent schedules multiply cost [third-party] — [flaviocopes](https://flaviocopes.com/grok-bot/)
- ChatGPT Pulse: one daily asynchronous research batch, overnight, delivered in the morning; tuned with user "Curate" feedback [OFFICIAL] — [Introducing ChatGPT Pulse](https://openai.com/index/introducing-chatgpt-pulse/)
- Gemini Proactive Assistance: I/O 2025 demo of noticing a calendar test and pushing a practice quiz; reporting suggests leave-now reminders based on traffic [RE/press] — [Digital Trends](https://www.digitaltrends.com/computing/gemini-wants-to-read-your-emails-calendar-and-notifications-to-help-you-before-you-even-ask/); [9to5Google](https://9to5google.com/2026/04/27/gemini-proactive-assistance/)

### Inferences
- [SPEC] Recommended pattern for Mimir: event → cheap triage (rules plus a small model scoring urgency and importance with dedup) → only above-threshold events enter the interaction agent's inbox as tagged messages → the interaction agent may still `wait`. Below-threshold items accumulate into a scheduled digest.
- [SPEC] Asking at trigger-creation time "notify every time, or only when X?" is a cheap, explicit way to set the threshold per user.

### Gaps
- No product publishes numeric thresholds, rate limits on outbound messages, or quiet-hours logic. Not found.

---

## Q4. How do they handle the user sending a message while background work is running?

### Takeaway
In personal assistants with an interaction/execution split, the interaction agent stays free to respond while execution agents work, and new messages go into the same agent conversation (the latest message is treated as the current request). In coding harnesses, mid-turn messages are queued and injected at the next tool-call boundary ("steering"), with a separate hard interrupt. For inbound bursts, debounce and bundle.

### Cited Findings
- Poke: the latest message "is the most recent one, and representative of the user's current requests"; history may have gaps; agents should run in parallel where possible. No explicit rule for mid-run messages was found [RE] — [EliFuzz](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md); [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- OpenPoke: execution agents are asynchronous and persistent. A follow-up is routed to the same existing agent with its context, so a mid-run correction becomes `send_message_to_agent` to the running agent [RE] — [shloked.com](https://www.shloked.com/writing/openpoke)
- Lindy: 3-second debounce after each inbound message, reset on new messages, burst bundled into one request; typing indicator while working [vendor case study] — [Linq/Lindy](https://skywalker-next.linqapp.com/blog/how-lindy-shipped-an-ai-assistant-into-imessage)
- Claude Code CLI: messages typed during work are queued and injected between tool calls; Esc/Ctrl+C interrupts. Users report docs/behavior mismatches and ask for real-time steering; the desktop app offers Send, Interrupt (Ctrl+Enter), and fork [user-reported] — [claudeissues #36326](https://claudeissues.com/issue/36326-bug-docs-say-enter-interrupts-mid-task-but-it-only-queues-the-message); [claudeissues #71726](https://claudeissues.com/issue/71726-feature-desktop-app-inject-queued-messages-mid-task-between-tool-calls-cli-steer); [claudeissues #92988](https://claudeissues.com/issue/92988-desktop-code-tab-has-no-way-to-queue-a-message-until-the-turn-fully-ends-ctrl-en)
- Codex post: a new user message is appended at the start of the next turn; mid-turn handling isn't described [OFFICIAL] — [OpenAI Codex loop](https://openai.com/index/unrolling-the-codex-agent-loop). GitHub Copilot SDK documents explicit "steering and queueing" modes — [docs.github.com](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/steering-and-queueing)
- ChatGPT agent: user can interrupt, take over the browser, or stop a task [OFFICIAL] — [Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/)

### Inferences
- [SPEC] For Mimir: never block the interaction agent on execution. Treat each inbound message (user or event) as a new interaction turn that sees the roster of running agents and their statuses, and give it tools to message, redirect, or cancel a running agent. Debounce user bursts for about 2-3 seconds.

### Gaps
- No official Poke or Grok description of concurrency control (e.g., what happens if two events and a user message arrive simultaneously, or whether turns are serialized per user). Not found.

---

## Q5. How do they keep personality/voice consistent when multiple agents produce output?

### Takeaway
Poke's answer, and the clearest public one: only the interaction agent ever speaks to the user. Worker output goes to the interaction agent, which rewrites it in its own voice, and workers are told to return terse, preamble-free reports. The only exception is drafts, which are shown verbatim. Grok Bot takes the opposite approach and exposes multiple named Bots, accepting multiple voices.

### Cited Findings
- Execution agent's final message is forwarded to Poke and "should contain no preamble" [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- "The user will only see your responses"; "Maintain the illusion that you are a single, unified entity"; "Maintain your consistent personality regardless of how users refer to you" [RE] — [EliFuzz 2025-09-15](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md)
- Refer to agent work as actions "you are taking"; never tell the user about the agents. When explaining errors, describe only what the user saw [RE] — search summary of leaks; [note.com/veltrea](https://note.com/veltrea/n/n9e4c7a3476cd?hl=en)
- Style rules: "be witty and warm, though never overdo it"; no emojis unless the user uses them first; match the user's length and casing; don't say "accessing memory" [RE] — [systemprompts.org](https://www.systemprompts.org/poke-system-prompt/)
- Drafts are inserted verbatim through a draft tool, bypassing interaction-agent styling [RE] — [shloked.com](https://www.shloked.com/writing/openpoke)
- Cognition bought Poke explicitly for its personality and interaction design ("proactive, it knows you, and it's fun to talk to," Scott Wu) [OFFICIAL via press] — [TechCrunch](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/)
- Grok Bot: each Bot has its own role and conversation; the Primary Bot aggregates "what's new" across Bots [OFFICIAL] — [docs.x.ai overview](https://docs.x.ai/grok-bot/overview)

### Inferences
- [SPEC] For Mimir: workers should return structured or terse factual reports (e.g., `{status, result, needs_user_input, draft_ids}`), never user-facing prose. The interaction agent owns all phrasing. Persona lives only in the interaction agent's prompt, which also stays small and cacheable.

### Gaps
- None of the sources says whether Poke uses a separate "rewrite" model call or just the interaction agent's normal turn. The latter is implied.

---

## Q6. What model tiers do they use for which steps?

### Takeaway
Mostly undisclosed for consumer assistants. The public data points: Anthropic uses a strong lead with cheaper workers (Opus lead, Sonnet subagents); Google's always-on Spark runs on a Flash-class model; Poke reportedly uses a smaller model for trigger creation and will add Cognition's SWE-1.7; Claude Code and Codex use fallback models and dedicated compaction.

### Cited Findings
- Anthropic research system: Claude Opus 4 lead with Claude Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on the internal eval [OFFICIAL] — [Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)
- Gemini Spark runs on Gemini 3.5 Flash with the Antigravity harness [OFFICIAL via press] — [TechCrunch](https://techcrunch.com/2026/05/19/google-introduces-gemini-spark-a-24-7-agentic-assistant-with-gmail-integration/); [Decrypt](https://decrypt.co/368389/)
- Poke: the leaked prompt suggests a smaller model is used for trigger creation; actual model mix unconfirmed. OpenPoke uses Claude Sonnet 4 for all calls [RE] — [shloked.com](https://www.shloked.com/writing/openpoke). Cognition plans to use SWE-1.7 for some Poke tasks in 2027 [OFFICIAL via press] — [TechCrunch](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/)
- Claude Code: has a fallback model and output-limit escalation on retry; no tiering data in the paper [RE] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- Codex: bundled prompt for `gpt-5.2-codex`; compaction is done by a dedicated endpoint [OFFICIAL] — [OpenAI Codex loop](https://openai.com/index/unrolling-the-codex-agent-loop)
- Cost pressure: Poke "expensive to run" [OFFICIAL via press] — [TechCrunch](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/); multi-agent ≈15× chat tokens [OFFICIAL] — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system); KV-cache hit rate is the #1 metric at Manus [OFFICIAL] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

### Inferences
- [SPEC] Plausible split for Mimir: a small or fast model for event triage and trigger parsing; a mid-tier model with a strong persona for the interaction agent, which needs low latency; a strong model for execution agents doing multi-step tool work. Keep the interaction prompt prefix stable for caching.

### Gaps
- Models behind Grok Bot, Auto Review, Poke's interaction agent, ChatGPT Tasks, and Lindy were not disclosed in any source found.

---

## Q7. What failure modes have users publicly reported?

### Takeaway
The recurring complaints are timezone and date errors in reminders, confidently wrong facts, silence that hides things the user wanted, cost blowups from frequent routines, noisy multi-agent group chats, stale memory, fragile browser automation, and approval gaps (Vault card payments without per-purchase approval). Over-notification shows up mostly as a design warning rather than as user complaints in the sources found.

### Cited Findings
- Poke reminders: one was sent an hour off because of time zones, and some were "a bit off" while traveling. One user argued with Poke about the day of the week until it admitted the error, and stopped using it. Another said it was "never proactive" [user reports] — [Product Hunt Poke reviews](https://www.producthunt.com/products/poke-by-interaction-co); [Gabe Perez review](https://www.producthunt.com/p/general/a-week-with-poke-review-a-promising-start-for-a-proactive-ai-assistant)
- Concern that silence-by-design hides important items (invoices, payment reminders) [opinion] — [note.com/veltrea](https://note.com/veltrea/n/n9e4c7a3476cd?hl=en)
- Poke's leaked prompt was exfiltrated by asking Poke to email it to the user (prompt-injection/exfiltration vector) [RE] — search-result summary of leak writeups; [HoangYell](https://hoangyell.com/system-prompts-ai-tools-leaked-explained/)
- Grok Bot: usage drains fast and a vague first task can exhaust a trial; browser automation is fragile and sites block datacenter IPs; group chats don't show approval or secret requests; stale memory causes problems; unrestricted group chats get noisy; only `/workspace` is durable [third-party] — [flaviocopes](https://flaviocopes.com/grok-bot/); see also [velvetshark: Grok Bot after 67 real jobs](https://velvetshark.com/grok-bot-after-67-real-jobs) (not read)
- Grok Vault: a saved card fills at checkout without per-payment approval [OFFICIAL] — [docs.x.ai approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy). Gemini Spark's disclaimer reportedly says it may share info or purchase without asking [press] — [Decrypt](https://decrypt.co/368389/)
- Approval fatigue: users approve about 93% of Claude Code permission prompts [RE citing Anthropic data] — [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)
- Claude Code steering: messages typed during long tool sequences reportedly never reach the model or only arrive at the next boundary [user-reported] — [claudeissues #61274](https://claudeissues.com/issue/61274-steering-ignored-messages-typed-during-long-agent-tool-call-sequence-never-reach)
- Lindy's iMessage account was permanently banned by Apple with no published limits and no appeal (channel risk) [OFFICIAL] — [lindy.ai engineering](https://www.lindy.ai/engineering/imessage-api)
- Dot shut down, with the companion-app category under safety scrutiny [press] — [TechCrunch](https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down)

### Inferences
- [SPEC] Mimir should inject the current local time and timezone into every interaction turn and trigger evaluation, since that's the most frequently reported concrete bug. It should also give users a visible "what did you skip?" or digest so `wait` silence is auditable.

### Gaps
- No systematic data (surveys, incident counts) on over-notification or hallucinated actions for any product. Reddit and App Store reviews weren't searched in this pass.
