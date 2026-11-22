# Open-source personal assistant / always-on agent harnesses: core loop architecture (as of 2026-11-22)

Method note: Primary-source research. I shallow-cloned and read OpenClaw, Hermes Agent, nanobot, NanoClaw, pi (pi-mono), letta-ai/letta and letta-ai/letta-code at HEAD on 2026-11-22. I read Agent Zero, Leon, ElizaOS, Khoj, Open Interpreter and OpenHands through `gh api`. I used web sources only for criticism, security incidents and Letta blog posts. Repo status was checked via `gh api repos/...` on 2026-11-22:

| Repo | Stars | Last push | Status note |
|---|---|---|---|
| openclaw/openclaw | ~395k | 2026-11-22 | TypeScript, very active |
| NousResearch/hermes-agent | ~265k | 2026-11-22 | Python, very active |
| HKUDS/nanobot | ~50k | 2026-11-22 | Python |
| nanocoai/nanoclaw (was qwibitai/nanoclaw) | ~31k | 2026-11-22 | TypeScript |
| earendil-works/pi (was badlogic/pi-mono) | ~123k | 2026-11-22 | TypeScript |
| letta-ai/letta | ~25k | 2026-10-18 | **Now a stub README; code moved to letta-ai/letta-code** |
| openinterpreter/openinterpreter | ~69k | 2026-11-22 | **Now a Rust coding agent; no longer a personal assistant** |
| elizaOS/eliza | ~20k | 2026-11-22 | **Default branch is now `vibestack`, an Eliza v4 spec workspace** |
| agent0ai/agent-zero | ~20k | 2026-11-22 | Python |
| OpenHands/OpenHands | ~94k | 2026-11-22 | Now built on `OpenHands/software-agent-sdk` |
| khoj-ai/khoj | ~38k | 2026-08-02 | Slowing |
| leon-ai/leon | ~18k | 2026-11-22 | `develop` branch, TypeScript |
| davidondrej/superbot | ~412 | 2026-11-15 | Rust, "status: early" |

Repo links: [openclaw](https://github.com/openclaw/openclaw), [hermes-agent](https://github.com/NousResearch/hermes-agent), [nanobot](https://github.com/HKUDS/nanobot), [nanoclaw](https://github.com/nanocoai/nanoclaw), [pi](https://github.com/earendil-works/pi), [letta-code](https://github.com/letta-ai/letta-code).

---

## Q1. What is the core loop (single tool-calling loop vs router/classifier vs graph), and how does the model decide to reply, call tools, stay silent or end the turn?

### Takeaway
Every serious harness in 2026 (OpenClaw, Hermes, nanobot, NanoClaw, pi, Letta Code, Agent Zero, Leon) runs one serialized tool-calling loop per session, with no up-front intent classifier. The loop ends when the model emits an assistant message without tool calls. The "should I reply at all" decision is made inside that loop by the model, using a reserved silent token (`NO_REPLY`, `[SILENT]`) or explicit message routing. Only ElizaOS v1 kept a separate "shouldRespond" LLM pre-pass, and it needed that for multi-party group chat, not for routing intents.

### Cited Findings

**pi (earendil-works/pi, formerly badlogic/pi-mono)**
- pi has the cleanest reference loop. `runLoop` has an inner loop `while (hasMoreToolCalls || pendingMessages.length > 0)` and an outer `while (true)`. Each inner iteration injects pending steering messages, streams one assistant response, executes any `toolCall` content blocks, then re-polls `getSteeringMessages()`. When the agent "would stop", it checks `getFollowUpMessages()` and continues if there are any. Otherwise it returns. — [packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- Exit and continuation conditions:
  - `stopReason === "error" | "aborted"` ends the run immediately.
  - A `"length"` stop fails every tool call in that message ("may carry truncated arguments") instead of executing it.
  - A tool can set `terminate: true`. The batch terminates only if every finalized call says terminate.
  - A host `finishTurn` hook can return `{action: "end"}` or `{action: "continue"}`.
  - `prepareNextTurn` and `prepareRequest` hooks can swap context, model or thinking level between turns, which is used for compaction.
  - Source: [agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- pi deliberately skips sub-agents and plan mode: "Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way." — [packages/coding-agent/README.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

**OpenClaw**
- OpenClaw describes the loop as "the serialized, per-session run that turns a message into actions and a reply: intake, context assembly, model inference, tool execution, streaming, persistence." — [docs/concepts/agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- Run sequence:
  1. The `agent` RPC resolves the session and returns `{runId, acceptedAt}` immediately.
  2. `agentCommand` resolves the model and loads the skills snapshot.
  3. It calls `runEmbeddedAgent`, which reserves the session-controller turn, streams assistant and tool deltas, and enforces timeouts.
  4. Events are bridged to `assistant`, `tool` and `lifecycle` streams.
  5. `agent.wait` returns the terminal outcome.
  - Source: [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- OpenClaw now owns its loop in `packages/agent-core` (`agent-loop.ts`, `agent-loop-steering.ts`, `pending-message-queue.ts`). The docs say "No external agent framework packages remain". Only `@earendil-works/pi-tui` is still a dependency, which suggests OpenClaw's core descended from pi's agent package. That lineage is an inference from the shared names and dependency. — [docs/agent-runtime-architecture.md](https://github.com/openclaw/openclaw/blob/main/docs/agent-runtime-architecture.md), [packages/agent-core/src](https://github.com/openclaw/openclaw/tree/main/packages/agent-core/src)
- Silence protocol: "Only a completed final whose entire text is `NO_REPLY`, ignoring casing and surrounding whitespace, requests silence." A truncated response or unfinished tool turn is not a valid silent ending. `NO_REPLY` "discards anything written this turn that was not sent, so send confirmations before ending silently." A leading `NO_REPLY\n` line is stripped and the rest is delivered. — [docs/concepts/messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md)
- Silent-reply guidance is only injected for external channels: "Direct-message prompts omit silent-reply guidance." — [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md), [docs/concepts/system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- Turns carry an admission-time "reply expectation":
  - Direct, group and channel requests "normally receive answers".
  - Subagents, Control UI chat and private completions are "result-required".
  - "Optional turns owe no result: an empty final ends quietly without recovery or notice."
  - Source: [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md), [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- Robustness details in the loop:
  - If a model prints a tool call as text, the runner requests one native correction. "A repeated text call produces a visible failure instead of silently reporting success."
  - Malformed provider tool calls can continue once from the transcript when no side effects occurred.
  - Source: [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- The system prompt contains behavioural sections:
  - "Execution Bias": act in-turn on actionable requests, continue until done or blocked, verify before finalizing.
  - "Promised Work": "promising future, background, delegated, or continued work creates follow-through ownership: arrange an available completion or watch path before ending the turn ... never treat progress (like `running`) as completion."
  - Source: [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- Plugin hook `before_agent_reply` runs "after inline actions, before the LLM call. Lets a plugin claim the turn and return a synthetic reply or silence it entirely." Other hooks: `before_prompt_build`, which can inject context or narrow `toolsAllow` per turn, and `before_tool_call`, where `{block:true}` is terminal. — [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)

**Hermes Agent**
- `run_agent.py` is now a thin facade. The loop lives in `agent/conversation_loop.py`, with each phase in `agent/turn_*.py`. — [website/docs/developer-guide/agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)
- Turn lifecycle:
  1. Append the user message.
  2. Build or reuse the cached system prompt.
  3. Run preflight compression when context is over 50%.
  4. Build API messages.
  5. Inject ephemeral layers such as budget warnings and context pressure.
  6. Make an interruptible API call.
  7. "If tool_calls: execute them, append results, loop back... If text response: persist session, flush memory if needed, return."
  - Source: [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)
- Iteration budget: default 500 (`agent.max_turns`). Subagents get independent budgets capped at `delegation.max_iterations`, default 50. "At 100%, the agent stops and returns a summary of work done." Source code shows `max_iterations: int = sys.maxsize` as the constructor default. — [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md), [run_agent.py](https://github.com/NousResearch/hermes-agent/blob/main/run_agent.py)
- Multiple tool calls run concurrently in a ThreadPoolExecutor. Interactive tools such as `clarify` force sequential execution, and results are reinserted in the original order. — [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)

**nanobot**
- `nanobot/agent/loop.py` (~2.7k lines) wraps `AgentRunner` (`runner.py`) with a `SessionInbox`, `PendingInputs`, `CronTurnCoordinator`, `SubagentManager` and `TurnDelivery`. It is a single tool loop per session. The tool contract tells the model to "Wait for tool results before writing the final answer." — [nanobot/agent/loop.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/loop.py), [nanobot/templates/agent/tool_contract.md](https://github.com/HKUDS/nanobot/blob/main/nanobot/templates/agent/tool_contract.md)

**Agent Zero**
- `Agent.monologue()` is a nested `while True` loop. Each iteration:
  - calls `handle_intervention()`, which checks for user messages injected mid-run,
  - builds the prompt,
  - streams the response,
  - parses a JSON tool request out of free text, in the form `{"thoughts": [...], "headline": ..., "tool_name": ..., "tool_args": ...}`.
  - Source: [agent.py](https://github.com/agent0ai/agent-zero/blob/main/agent.py)
- The loop only ends when the model calls the `response` tool: "final answer to user / ends task processing use only when done or no task active / put result in text arg". — [agents/agent0/prompts/agent.system.tool.response.md](https://github.com/agent0ai/agent-zero/blob/main/agents/agent0/prompts/agent.system.tool.response.md)

**Leon**
- Leon's agent is a ReAct "LLM duty" (`react-llm-duty.ts`, ~2.7k lines) with a plan widget. It adds an optional low-reasoning-effort **internal reviewer** pass with `REVIEW_SYSTEM_PROMPT`: "You are Leon's internal reviewer. Apply the review instructions to the owner's request, proposed ending, plan and evidence ... Return only the requested verdict." There are separate `COMPLETION_REVIEW` and `CLARIFICATION_REVIEW` efforts, and tools declare `completion_review: Optional` for low-risk lookups. — [server/src/core/llm-manager/llm-duties/react-llm-duty.ts](https://github.com/leon-ai/leon/blob/develop/server/src/core/llm-manager/llm-duties/react-llm-duty.ts)

**ElizaOS (v1 docs)**
- The bootstrap plugin's message service runs pre-evaluation, then response generation, then post-evaluation. `shouldRespond` uses "rule-based and LLM evaluation"; the agent replies unless the LLM's action is IGNORE or NONE. `SHOULD_RESPOND_BYPASS_TYPES` and `SHOULD_RESPOND_BYPASS_SOURCES` skip this check, for example in DMs. Responses are classified as "simple" (REPLY only, no providers) or "complex" (full action processing). Evaluators such as reflection and fact extraction run afterwards. — [docs.elizaos.ai message flow](https://docs.elizaos.ai/plugins/bootstrap/message-flow), [Mintlify message-service](https://www.mintlify.com/elizaos/eliza/api/services/message-service)

**Letta**
- Letta V1 (`letta_v1_agent`, blog dated 2025-10-14) explicitly abandoned the MemGPT router-ish pattern. `send_message` is deprecated, `request_heartbeat` is dropped, and inner-thought args are replaced by native reasoning. The stated reason is that it "significantly improves performance" for newer models and "aligns with patterns models are trained on". — [Letta blog: Letta V1 agent](https://www.letta.com/blog/letta-v1-agent)

### Inferences
- The industry converged on "one loop, model decides, final text without tool calls = done". Classifiers in front of the loop, like Mimir's JSON intent router, are absent from every 2026 harness reviewed. The closest thing is ElizaOS's `shouldRespond`, which is a binary respond/ignore gate for group chats and is bypassed for DMs.
- The "when to respond" problem is solved with three cheap mechanisms instead of routing:
  1. A reserved silent token, valid only as the entire final message.
  2. A per-turn "reply expectation" set by the harness, not the model: required for direct user turns, optional for ambient or background turns.
  3. A system prompt section on follow-through ("Promised Work").
- Leon's reviewer pass and OpenClaw's correction pass suggest a useful pattern: put cheap LLM verification after the model proposes an ending, not before it starts.
- pi's loop (~950 lines, steering and follow-up hooks, `finishTurn`, `prepareNextTurn`) is the most directly portable TS reference for Mimir.

### Gaps
- I did not trace OpenClaw's `packages/agent-core/src/agent-loop.ts` line by line. The lineage claim (OpenClaw core derived from pi agent) is inferred from naming and the remaining pi-tui dependency, not stated in a doc.
- ElizaOS's current `vibestack` branch is a spec workspace for "Eliza v4" in VibeLang/Effect/Java. I could not verify whether `shouldRespond` still exists there. The findings above describe v1 docs.

---

## Q2. Is replying a tool (send_message) or is the final assistant text the reply? How are multiple messages, interim updates and "nothing to say" handled?

### Takeaway
There are two camps. In the first, final text is the reply by default, with an optional message tool for extra or out-of-band sends: OpenClaw, Hermes, nanobot, Letta V1, pi. In the second, nothing is delivered unless explicitly addressed: NanoClaw's `<message to="...">` blocks and `send_message` MCP tool, Agent Zero's `response` tool, and OpenClaw's opt-in `message_tool` visible-reply mode for ambient group chat. Letta, the project that popularized `send_message`, deprecated it in 2025.

### Cited Findings

**OpenClaw**
- Default `messages.groupChat.visibleReplies: "automatic"` means final assistant text posts visibly. The alternative `"message_tool"` mode makes visible output require `message(action=send)`. "The agent listens, decides when a reply is useful, and never needs the old prompt pattern of answering `NO_REPLY`." This is recommended for always-on group chats combined with `unmentionedInbound: "room_event"`. — [docs/channels/ambient-room-events.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/ambient-room-events.md), [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md)
- Delivery is tracked as a fact, not re-parsed: "The terminal producer prepares the reply once and records whether it is visible or silent. Delivery and clients consume that fact." A delivery receipt (`sourceReplyDelivered: true`) prevents duplicate generation. — [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md), [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- Interim updates use a `progress_card` / `tools.updatePlan` tool, on by default. It maintains "one durable plan and status note, keep at most one step `in_progress`, and skip routine updates". — [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- "Pending work without an authored acknowledgment retains its existing waiting status so supported channels can keep the live progress card until the result arrives." — [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md)

**NanoClaw**
- Text is not delivered as-is. The agent-runner parses result text for `<message to="name">...</message>` blocks (`dispatchResultText` in `poll-loop.ts`) and writes one `messages_out` row per block. "If a turn ends with text that was not delivered, the agent-runner pushes a one-time `<system>` nudge into the live turn." This covers text with no valid block, unknown destinations, and unwrapped text after a `send_message`. — [docs/architecture.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md)
- There are also `send_message`, `send_file` and `edit_message` MCP tools with a named-destination model. "NanoClaw does not stream tokens to users"; edits are an explicit tool. — [docs/agent-runner-details.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/agent-runner-details.md), [architecture.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md)

**nanobot**
- nanobot has a `message` tool with `content`, `channel`, `chat_id` and `media`, defaulting to the current chat. Within one run, `capture_message_deliveries()` records successful sends so the turn's final text is not double-delivered. — [nanobot/agent/tools/message.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/tools/message.py), [nanobot/agent/loop.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/loop.py)

**Hermes Agent**
- Final text is the reply ("If text response: persist session... return"). Hermes has `react_to_message_tool.py`; I found no generic send_message tool in `tools/`. Cron uses a `[SILENT]` literal: "If there is genuinely nothing new to report, respond with exactly "[SILENT]" (nothing else) to suppress delivery... Never combine [SILENT] with content." — [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md), [cron/scheduler_prompt.py](https://github.com/NousResearch/hermes-agent/blob/main/cron/scheduler_prompt.py)

**Letta**
- In MemGPT, replies were a `send_message` tool call and `request_heartbeat` "defaulted to False, so agents ended turns unless told otherwise". In V1 "the model writes its replies directly". The stated downside is that "tool rules ... can't apply to assistant messages." — [Letta blog](https://www.letta.com/blog/letta-v1-agent)

**Agent Zero**
- The reply is the `response` tool's `text` arg, and the reply tool also ends the task. — [agent.system.tool.response.md](https://github.com/agent0ai/agent-zero/blob/main/agents/agent0/prompts/agent.system.tool.response.md)

### Inferences
- For Mimir's 1:1 chat UI, the evidence favours "final text = reply" plus an optional `notify` or `message` tool for out-of-band web push and multi-message cases, with send-tracking so final text is not duplicated (nanobot, OpenClaw).
- For background agents watching Gmail, Calendar or GitHub, the NanoClaw or OpenClaw `message_tool` approach is safer. Background output should be internal by default and only explicit sends reach the user. This matches the "ambient events" framing: background events are like unmentioned group messages.
- A silent token must be validated structurally (entire final, completed, non-truncated), as OpenClaw does. Do not use substring matching.
- NanoClaw's "one-time nudge when undelivered text exists" is a cheap safety net worth copying.

### Gaps
- I did not verify whether Hermes's gateway has a proactive send tool for non-cron turns, for example in `gateway/delivery.py`.

---

## Q3. How do they handle proactive behaviour: heartbeats, cron, event triggers, waking the agent, and deciding whether an event deserves a user notification?

### Takeaway
2026's big change: **OpenClaw retired its famous heartbeat/HEARTBEAT.md** and turned monitors into ordinary automation jobs. Each job has its own schedule, prompt, persistent "scratch", session target and delivery policy. Common notification gates across projects:
1. A silent token (`NO_REPLY`, `[SILENT]`).
2. A deterministic pre-check script that decides whether to wake the model at all (NanoClaw's `wakeAgent`).
3. A separate cheap post-run LLM "notification gate" with a structured tool output (nanobot's `evaluate_notification`).

Background turns are explicitly marked "unattended / autonomous" in the prompt.

### Cited Findings

**OpenClaw**
- "Heartbeat monitoring now uses ordinary automation jobs. Doctor converts existing monitors into editable jobs with their own schedules, policies, scratch, and run history." Legacy `agents.defaults.heartbeat` config and `HEARTBEAT.md` are migrated and archived. "The system prompt contains no heartbeat-specific section." — [docs/gateway/heartbeat.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md), [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- Job "scratch" is per-job persistent state included only with that job's scheduled input: "unrelated turns do not receive it". Example job prompt: "Check the monitor scratch. Report only changes that need attention; otherwise reply NO_REPLY." A check returning `NO_REPLY` "does not need an extra final-answer model request." — [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md), [heartbeat.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)
- Unattended contract: "Isolated automation and hook agent turns are explicitly unattended: no one is present to clarify or approve. The final reply must be the deliverable rather than a plan, acknowledgement, or request for input. The agent records `no_change` without a summary and returns `NO_REPLY` when nothing needs doing." — [docs/automation/cron-jobs/payloads.md](https://github.com/openclaw/openclaw/blob/main/docs/automation/cron-jobs/payloads.md)
- Two more points from the same doc:
  - "A completed model run is not proof that the requested task succeeded." Blocker reports are ordinary output subject to the delivery policy.
  - External hook turns (webhooks, email) get only the common contract and no self-removal or override guidance "across the external-content boundary". This is a prompt-injection boundary.
  - Source: [payloads.md](https://github.com/openclaw/openclaw/blob/main/docs/automation/cron-jobs/payloads.md)
- Jobs target "main session vs current vs isolated vs custom" sessions. Messages sent to a `cron:<jobId>` session address its latest run. "Put information that later runs need in the job payload or scratch." — [payloads.md](https://github.com/openclaw/openclaw/blob/main/docs/automation/cron-jobs/payloads.md)
- Gmail triggers come in through Google Pub/Sub and "a restricted reader". Webhooks support `forEach` fan-out over payload arrays, for example one agent turn per email. — [docs/automation/cron-jobs/gmail.md](https://github.com/openclaw/openclaw/blob/main/docs/automation/cron-jobs/gmail.md), [webhooks.md](https://github.com/openclaw/openclaw/blob/main/docs/automation/cron-jobs/webhooks.md)
- OpenClaw also has docs pages on "standing orders", "standing intents" and "MCP events". I did not read them.

**NanoClaw**
- Script gates: "A task can run a Bash script before waking the agent." The last stdout line is JSON:
  - `{ "wakeAgent": false }` "completes the run without calling the model".
  - `{ "wakeAgent": true, "data": {...} }` adds `data` to the prompt.
  - Scripts have a 30 s timeout and 1 MB output cap. Tasks more frequent than a threshold are rejected unless script-gated, "because `wakeAgent: false` uses no model tokens."
  - Source: [docs/scheduled-tasks.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/scheduled-tasks.md)
- "Everything is a message: chat, tasks, webhooks, system actions, agent-to-agent — all use `messages_in` / `messages_out`." The host writes a row, then calls `wakeUpAgent(session)`. — [architecture.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md)

**nanobot**
- nanobot keeps HEARTBEAT.md as a "protected heartbeat cron job" (`gateway.heartbeat.enabled`) for "background checks with flexible timing that should stay quiet unless there is something useful to report". Explicit times use the `cron` tool. "Completed tasks should be deleted." — [nanobot/templates/HEARTBEAT.md](https://github.com/HKUDS/nanobot/blob/main/nanobot/templates/HEARTBEAT.md), [tool_contract.md](https://github.com/HKUDS/nanobot/blob/main/nanobot/templates/agent/tool_contract.md)
- Post-run notification gate:
  - After a heartbeat run, "a lightweight LLM call" with the forced tool `evaluate_notification({should_notify: bool, reason})` decides delivery.
  - The prompt says to notify for "actionable information, errors, completed deliverables, scheduled reminder/timer completions".
  - It says to suppress for "routine status check with nothing new... or essentially empty" and for meta-reasoning about config files or about whether to notify.
  - The prompt can be overridden per workspace.
  - Source: [nanobot/utils/evaluator.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/utils/evaluator.py), [nanobot/templates/agent/evaluator.md](https://github.com/HKUDS/nanobot/blob/main/nanobot/templates/agent/evaluator.md)

**Hermes Agent**
- Cron jobs have `deliver` targets (e.g. `telegram:-100...`), an optional `script`, and skill injection. Delivery goes through a durable queue `cron/deliveries.db`, keyed by `execution_id`, with states `pending → delivering → delivered | failed | suppressed`. Each row is claimed at most once, and the job status distinguishes `ok` / `delivery_queued` / `delivery_failed`. — [website/docs/developer-guide/cron-internals.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/cron-internals.md)

**Letta Code**
- The scheduled-task prompt wraps the job in `<system-reminder>` with "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely bl[ocked]". Runs are tagged `origin:schedule`. — [src/cron/scheduled-task-prompt.ts](https://github.com/letta-ai/letta-code/blob/main/src/cron/scheduled-task-prompt.ts)
- Each run starts a new conversation by default, overridable with `--conversation default|<id>|self`. Agents can schedule tasks themselves. Local schedules live in `~/.letta/crons.json` and only run while a session is active. — [docs.letta.com scheduling](https://docs.letta.com/letta-code/scheduling)
- The Letta Code README advertises "heartbeats and crons", but the scheduling doc page I fetched does not describe heartbeats. In the source, "heartbeat" refers to websocket and scheduler lease liveness. — [README](https://github.com/letta-ai/letta-code/blob/main/README.md)

**Khoj**
- Automations are scheduled queries whose results are emailed via Resend. This is simple and has no notification gate. — [documentation/docs/features/automations.md](https://github.com/khoj-ai/khoj/blob/master/documentation/docs/features/automations.md)

**Cost criticism**
- Community analyses blamed OpenClaw heartbeats for idle token burn. One estimate was "~$86/day" for full-context heartbeats versus >95% less with lightweight checks; another post reported a "heartbeat regression that reloads full conversation history". Both are third-party estimates and unverified. OpenClaw's mitigations were isolated sessions and `lightContext`. — [justinhuangcode cost analysis](https://justinhuangcode.github.io/openclaw-internals/openclaw/deep-dives/heartbeat-cost-analysis), [graphscope.io](https://graphscope.io/blog/tech/2026/03/18/OpenClaw-User-Token-Cost-Analysis.html), [pulse.bot](https://www.pulse.bot/ai/blogs/the-openclaw-bill-shock-no-one-sees-coming-1165bdbc-f862-4769-8b85-e92ae6d83f9f/), [dev.to cheap checks first](https://dev.to/damogallagher/heartbeats-in-openclaw-cheap-checks-first-models-only-when-you-need-them-4bfi)

### Inferences
- OpenClaw's heartbeat retirement is the strongest signal. A single "wake up and look around" heartbeat in the main session was costly and noisy. Per-watcher jobs with their own scratch state and an explicit delivery policy won. This maps cleanly onto Mimir's Gmail, Calendar, GitHub and Notion watchers as BullMQ repeatable jobs, each with a Postgres "scratch" row.
- A recommended layered notification gate for Mimir, from these sources:
  1. A deterministic pre-filter decides whether to wake the model (NanoClaw `wakeAgent`).
  2. The agent run uses an "unattended" contract and may end with a silent token (OpenClaw, Hermes).
  3. Optionally, a cheap structured `should_notify` judge on the output (nanobot).
  4. A durable delivery queue with idempotent claim (Hermes).
- Event-triggered turns should carry a provenance flag (external content) that strips privileged guidance (OpenClaw).

### Gaps
- I did not read OpenClaw's `standing-orders.md`, `standing-intents.md` or `automation/mcp-events.md`. They may describe event-subscription semantics relevant to watchers.
- I found no primary GitHub issue numbers for OpenClaw heartbeat cost bugs; the third-party claims are unverified.

---

## Q4. How are sessions, concurrency (new user message while the agent is working), interrupts and queueing handled?

### Takeaway
All mature harnesses serialize one active run per session and offer the same four policies for mid-run input:
- **steer**: inject into the running loop at the next model call,
- **followup**: queue for a new turn,
- **collect**: debounce and merge queued messages into one turn,
- **interrupt**: abort and restart with the newest message.

OpenClaw defaults to steer with a 500 ms debounce. pi exposes this as two hooks, `getSteeringMessages` and `getFollowUpMessages`.

### Cited Findings

**OpenClaw**
- Queue modes, from [docs/concepts/queue.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md):
  - `steer`: "inject messages into the active runtime, including while it is executing tools... Running tools finish, and parallel batches never skip calls for steering."
  - `followup`: "Enqueue each message for a later agent turn after the current run ends."
  - `collect`: "Coalesce compatible queued messages into a single followup turn after the quiet window."
  - `interrupt`: "abort the active run for that session, then run the newest message."
  - The default is `steer` with "a built-in 500ms debounce", queue `cap` 20, and `drop: summarize`.
- Mode is configurable per session (`/queue collect debounce:0.5s cap:25 drop:summarize`) and debounce per channel (`debounceMsByChannel`). A different requester in group chat "stay[s] queued as separate turns". — [queue.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md)
- Session keys look like `agent:<agentId>:subagent:<uuid>` and `cron:<jobId>`. The loop "reserves the session controller turn before entering global capacity". — [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md), [tools/subagents.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/subagents.md)

**pi**
- Steering is polled before each model call and after each tool batch. Follow-ups are polled only when the agent would otherwise stop. The code even re-polls after long `prepareNextTurn` work such as compaction, "Pick up steering queued while it ran". — [agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)

**Hermes Agent**
- API calls run in a background thread watched by an interrupt event. On interrupt (new message, `/stop`), "The API thread is abandoned (response discarded)... No partial response is injected into conversation history." — [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)
- The gateway has `busy_input_mode` with `interrupt` / `queue` / `steer`. Interrupt is blocked while subagents are active or compression is in flight. A single "next-up" slot per session is "Overwritten on repeat sends (burst collapse)", plus a `/queue` FIFO overflow where each entry gets its own full turn. — [gateway/run_busy.py](https://github.com/NousResearch/hermes-agent/blob/main/gateway/run_busy.py), [website/docs/developer-guide/gateway-session-lifecycle.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-session-lifecycle.md)
- Crash recovery: durable active-turn markers mean an unreplied turn gets `resume_pending=True, resume_reason="restart_interrupted"` and "auto-resumes once". `/stop` sets `suspended`, which forces a fresh session. — [gateway-session-lifecycle.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-session-lifecycle.md)

**NanoClaw**
- While a query runs, the agent-runner polls `messages_in` every ~500 ms and pushes new messages into the active query via `provider.push()`. Claude handles this natively; Codex and OpenCode handle it via abort and restart. Messages that arrive while the container is down accumulate as `pending` and are processed as one batch on wake. — [agent-runner-details.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/agent-runner-details.md), [architecture.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md)

**Letta Code**
- The turn queue merges heterogeneous inputs into one type: `QueuedTurnInput = {kind:"user"} | {kind:"task_notification"} | {kind:"cron_prompt"}`, with `MergeQueuedTurnInputOptions` for coalescing. Subagent completions and cron fires share the user-message queue. — [src/queue/turn-queue-runtime.ts](https://github.com/letta-ai/letta-code/blob/main/src/queue/turn-queue-runtime.ts)

**Agent Zero**
- `handle_intervention()` is called at loop start, before the LLM call, and inside the reasoning and response stream callbacks. User messages can be broadcast down the subordinate chain (`intervention_agent.intervention = msg`). — [agent.py](https://github.com/agent0ai/agent-zero/blob/main/agent.py)

### Inferences
- For Mimir, model the queue as one Redis-backed per-conversation lane holding typed inputs: user message, watcher event, subagent result, reminder fire. A per-conversation lock means only one run at a time.
- Implement steer-by-default: drain the lane before each model call and after each tool batch. Collect the lane when the run would end.
- An explicit "stop" maps to an AbortSignal. Discard partial output, as Hermes does.
- BullMQ group or concurrency keys, or a Postgres advisory lock, can provide OpenClaw's "session controller turn".

### Gaps
- I did not inspect OpenClaw's `src/auto-reply/reply/queue/enqueue.ts` implementation details beyond the docs.

---

## Q5. Subagents: do they spawn them, how (tool call, isolation), and how are results passed back?

### Takeaway
Subagents are a tool call (`sessions_spawn`, `delegate_task`, `call_subordinate`) that creates an isolated child session with its own context, a reduced tool set and a smaller prompt. The result comes back asynchronously as an "announce" message into the parent's queue, which the parent reviews before telling the user. pi deliberately has none.

### Cited Findings

**OpenClaw**
- "Sub-agents are background agent runs spawned from an existing agent run. Each one runs in its own session (`agent:<agentId>:subagent:<uuid>`) and, by default, announces its result back to the requester for review." — [docs/tools/subagents.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/subagents.md)
- Isolation and context rules:
  - Sub-agents "do not get session or message tools by default".
  - Nesting depth is configurable.
  - A cheaper model can be set via `agents.defaults.subagents.model`.
  - `context: "fork"` gives the child the requester's transcript.
  - "Sub-agent sessions only inject `AGENTS.md`" from the bootstrap files.
  - Source: [subagents.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/subagents.md), [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- Announce chain: "A descendant finishes and announces to its direct parent... The main agent receives the final announce and delivers to the user. Each level only sees announces from its direct children." Defaults are `runTimeoutSeconds: 900` and `announceTimeoutMs: 120000`. Orchestrators get `sessions_spawn`, `subagents`, `sessions_list` and `sessions_history`. A conversation reset cascades cancellation. — [docs/tools/subagents/nesting.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/subagents/nesting.md)
- "Private subagent completions record the parent's reviewed outcome internally." — [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md)

**Hermes Agent**
- `delegate_task` "Spawns subagent(s) with isolated context". It is handled as an agent-level tool that returns synthetic results. — [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md)
- With `skip_context_files` (subagent delegation), SOUL.md is not loaded and `DEFAULT_AGENT_IDENTITY` is used instead. — [prompt-assembly.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/prompt-assembly.md)
- The tools directory has async delegation (`async_delegation.py`, `delegate_tool_resumable.py`, `delegate_tool_continue.py`). — [tools/](https://github.com/NousResearch/hermes-agent/tree/main/tools)

**Others**
- nanobot has `SubagentManager` and `tools/subagent.py`, with `subagent_sessions.py` and `subagent_status.py`. — [nanobot/agent/](https://github.com/HKUDS/nanobot/tree/main/nanobot/agent)
- Letta Code has built-in subagents (general-purpose, forked, recall) that run "in the background", and agents can call any other agent, including themselves. Completions re-enter via the `task_notification` queue kind. — [letta-code README](https://github.com/letta-ai/letta-code/blob/main/README.md), [turn-queue-runtime.ts](https://github.com/letta-ai/letta-code/blob/main/src/queue/turn-queue-runtime.ts)
- Agent Zero uses `call_subordinate`. Superior and subordinate chains share interventions. — [agent.py](https://github.com/agent0ai/agent-zero/blob/main/agent.py)
- NanoClaw uses agent-to-agent messaging over the same `messages_in` / `messages_out` tables, with a container per agent. — [architecture.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md)
- SuperBot uses "Bot to Bot: Bots ask each other for help and pass work along". — [superbot README](https://github.com/davidondrej/superbot)

### Inferences
- Mimir's `spawn_agent` branch should become a `spawn_agent` tool the main loop calls. The child runs as a BullMQ job in its own session row. On completion it enqueues a `subagent_result` input into the parent conversation lane, and the parent decides what to tell the user, possibly nothing.
- Deny message/notify tools to children by default so that only the parent speaks.

### Gaps
- I did not inspect `sessions_yield` / `subagent-yield-handoff.md` in OpenClaw.

---

## Q6. Memory and system prompt assembly: what is in context each turn?

### Takeaway
Workspace markdown files (identity/SOUL, AGENTS/instructions, USER profile, curated MEMORY) are injected into a cache-stable system prompt with size caps. Bulky memory (daily notes, past sessions) stays out of the prompt and is reached on demand via search tools. Volatile per-turn facts (time, runtime, budget warnings) go in a separate runtime-context message to keep the cached prefix stable. Background memory consolidation ("dreaming", sleep-time, reflection) runs off the hot path.

### Cited Findings

**OpenClaw**
- Bootstrap files `AGENTS.md`, `SOUL.md`, `USER.md` and `MEMORY.md` are injected from the agent workspace. Caps are `bootstrapMaxChars` 20000 per file and `bootstrapTotalMaxChars` 60000 in total, with a built-in truncation notice. "`memory/*.md` daily files are not part of the normal bootstrap... accessed on demand via `memory_search` / `memory_get`." `MEMORY.md` "should stay a curated long-term summary". — [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- "OpenClaw attaches a separate, typed runtime-context message for the current request", containing date, time zone and similar. Common guidance sits "above the cache boundary". — [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md)
- The hook `agent:bootstrap` can swap bootstrap files, for example to change persona. Docs also cover `dreaming.md`, `active-memory.md`, `memory-honcho.md`, `compaction.md` and `session-pruning.md`. — [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md), [docs/concepts/](https://github.com/openclaw/openclaw/tree/main/docs/concepts)

**Hermes Agent**
- There are three cached tiers in `agent/system_prompt.py`:
  1. **stable**: identity from SOUL.md, plus tool and model guidance.
  2. **context**: caller system_message, project files (`.hermes.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`), and a git snapshot.
  3. **volatile**: skills index, "Frozen MEMORY snapshot", "Frozen USER profile snapshot", external memory-provider block such as Honcho, and the timestamp/session/model line.
  - Changes go through "the per-turn user-message channel... so the cached prefix survives".
  - Source: [website/docs/developer-guide/prompt-assembly.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/prompt-assembly.md)
- Hermes's "closed learning loop": "Agent-curated memory with periodic nudges. Autonomous skill creation after complex tasks. Skills self-improve during use. FTS5 session search with LLM summarization for cross-session recall." Tools include `memory_tool.py` and `skill_manager_tool.py`. — [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md)

**nanobot**
- Templates are `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md` and `memory/`. The agent package has `memory.py` (`Consolidator`), `dream.py` and `autocompact.py`. — [nanobot/templates](https://github.com/HKUDS/nanobot/tree/main/nanobot/templates), [nanobot/agent](https://github.com/HKUDS/nanobot/tree/main/nanobot/agent)

**Letta Code**
- Memory blocks are tracked via git (MemFS), and agents "rewrite their own memory, skills". Auto-reflection has `ReflectionTrigger = "off" | "step-count" | "compaction-event"`; this is the successor to sleep-time agents. Manual `/dream` and `/reflect` are also available. — [src/reflection-settings.ts](https://github.com/letta-ai/letta-code/blob/main/src/reflection-settings.ts), [README](https://github.com/letta-ai/letta-code/blob/main/README.md)

**NanoClaw**
- An agent group has its own folder with `CLAUDE.md` and skills, and each session gets its own DB pair. A PreCompact hook archives transcripts. — [architecture.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md), [agent-runner-details.md](https://github.com/nanocoai/nanoclaw/blob/main/docs/agent-runner-details.md)

### Inferences
- For Mimir, assemble the context in this order:
  1. Stable system prompt: identity, behaviour rules, and tool and skill index.
  2. Frozen user-profile and memory snapshot from Postgres, refreshed only between sessions or on change.
  3. Recent conversation.
  4. A per-turn runtime-context message: time, timezone, active watchers and jobs, pending subagents, and the trigger source of this turn.
- Retrieval over email, notes and history should go through tools, not pre-stuffed context.
- Memory consolidation should run as a BullMQ job after N turns or on compaction (Letta's step-count and compaction triggers).

### Gaps
- Exact Letta Code system-prompt composition was not traced in source.

---

## Q7. Tools and skills: how are they defined, loaded and permissioned?

### Takeaway
Tools are typed schemas (TypeBox or JSON Schema) registered in code. "Skills" are the 2026 standard: directories with a `SKILL.md` (YAML frontmatter plus instructions), surfaced in the prompt as an index and loaded on demand. Permissions are layered: per-agent tool allowlists, per-turn tool narrowing via hooks, exec approvals and sandboxing, and dangerous-command approval callbacks.

### Cited Findings

**OpenClaw**
- "Each skill lives in a directory containing a `SKILL.md` file with YAML" frontmatter. Skills are discovered up to 6 levels deep, gated by `metadata.openclaw.requires`, restricted by per-agent allowlists, stored as immutable revisions, and installable from ClawHub. — [docs/tools/skills.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md)
- The prompt's Skills section "tells the model how to load skill instructions on demand". "Tool Search" mode exposes deferred tools via `dispatch_action`. — [system-prompt.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md), [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- Permission layers include `before_tool_call` blocking hooks, exec approvals, an elevated mode, sandboxing and `toolsAllow` narrowing per turn. — [agent-loop.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md), [docs/gateway/sandbox-vs-tool-policy-vs-elevated.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandbox-vs-tool-policy-vs-elevated.md)

**Hermes Agent**
- Tool execution resolves a handler from `tools/registry.py`, fires the `pre_tool_call` hook, then checks "if dangerous command (tools/approval.py) — If dangerous: invoke approval_callback, wait for user". `tools/` contains ~30 `approval_*.py` files. Toolsets are defined in `toolsets.py`. — [agent-loop.md](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md), [tools/](https://github.com/NousResearch/hermes-agent/tree/main/tools)

**Others**
- NanoClaw relies on container isolation as the permission model: "Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks." It also has a credential gateway. — [NanoClaw README](https://github.com/nanocoai/nanoclaw/blob/main/README.md)
- Letta Code loads global, project (`.agents/skills`) and agent-scoped skills, and has permission modes with auto-approve and auto-deny rules. — [letta-code README](https://github.com/letta-ai/letta-code/blob/main/README.md)

### Inferences
- For Mimir:
  - Define tools as TS objects with a Zod or TypeBox schema, a handler, `risk` (read / write / external-send), and `requiresApproval`.
  - Expose a skills index rather than all tool schemas when the count grows.
  - Gate external-send and destructive tools behind approval when the turn is unattended or was triggered by external content.

### Gaps
- None critical.

---

## Q8. Known weaknesses and criticisms

### Takeaway
OpenClaw's main problems are security (a malicious skill marketplace, prompt injection, weak untrusted-content filtering), cost (heartbeat token burn) and complexity (NanoClaw's author cites "nearly half a million lines of code, 53 config files"). Hermes is similarly sprawling: its repo shows hundreds of micro-modules, which is my observation. Several "minimal clones" exist explicitly as reactions to that complexity.

### Cited Findings
- **ClawHub malware.**
  - Koi Security's audit found 341 malicious skills out of ~2,857, most linked to the "ClawHavoc" campaign delivering infostealers such as Atomic macOS Stealer.
  - ClawHub integrated VirusTotal scanning with daily re-scans; maintainers said scanning is "not a silver bullet".
  - Accounts must be ≥1 week old to publish.
  - Source: [The Hacker News: 341 malicious ClawHub skills](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html), [The Hacker News: VirusTotal integration](https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html), [Snyk](https://www.snyk.io/blog/clawhub-malicious-google-skill-openclaw-malware)
- **Unit 42 follow-up.** Five skills stayed unblocked from Feb to May 2026 using "semantic instruction hijacking". Researchers flagged OpenClaw's failure to filter untrusted content with control sequences and weak indirect-prompt-injection guardrails. — [Unit 42](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/), [Dark Reading](https://www.darkreading.com/cyber-risk/malicious-openclaw-skills-clawhub-threaten-ai-supply-chain)
- **Academic paper.** "ClawdPwned: Malicious Instructions in the OpenClaw AI Agent Skills repository" (ICLR 2026). — [ICLR](https://iclr.cc/virtual/2026/10016269)
- **CVE count (unverified).** One alternatives guide claims "543 CVEs name OpenClaw as affected". I treat this as unverified vendor-listicle content. — [Composio OpenClaw alternatives](https://composio.dev/blog/openclaw-alternatives)
- **Complexity.** NanoClaw's author: "I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files..." — [NanoClaw README](https://github.com/nanocoai/nanoclaw/blob/main/README.md)
- **Heartbeat cost.** See Q3. — [graphscope.io](https://graphscope.io/blog/tech/2026/03/18/OpenClaw-User-Token-Cost-Analysis.html), [notebookcheck](https://www.notebookcheck.net/Free-to-use-AI-tool-can-burn-through-hundreds-of-Dollars-per-day-OpenClaw-has-absurdly-high-token-use.1219925.0.html)
- **Letta V1 trade-offs.** Letta's own post lists "No prompted reasoning, no heartbeats, and more limited tool rules (they can't apply to assistant messages)". — [Letta blog](https://www.letta.com/blog/letta-v1-agent)
- **Landscape.** Hermes Agent launched in Feb 2026 and is commonly framed as the main OpenClaw alternative, with a learning loop, skills, sub-agents and cron. nanobot (HKU, Feb 2026), NanoClaw, ZeroClaw (single Rust binary, approvals on by default) and PicoClaw are the minimal clones. These are mostly vendor listicles. — [Composio OpenClaw vs Hermes](https://composio.dev/blog/openclaw-vs-hermes-agent), [parallel.ai comparison](https://parallel.ai/articles/openclaw-vs-nousresearch-hermes), [The New Stack](https://thenewstack.io/persistent-ai-agents-compared/?p=22818937)

### Status changes to flag (outdated assumptions)
- **Letta.** `letta-ai/letta` is now a stub README: "The current source code lives in letta-ai/letta-code". The V1 Python server is on the `archive` branch. Sleep-time agents appear to be succeeded by client-side "reflection/dreaming" triggers; this is an inference from `reflection-settings.ts` and the README. — [letta README](https://github.com/letta-ai/letta/blob/main/README.md)
- **Open Interpreter.** The repo is now "A coding agent optimized for low-cost models", a Rust reimplementation of Kimi Code. It is not relevant as a personal-assistant harness. (01 was not checked.) — [openinterpreter README](https://github.com/openinterpreter/openinterpreter)
- **ElizaOS.** The default branch is `vibestack`, "Eliza v4 on Vibestack" spec workspace. v1 bootstrap docs may be outdated relative to it. — [eliza README](https://github.com/elizaOS/eliza)
- **OpenClaw heartbeat.** Retired in favour of automation jobs. Blog posts about `HEARTBEAT.md` / `HEARTBEAT_OK` are outdated, and "The legacy `HEARTBEAT_OK` marker does not request silence". — [heartbeat.md](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md), [messages.md](https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md)
- **pi.** Moved to `earendil-works/pi`.
- **NanoClaw.** Moved to `nanocoai/nanoclaw`, now v2. Agents run on Claude Code, Codex, Cursor or OpenCode harnesses inside containers. — [NanoClaw README](https://github.com/nanocoai/nanoclaw/blob/main/README.md)
- **OpenHands.** The personal-assistant-relevant parts now live in `OpenHands/software-agent-sdk` (Agent Server, conversations, events). An "automation service decides when work runs and dispatches conversations to the Agent Server". — [OpenHands README](https://github.com/OpenHands/OpenHands)
- **SuperBot.** Rust, "status: early". It is a team of named Bots, each with memory files, self-created cron "Routines", Bot-to-Bot delegation, and an adapter over Claude Code, Codex or Pi. Approvals are "(soon)". — [superbot README](https://github.com/davidondrej/superbot)

### What to copy vs avoid (synthesis for Mimir)

**Copy**
1. A single per-conversation tool loop, modelled on pi's `agent-loop.ts`, with steering and follow-up hooks and a `finishTurn` decision hook. Delete the front-loaded intent classifier: cancel, list, spawn and clarify become tools (`cancel_task`, `list_tasks`, `spawn_agent`, `ask_user`).
2. A harness-set reply expectation per turn: required for user turns, optional for watcher and ambient turns. Add a structurally validated silent token, plus an optional `notify`/`message` tool with send-tracking (OpenClaw, nanobot).
3. Per-watcher automation jobs with scratch state, an unattended contract prompt, a pre-wake script or deterministic gate, an optional `should_notify` judge, and a durable delivery queue (OpenClaw, NanoClaw, nanobot, Hermes).
4. A typed unified input lane (user, event, subagent result, reminder) with steer, collect and interrupt policies (OpenClaw, Letta Code).
5. Subagents as tools with isolated sessions and an announce-to-parent mechanism. Children cannot message the user (OpenClaw).
6. A cache-stable system prompt with frozen memory snapshots and a separate runtime-context message (Hermes, OpenClaw).
7. A "Promised Work" follow-through rule and a post-hoc completion reviewer (OpenClaw, Leon).

**Avoid**
1. A global heartbeat that wakes the main session with full context (OpenClaw retired it; cost complaints).
2. An unvetted third-party skill marketplace or auto-installed skills (ClawHub incidents).
3. Letting externally triggered turns carry privileged instructions or self-modification ability. Mark provenance.
4. Substring-matched silent tokens. Deliver-everything for background agents.
5. Sprawling config surfaces. OpenClaw and Hermes have hundreds of micro-modules; NanoClaw and nanobot exist as reactions to this.
