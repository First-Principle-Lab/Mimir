# Response-Decision Patterns for an AI Personal Assistant (when/whether to respond, act, notify, or stay silent) — as of Nov 2026

Scope note: researched for Mimir (TypeScript; chat UI + background agents on email/calendar/GitHub; triggers; web push). Current harness = front-loaded JSON intent classifier (6 fixed actions) + 11+ keyword hard rules + separate "surface or not" filter for background results. Source-quality legend used below: **[primary]** = official docs / paper read directly; **[leaked]** = unofficial copy of a production system prompt (not verifiable against vendor); **[snippet]** = only search-result snippet seen, full text not read.

## 1. Router/classifier-first vs. "the model decides via tools" (send_message, wait/no_reply, heartbeat)

### Takeaway
Every production personal-assistant design I could verify (Poke, OpenClaw, MemGPT/Letta) puts the respond/act/stay-silent decision inside the main model's turn, expressed through tools or sentinel tokens (`wait`, `NO_REPLY`, `send_message` + `request_heartbeat`). None puts a separate intent classifier in front of it. Where a small classifier exists (Poke's trigger matcher), the main agent is explicitly allowed to veto it. I found no controlled benchmark comparing routers with tool-deciding agents on multi-intent messages; the evidence is design convergence plus practitioner reports.

### Cited Findings
- **MemGPT/Letta legacy design:** every action was a tool call, including user-visible replies via a special `send_message` tool. `request_heartbeat` defaulted to false, so "agents terminate by default rather than continue by default as in ReAct." — [Letta v1 agent blog](https://www.letta.com/blog/letta-v1-agent/) [primary]
- **Letta heartbeat mechanics:** every tool gets an extra `request_heartbeat` param (default false). When it is true, the server finishes the tool and restarts the loop with a system message acknowledging the request. A failed tool call also triggers an automatic heartbeat. — [Letta docs: Heartbeats (legacy)](https://docs.letta.com/guides/agents/heartbeats) [primary, via search summary]
- **Letta deprecated heartbeats and `send_message` in `letta_v1_agent`.** The stated reason is that modern models are trained for multi-step tool use and "self-directed termination", so they should stay "in-distribution". Tradeoff they name: "Tool rules cannot be applied to `AssistantMessage`, as it is no longer a tool call." Reply-as-tool allowed tool rules that constrain calling patterns but required models with reliable tool calling. — [Letta v1 agent blog](https://www.letta.com/blog/letta-v1-agent/) [primary]
- **OpenClaw offers both delivery modes.** `messages.groupChat.visibleReplies: "automatic"` (default) posts the final assistant text. `"message_tool"` requires visible answers to go through `message(action=send)`, and OpenClaw falls back to automatic delivery if the tool is unavailable "instead of staying silent." — [OpenClaw docs: Groups](https://docs.openclaw.ai/channels/groups) [primary]
- **OpenClaw silence is an explicit token.** A token-only `NO_REPLY` ends a turn silently in either mode. `NO_REPLY` "discards any text written that turn that was not sent, so confirmations should be sent before ending silently." Empty or reasoning-only output is *not* treated as silence and goes through recovery. The legacy `HEARTBEAT_OK` marker no longer requests silence. — [OpenClaw docs: Groups](https://docs.openclaw.ai/channels/groups) [primary]
- **Poke (interaction agent) decides with tools, not a classifier.** "Your core function is to interpret each incoming message, determine the necessary actions, and either respond or delegate to another agent." Plain output is sent to the user and "split by newlines into many messages." Tools are `sendmessageto_agent`, `wait`, `display_draft`, `reacttomessage` and a no-split tag. — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt) [leaked]
- **Poke: a small model triggers and the main model vetoes.** "The decision to activate a trigger is done by a very small model that sometimes makes mistakes. If you are told to execute a trigger … that doesn't make sense … DO NOT execute it and DO NOT tell the user about it. VERY IMPORTANT: … always use the `wait` tool to silently cancel the trigger execution." — [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- **Poke can end a turn silently.** "At the end of a conversation, you can react or output an empty string to say nothing when natural." It also uses "timestamps to judge when the conversation ended, and don't continue a conversation from long ago." — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt) [leaked]
- **ChronosBench (proactive follow-ups) models silence as an explicit action.** The agent emits a structured `proactive_action` field (e.g. `SET_REMINDER`, `INFO_RETRIEVAL`, `KEEP_SILENT`, `COMPLETE_TASK`) plus `response_text`. Silence is scored: when the environment update does not meet the user's need, the agent must emit `KEEP_SILENT` with status `IN_PROGRESS`, and "keep[ing] silent too early" is a failure. Qwen3-8B's errors concentrated on "keeping silent in the positive branch or failing to keep silent at the appropriate time." Gemini-3-Flash reached 98.15% task completion on simple cases. — [Shi et al., arXiv 2601.09382](https://arxiv.org/abs/2601.09382) [primary]
- **Practitioner reports on router failures** [snippet; anecdotal]:
  - Multi-domain queries ("payroll deductions and HSA contributions") strain a single classifier.
  - A misroute "misleads subsequent agents, causing cascading failures."
  - Accuracy drops as tool/intent descriptions crowd together.
  - Sources: [HackerNoon: fragility of intent-based routing](https://hackernoon.com/the-fragility-of-intent-based-ai-routing-at-scale); [tianpan.co: intent classification layer](https://tianpan.co/blog/2026-04-16-intent-classification-agent-routers)
- **Keyword routing vs. LLM classifier** [snippet; anecdotal]: one developer reports keyword routing at about 60% accuracy on real conversations, fixed by an LLM classifier with a confidence threshold. — [dev.to: why I stopped routing by keyword](https://dev.to/nullfeather/why-i-stopped-routing-ai-agents-by-keyword-and-what-i-built-instead-2c5k)
- **Tool-count heuristic** [snippet; rule of thumb, not measured]: function calling "handles ambiguous queries, multi-step intents, and novel combinations without a predefined taxonomy." One post claims about 94% accuracy choosing among 50 tools and suggests plain function calling for fewer than 15 tools, adding a pre-dispatch classifier only as tool count grows. — [tianpan.co](https://tianpan.co/blog/2026-04-16-intent-classification-agent-routers)
- A 2026 arXiv paper exists titled "Training-Free versus Training-Based Intent Classification in LLMs: Accuracy, Robustness, and Failure Modes". I did not read it. — [arXiv 2608.02415](https://arxiv.org/pdf/2608.02415) [snippet: title only]

### Inferences
- Mimir's six-way JSON classifier forces a single label per message. That is structurally why "combined requests lose a half": "what's on my calendar tomorrow and remind me to call mom at 5" needs `answer_directly` and `spawn_agent` at once. In the tool-calling pattern the model calls `spawn_agent(...)`, then answers in the same turn. No label is needed, and both halves survive.
- **Pattern A, "decision = tool call".** Replace the classifier with one interaction-agent turn whose toolset is the action space:
  - `reply(text)` or plain final text
  - `delegate(task)` / `spawn_agent`
  - `schedule(trigger)`
  - `ask(question, options?)` (choice cards)
  - `react(emoji)`
  - `no_reply()` / `wait()`

  Any combination is legal in one turn. "Manage cancel/list" become ordinary tools (`list_tasks`, `cancel_task`) rather than intents.
- **Pattern B, "explicit silence sentinel".** Silence must be an explicit, typed outcome (`no_reply` tool or exact token). Empty output is an error to recover from, not silence; this is OpenClaw's rule. Whether "silence" discards unsent draft text is a decision worth making explicitly.
- **Pattern C, "cheap pre-filter, expensive veto".** If a cheap classifier is kept (e.g. for trigger matching on incoming email), let it only *wake* the interaction agent and never *speak*. The interaction agent can always `wait` to cancel, as in Poke.
- **Tradeoff: reply-as-tool vs. native text.** Reply-as-tool lets the harness enforce rules ("must call `reply` or `no_reply` exactly once", "can't reply before tool X returns") and makes silence first-class. The cost is that it is slightly out-of-distribution for modern models. Native final text is more natural, and OpenClaw's hybrid is a reasonable middle: automatic text by default, an explicit `NO_REPLY` token, and an optional `message_tool` mode for background/ambient contexts.
- Replace the keyword hard rules ("remind me" → spawn; hedged phrasing → don't) with few-shot examples and tool descriptions inside the interaction agent's prompt, plus a regression eval suite (section 7). Rules in prompts conflict less when they describe *outcomes* than when they map *surface keywords* to actions.

### Gaps
- No controlled, published comparison of classifier-first routing vs. tool-deciding agents on multi-intent or hedged inputs; the evidence above is design convergence and blog anecdotes.
- Did not find Anthropic or OpenAI engineering posts specifically on "no reply" tools for assistants (not searched exhaustively given the budget).
- Letta v1's exact stop condition is not documented in the post I read.

## 2. Interaction-agent / execution-agent split: who decides what to surface

### Takeaway
In Poke's leaked prompts, workers never talk to the user. They return context-rich reports (with IDs) to a single user-facing interaction agent, which owns the voice and decides, per update, to tell the user, ask for confirmation, show a draft, or call `wait` and say nothing. The default when delegating is *not* to message the user.

### Cited Findings
- **Workers are mute.** "The agent cannot communicate with the user, and you should always communicate with the user yourself." Delegate in parallel: "split it into as much concurrent calls to `sendmessageto_agent` as possible", and tell agents "what, rather than how." — [Poke_p2.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p2.txt) [leaked]
- **Delegating is silent by default.** "DEFAULT BEHAVIOR: When calling `sendmessageto_agent`, do NOT send any message to the user." The exceptions are:
  - the user needs to confirm sending or forwarding an email they have not already confirmed;
  - a draft exists that the user hasn't seen;
  - "the agent provides information that requires user confirmation or input."

  [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- **Filter worker updates.** "If you get an update from the agent that is not worth telling the user about, use the `wait` tool and don't say anything." Also: "If you get sent information about an automation or email notification that has been triggered by mistake, don't inform the user. Just use the `wait` tool." — [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- **Don't re-confirm.** "Sometimes the agent will ask for confirmation for things that the user has already confirmed … don't send anything to the user, and just confirm to the agent to continue." — [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- **Agent reuse.** "Always prefer to send messages to a relevant existing agent rather than starting a new one UNLESS the tasks can be accomplished in parallel." — [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- **Unified persona.** The interaction agent must "maintain the illusion that you are a single, unified entity" and never reveal agents, tools or the word "trigger". — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt); [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- **Execution-agent contract:**
  - "Your final output is directed to Poke … Focus on providing Poke with adequate contextual information; you are not responsible for framing responses in a user-friendly way."
  - "If it needs more data from Poke or the user, you should also include it in your final output."
  - Always return `emailId`, `draftId`, `attachmentId`, `triggerId`.
  - Workers can also cancel erroneous triggers: "Sometimes a notification trigger will happen when it shouldn't … use the `wait` tool to cancel execution."
  - Source: [Poke agent.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke%20agent.txt) [leaked]
- **Notify preference at trigger creation.** When setting up a non-notification trigger, "you should ask if they want to be notified every time it happens. Pass this information along to the tool using agent." — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt) [leaked]
- **Side-effect gating via drafts.** Always confirm before sending, forwarding or replying to email, and before creating, updating or deleting calendar events. Use `display_draft` and show all fields, even unchanged ones. Positive emoji reactions count as "yes", negative ones as "no". — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt); [Poke_p2.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p2.txt); [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt) [leaked]
- An open-source Poke-style reimplementation ("OpenPoke") defines interaction-agent tools including `send_message_to_agent`, `send_draft` and a `wait` handler. — [HF Space: openpokespace interaction_agent/tools.py](https://huggingface.co/spaces/Guilherme34/guilherme34-openpokespace/blob/main/server/agents/interaction_agent/tools.py) [snippet; community code]

### Inferences
- **Pattern D, "single voice, mute workers".** Mimir's background agents (email, calendar and GitHub watchers, spawned tasks) should never push to the user directly. Each emits a structured result event (`{taskId, kind, summary, importance_hint, requires_user_input, ids, dedupe_key}`) into the interaction agent's inbox. The interaction agent runs a turn and chooses `reply` / `ask` / `show_draft` / `wait`. This merges Mimir's current separate "surface filter" into the same agent that has the conversation context, so it knows what the user already knows, what was already said, and what they asked to be told about.
- Store the user's notify preference at trigger-creation time ("tell me every time" vs. "only if X" vs. "only in digest"). The interaction agent then has an explicit contract to check instead of guessing importance from scratch.
- **Failure modes:**
  - The interaction agent over-reports (LLMs bias toward speaking; section 3 and section 7 data).
  - It loses worker detail when summarizing; return IDs so follow-ups go back to the same worker.
  - Workers re-ask confirmations the user already gave; Poke handles this explicitly.

### Gaps
- Poke's material is leaked and may be outdated or incomplete. There is no official Interaction Co. engineering write-up of how "worth telling" is decided beyond the prompt rule; I found none.
- No quantitative data on surface/no-surface accuracy for such splits.

## 3. Proactive notifications: interruptibility, timing, batching, importance, quiet hours, dedupe, "nothing to report = silent"

### Takeaway
The classic decision-theoretic framing (Horvitz 1999) still underlies the right design. Estimate p(user wants this), compare it against two thresholds (no-action/ask and ask/act) whose values move with the cost of interruption, and defer delivery to a lower-attention moment when possible. Field studies show deferring notifications to natural breakpoints reduces disruption and speeds response. Modern LLM proactive benchmarks show models *over-trigger*, so precision calibration and explicit silence are essential.

### Cited Findings
- **Horvitz's 12 principles for mixed-initiative UIs** — [Horvitz, CHI'99](https://www.erichorvitz.com/chi99horvitz.pdf) [primary]:
  1. Significant value-added automation.
  2. Consider uncertainty about the user's goals.
  3. Consider the status of the user's attention in the timing of services: "consider the costs and benefits of deferring action to a time when action will be less distracting."
  4. Infer ideal action in light of costs, benefits and uncertainties.
  5. Use dialog to resolve key uncertainties, "considering the costs of potentially bothering a user needlessly."
  6. Efficient direct invocation and termination.
  7. Minimize the cost of poor guesses about action and timing, "including appropriate timing out and natural gestures for rejecting attempts at service."
  8. Scope precision of service to match uncertainty: "A preference for 'doing less' but doing it correctly under uncertainty."
  9. Efficient agent–user collaboration to refine results.
  10. Socially appropriate behaviors.
  11. Working memory of recent interactions.
  12. Continue to learn by observing.
- **Two-threshold rule** — [Horvitz, CHI'99](https://www.erichorvitz.com/chi99horvitz.pdf) [primary]:
  - Do nothing below p\*¬A,D, ask (dialog) between p\*¬A,D and p\*D,A, act above p\*D,A.
  - Asking when the user lacks the goal is typically better than acting wrongly, but asking when the user has the goal is worse than just acting.
  - "Systems … do not necessarily need to perform explicit computations of expected value. Thresholds can be directly assessed by designers or users."
  - LookOut lets users set the two thresholds directly.
  - p\* rises when unwanted action is costlier, e.g. depending on the user's attention.
- **LookOut timing behavior** — [Horvitz, CHI'99](https://www.erichorvitz.com/chi99horvitz.pdf) [primary]:
  - When declined or ignored, the system "will pose a question, wait patiently for a response, and then make a respectful, apologetic gesture and evaporate."
  - The timeout "is a function of the inferred probability that a user desires the service."
  - The preferred delay before offering service grows with message length, following a sigmoid fit of user dwell time.
  - Under uncertainty it degrades gracefully, e.g. showing a week view instead of guessing a specific slot.
- **Breakpoint deferral (Attelia, Okoshi et al.)** [figures as reported in a survey; the 46% figure is the least certain]:
  - Holding notifications until detected breakpoints reduced cognitive load by about 46% in a controlled study and about 33% in the wild.
  - A study of more than 680,000 users reported response time up to 49% lower when notifications came during breakpoints.
  - Sources: [Intelligent Notification Systems survey, arXiv 1711.10171](https://arxiv.org/pdf/1711.10171); [Okoshi 2015](https://julian-ramos.github.io/papers/Okoshi2015a.pdf)
- **End of a phone-use episode:** notifications were attended to and handled significantly faster after the user finished an episode of mobile interaction than at random times. — [Fischer et al., MobileHCI'11](https://interruptions.net/literature/Fischer-MobileHCI11.pdf) [snippet]
- **Social deferral:** the SCAN prototype deferred notifications during group dining, and most participants found the chosen breakpoints appropriate. — [CSCW'17 "Don't…"](https://nmsl.kaist.ac.kr/pdf/CSCW17_Dont.pdf) [snippet]
- **Counterpoint:** a CHI 2023 study found many users still interact with notifications mid-task and argues notifications serve purposes beyond distraction. — [Chang et al., CHI'23](https://people.cs.nycu.edu.tw/~armuro/pubs/chang-et-al-2023-chi.pdf) [snippet]
- **ProAgentBench (real screen-activity logs; "when to assist" as binary)** — [ProAgentBench, arXiv 2602.04482](https://arxiv.org/html/2602.04482v1) [primary]:
  - Zero-shot models over-intervene: recall 81–97% but precision only 52–61%.
  - Chain-of-thought can push recall to 99.5% (GPT-4o-mini), i.e. more over-triggering, but dropped Qwen3-VL-8B's recall to 17.1%. Its effect is unpredictable.
  - Knowledge-graph memory raised F1 from 0.675 to 0.716.
  - A 5-minute context window worked best.
  - SFT on 741 real instances lifted Llama-3.1-8B accuracy from 57.3% (zero-shot) to 74.0%, vs. 62.1% with synthetic data.
  - Human activity is bursty (burstiness 0.787 vs. 0.166 for LLM-synthesized data).
- **OpenClaw proactive checks** — [OpenClaw docs: Heartbeat](https://docs.openclaw.ai/gateway/heartbeat) [primary]:
  - Proactive checks are now ordinary automation jobs. A "Proactive check" job runs every 30 minutes and is disabled by default.
  - Per-job `activeHours` sets a timezone-aware window. `idleOnly` gives foreground work priority.
  - `payload.skipIfScratchEmpty` skips runs when the checklist is explicitly empty.
  - "Nothing needs attention" returns `NO_REPLY`, or `record_result` with `no_change`, which suppresses delivery. A `NO_REPLY` check needs no extra final-answer model request.
  - Heartbeat-specific dedupe was *removed*, "so repeated updates can be delivered."
  - `delivery.target: "owner"` routes to the owner's DM rather than following a group.
- **Earlier OpenClaw behavior:** `HEARTBEAT_OK` at the start or end of a heartbeat reply was stripped as an ack, and replies with at most `ackMaxChars` (default 300) of remaining text were dropped. Groups skip heartbeats. — [OpenClaw heartbeat docs (older/localized version)](https://docs.openclaw.ai/hi/gateway/heartbeat) [snippet]
- **Cost-sensitive gating:** a 2026 paper frames proactive "whether and when to act" as a cost-sensitive gating problem. — [arXiv 2602.01532](https://arxiv.org/pdf/2602.01532) [snippet only]

### Inferences
- **Pattern E, "two-threshold notify policy".** For each background event, have the interaction agent (or a cheap scorer) output `p_wants ∈ [0,1]` and `urgency`. Then:
  - Below the low threshold: drop, or log to the digest only.
  - Between the thresholds: ask, or put in a digest.
  - Above the high threshold: push now.

  Expose the thresholds as user settings, as LookOut did. Raise them during quiet hours, focus time or calendar meetings, and when the user is actively chatting about something else.
- **Pattern F, "defer to breakpoint".**
  - If the user is mid-conversation in the chat UI, queue non-urgent results and deliver them at the end of the interaction agent's next turn, or after N seconds of inactivity.
  - If the user is away, use web push but respect `activeHours` and quiet hours.
  - Calendar data gives natural breakpoints (end of a meeting).
- **Pattern G, "digest by default, push by exception".** Batch low and medium items into scheduled digests. Only items above the high threshold, or explicitly requested "tell me every time" items, push immediately.
- **Pattern H, "nothing to report = typed no-op".**
  - Proactive checks must return a structured `no_change` / `NO_REPLY`, never a filler message.
  - Skip the model call entirely when there is no new input (OpenClaw's `skipIfScratchEmpty`).
  - Keep your own `dedupe_key` (e.g. `source:threadId:stateHash`) and a "last told the user" ledger. OpenClaw removing dedupe means it is the harness's job, not something to assume.
- Given ProAgentBench's over-triggering, bias the default toward silence for unrequested proactive items. Measure precision separately from recall, and do not enable chain-of-thought blindly for gate decisions.

### Gaps
- Could not read the full Okoshi/Attelia papers; the figures come via a survey.
- Did not find a 2025–2026 study specifically on LLM-assistant push-notification fatigue or digest vs. real-time preference.
- No verified source on Intercom Fin or companion-app notification policies.

## 4. Messages that arrive while work is in progress: interrupt vs. queue vs. merge (steering), debouncing bursts, acks, message chunking

### Takeaway
OpenClaw documents a clean four-mode taxonomy: **steer** (default), **followup**, **collect** and **interrupt**. It injects steering only at tool/model boundaries, uses a debounce window for queued or collected batches, and offers per-channel configuration. Poke shows the conversational side: plain text becomes multiple short bubbles, length is matched to the user's, there is no echo-style ack, and the default is no user message when delegating.

### Cited Findings
- **OpenClaw queue modes** — [OpenClaw docs: Queue steering](https://docs.openclaw.ai/concepts/queue-steering) [primary]:
  - `steer` (default) injects into the active run when possible, otherwise waits for the run to end.
  - `followup` runs queued messages after the active run.
  - `collect` "combines compatible queued messages into one later turn after a debounce window."
  - `interrupt` aborts the active run and starts the newest message.
- **Steering mechanics** — [OpenClaw docs: Queue steering](https://docs.openclaw.ai/concepts/queue-steering) [primary]:
  - "Ordinary steering does not interrupt a tool call that is already running."
  - It is checked before each subsequent *sequential* tool call. Unstarted calls are skipped with a synthetic result, "Skipped to process an incoming message.", so tool calls and results stay paired.
  - Parallel tool batches are never skipped.
  - Drained messages are appended after tool results, before the next model call, in FIFO order.
- **Tradeoffs OpenClaw names** — [OpenClaw docs: Queue steering](https://docs.openclaw.ai/concepts/queue-steering) [primary]:
  - Steer lets corrections land sooner, but a long-running tool delays them.
  - Followup and collect keep the plan stable at a latency cost.
  - Use interrupt (or `/stop`) when the new message should abort, because "steering does not stop the run."
  - Collaborative steering in groups runs with the original requester's permissions, a privilege risk; it can be disabled with `allowCollaborativeSteering: false`.
- **Debounce and config** — [OpenClaw docs: Queue](https://docs.openclaw.ai/concepts/queue) [primary via search summary]:
  - Debounce is "the quiet window before draining queued followups or collect batches."
  - Example config: `mode: "steer", cap: 20, drop: "summarize", byChannel: {discord: "collect"}, debounceMsByChannel: {discord: 1000, x: 500}`.
  - Session override: `/queue collect debounce:0.5s cap:25 drop:summarize`.
  - One doc version lists a 500 ms built-in debounce; the steering page says built-in active steering does not use the timer. These version differences are noted in the docs themselves.
- **Message chunking and acks in Poke** — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt) [leaked]:
  - Plain output "will be split by newlines into many messages". A no-split tag exists "for lists, emails, or anything that should not be broken up."
  - "You must match your response length approximately to the user's. If the user … sends you a few words, never send back multiple sentences, unless they are asking for information."
  - "Never repeat what the user says directly back at them when acknowledging user requests."
  - Address "the latest message"; earlier ones are context.
- **Status updates in Poke:** "NEVER announce `querymedia` tool usage … Other tools can still send status updates." That is, quick lookups get no "on it", while longer tasks may get one. Paired with "When calling `sendmessageto_agent`, do NOT send any message to the user" (with exceptions), the default is *no* ack when delegating. Reactions (`reacttomessage`) are used liberally as lightweight acks. — [Poke_p2.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p2.txt); [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt); [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt) [leaked]
- **ProAgentBench evidence of bursts:** real human activity is bursty (B = 0.787) compared with synthetic data (0.166), so synthetic test traffic understates bursts. — [ProAgentBench](https://arxiv.org/html/2602.04482v1) [primary]

### Inferences
- **Pattern I, "inbound debounce + collect".** Buffer user messages per conversation and fire the interaction-agent turn after about 0.8–2 s of quiet. Reset the timer on each new message or typing event, with a max-wait cap. Pass the whole burst as one turn. This fixes "people text in fragments."
- **Pattern J, "steer at boundaries".** While the interaction agent or a worker is mid-run, append new user messages at the next tool boundary rather than aborting. Skip unstarted sequential tool calls with a synthetic "skipped: new user input" result. Offer `interrupt` semantics for explicit "stop" or "never mind" messages.
- Mimir's spawned background agents should accept steering messages into their inbox. The interaction agent forwards "actually make it 6pm" to the existing worker, which matches Poke's prefer-existing-agent rule.
- **Pattern K, "ack only when latency warrants it".**
  - If a task will take more than a few seconds, or is delegated to a background worker, send at most one short, non-echo ack, or a reaction.
  - For sub-second tool use, reply only with the answer.
  - Never send an ack *and* an immediate answer.
- **Pattern L, "chunked short messages for chat, one block for structured content".** Split conversational text into bubbles. Keep lists, drafts and emails intact. Match the length of the user's message.

### Gaps
- No empirical study found on optimal debounce windows for text-fragment bursts in chat assistants; the 500 ms and 1000 ms values are OpenClaw config examples, not research.
- No user-study data on ack vs. no-ack satisfaction for agentic assistants.

## 5. Clarification policy: when to ask vs. assume and act; choice cards

### Takeaway
Recent benchmarks agree that LLM agents under-ask and guess, especially by default. They gain a lot when they do ask on genuinely underspecified tasks, but over-asking is penalized. The Horvitz two-threshold rule gives the decision structure. Poke's rules add practical defaults: confirm irreversible or outward-facing actions via drafts, don't re-ask what was already said, and make an educated guess from memory rather than asking the user to repeat themselves.

### Cited Findings
- **Ambig-SWE (underspecified SWE-Bench Verified):**
  - "Models struggle to distinguish between well-specified and underspecified instructions."
  - "LLMs default to non-interactive behavior without explicit encouragement."
  - When they do interact on underspecified inputs they effectively obtain the missing details.
  - Source: [Ambig-SWE, arXiv 2502.13069](https://arxiv.org/html/2502.13069v3) [snippet]
- **ClarifyMT-Bench** evaluates when to ask, what to ask and when to stop asking, including vague or contradictory user feedback. — [arXiv 2512.21120](https://arxiv.org/html/2512.21120v1) [snippet]
- **Silent failure vs. asking:** in underspecified DevOps instructions, when an agent stops, refusal is negligible. The stop is either a clarifying question or a silent failure, and agents mostly guess. — [Coding Agents Are Guessing, arXiv 2607.02294](https://arxiv.org/pdf/2607.02294) [snippet]
- **Clarification timing:** a paper studies whether the timing of clarification matters for long-horizon agents and critiques confidence-threshold methods for assuming information is equally useful at any trajectory point. — [Ask Early, Ask Late, Ask Right, arXiv 2605.07937](https://arxiv.org/pdf/2605.07937) [snippet]
- An uncertainty-aware multi-agent scaffold for ask-vs-assume decisions has been proposed. — [Ask or Assume?, arXiv 2603.26233](https://www.alphaxiv.org/abs/2603.26233) [snippet]
- **Horvitz:** ask (dialog) occupies the middle probability band between inaction and action, and its cost is "bothering a user needlessly." "Doing less but doing it correctly" is preferred under uncertainty. — [Horvitz, CHI'99](https://www.erichorvitz.com/chi99horvitz.pdf) [primary]
- **Poke clarification defaults** [leaked]:
  - "If you're unsure about something the user has previously told you but it's not in your current context, it's better to make an educated guess … rather than asking the user to repeat information." — [Poke_p6.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p6.txt)
  - "Whenever the user asks for information, you always assume you are capable of finding it." — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt)
  - "Never ask the user if they want extra detail or additional tasks." — [Poke_p1.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p1.txt)
  - Always confirm outbound email and calendar changes via `display_draft`, a confirmation card. — [Poke_p3.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p3.txt)
  - Emoji reactions count as yes/no answers. — [Poke_p2.txt](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Poke/Poke_p2.txt)

### Inferences
- **Pattern M, "risk-tiered ask policy".** Decide whether to ask from *reversibility and outward visibility*, not from phrasing:
  - Read-only or reversible actions: act on the best guess and state the assumption in one clause ("Set it for 5pm today — say if you meant tomorrow").
  - Outward-facing or irreversible actions (send email, accept invite, delete, comment on GitHub): show a draft or confirmation card.
  - Truly ambiguous with high cost: ask *one* precise question, ideally as a choice card with 2–4 options plus "other".
  This replaces "hedged phrasing → don't spawn" with an outcome-based rule, and hedged phrasing becomes evidence that lowers p.
- **Pattern N, "propose-and-confirm" for hedges.** For "maybe remind me to…" or "I should probably…", the assistant can offer the action as a one-tap card ("Want a reminder at 6? [Yes] [No]") instead of a classifier picking spawn or don't-spawn. This is Horvitz's dialog band made cheap.
- **Failure modes:**
  - Over-asking ("ten vague questions").
  - Re-asking known facts; check memory first.
  - Asking mid-trajectory when the answer only matters later; clarification timing matters.
  - Silently guessing on outward actions.

### Gaps
- Most clarification papers seen are coding-agent focused, and only snippets were read; no personal-assistant-specific clarification benchmark with numbers was verified.
- No source found on measured effectiveness of choice cards vs. free-text clarification.

## 6. Group-chat / multi-party "should I speak?" logic

### Takeaway
Production practice (OpenClaw) gates on addressing: mention required by default, implicit mentions such as replies, quotes or bot threads, and regex fallbacks. Unaddressed chatter is stored as context or as "room events", where the agent speaks only via an explicit message tool. Research (ProACT, 2026) shows frontier LLMs in "direct chat" mode speak on every turn and are often inappropriate. A diagnose-first, silence-by-default gate with a small set of named intervention reasons dramatically improves appropriateness.

### Cited Findings
- **OpenClaw gate order:** group policy (`groupPolicy`, default `"allowlist"`), then group and sender allowlists, then mention gating (`requireMention`, default on). Unaddressed messages are "stored only as context." — [OpenClaw docs: Groups](https://docs.openclaw.ai/channels/groups) [primary]
- **Implicit mentions:**
  - Replies to the bot count on Discord, Teams, Slack and Telegram.
  - Quotes of the bot count on WhatsApp and LINE.
  - Bot participation in a thread counts on Slack and Mattermost.
  - `mentionPatterns` provide case-insensitive regex fallbacks.
  - Group owners can switch with `/activation mention|always`.
  - Source: [OpenClaw docs: Groups](https://docs.openclaw.ai/channels/groups) [primary]
- **Ambient-chatter modes:**
  - `messages.groupChat.unmentionedInbound: "user_request"` (default) treats always-on chatter as requests needing replies.
  - `"room_event"` submits it as quiet context, and the agent posts only by explicitly calling the message tool.
  - `agents.defaults.silentReply.group: "allow"` permits optional handling of unaddressed requests.
  - Source: [OpenClaw docs: Groups](https://docs.openclaw.ai/channels/groups) [primary]
- **ProACT benchmark** (3,244 turn-level examples, balanced 50/50 between intervene and silence; GitHub issues, QMSum meetings and synthetic data) — [ProACT, arXiv 2607.03730](https://www.alphaxiv.org/abs/2607.03730) [primary via alphaxiv]:
  - Direct-chat GPT-5.4 responds on *every* silence-labeled turn, and 34.8% of those responses are judged inappropriate.
  - ProACT diagnoses whether a "breakdown" exists, out of eight types: conflict, uncertainty, underspecified plan, forgotten constraint, goal drift, discussion loop, participation imbalance, risky commitment. If one exists it routes to one of eight targeted skills; otherwise it stays silent.
  - ProACT responds on only 39.3% of silence-labeled turns.
  - GPT-5.4 appropriateness rose from 65.2% to 89.6%. Kimi K2.5 rose from 0.222 to 0.870 on appropriateness and from 0.129 to 0.964 on conciseness.
  - Inappropriate silence stayed at 4.7%.
  - 83.5% of ProACT's silences on intervention-labeled turns were judged acceptable abstentions.

### Inferences
- **Pattern O, "diagnose-then-speak".** Mimir is mostly single-user, but the ProACT result transfers directly to *proactive* surfacing. Require the model to name a concrete reason to speak from a fixed list before producing visible text, with silence otherwise. For Mimir the list might be: deadline at risk, needs your decision, something you asked to be told about, conflict detected, or a failure needing attention. This is a "reason code" field on the notify decision and makes evals easier.
- If Mimir is ever added to group surfaces (Slack or Discord), copy OpenClaw's defaults: mention-gated, implicit mentions via replies and threads, and unaddressed messages kept as context only.

### Gaps
- Did not review the classic addressee-detection literature (multi-party dialogue, pre-LLM) in this pass.
- No data on Discord or Slack bot "should I respond" heuristics beyond OpenClaw.

## 7. How to evaluate response appropriateness

### Takeaway
Use scenario suites with explicit "silence" gold labels and separate precision (no unwanted messages) from recall (no missed needs). Simulate users with personas and styles, keep rubrics hidden from the agent and fixed before it responds, score structured action fields as well as text, and validate the LLM judge against humans and a second model family. Recent benchmarks (ProAgentBench, ProACT, ProactBench, ChronosBench) provide reusable designs.

### Cited Findings
- **ProAgentBench** — [arXiv 2602.04482](https://arxiv.org/html/2602.04482v1) [primary]:
  - "When to assist" is scored as binary classification with accuracy, precision, recall and F1. The authors note precision captures interruption cost and recall captures missed needs.
  - "How to assist" is scored by intention accuracy, which is low even for the best models: 38.2% with CoT.
- **ProACT** — [arXiv 2607.03730](https://www.alphaxiv.org/abs/2607.03730) [primary via alphaxiv]:
  - A balanced intervene/silence dataset.
  - Judge metrics: Appropriateness, Non-interruptiveness, Conciseness ("short and free of meta-commentary"), and 1–5 Quality only on visible interventions.
  - Caveats: offline, turn-level, LLM-judged.
- **ProactBench** (Boson AI, May 2026) — [arXiv 2605.09228](https://arxiv.org/html/2605.09228) [primary]:
  - Three-agent setup: a Planner writes the strategy and a hidden per-trigger rubric; a User Agent with persona plus one of 24 communication styles; the Assistant sees only the conversation. An offline judge (GPT-5.4) scores trigger turns Pass/Partial/Fail and must give a rationale and a verbatim evidence quote.
  - Corpus: 198 dialogues, 624 triggers.
  - Trigger types: Emergent (infer an unstated need), Critical (synthesize two or more details), Recovery (add value after the task is done).
  - GPT-5.5 leads at 61.5% pass. On Recovery, 14 of 16 models pass under 20%; failures are mostly generic closings (44%) and repeated deliverables (45%).
  - Recovery correlates weakly with standard benchmarks (r ≈ 0.51).
  - Human–judge agreement: 93.3% within one step (Krippendorff's α = 0.69 among humans).
  - The paper does *not* formally penalize over-proactivity.
- **ChronosBench** — [arXiv 2601.09382](https://arxiv.org/abs/2601.09382) [primary]:
  - Simulated timeline with environment updates, a positive branch (should notify) and a negative branch (must `KEEP_SILENT`).
  - Metrics: task completion rate (equal-weight positive/negative), Action Accuracy and Status Accuracy.
  - Penalizes declaring a task complete without the user's acknowledgment and keeping silent too early.
  - A fine-tuned 8B model reached 85.19% on complex tasks with shifting user intent.
- **Related benchmarks** [snippet]:
  - π-Bench: 100 multi-turn, long-horizon proactive personal-assistant tasks with hidden user intents and cross-session continuity. — [arXiv 2605.14678](https://arxiv.org/html/2605.14678)
  - ProAct (structure-aware proactive response): a multimodal benchmark covering assistance, maintenance and safety monitoring. — [arXiv 2602.03430](https://arxiv.org/pdf/2602.03430)
- ClarEval-style benchmarks penalize over-asking. — [search result set incl. arXiv 2603.00187](https://arxiv.org/html/2603.00187) [snippet]

### Inferences
- **Pattern P, "Mimir response-appropriateness suite".** Build about 100–300 YAML or JSON scenarios. Each holds a conversation history plus an incoming event (user burst, worker result or trigger fire), with gold labels:
  - `expected_actions` (a set, not a single label, e.g. `{answer, schedule_reminder}`)
  - `must_not` (e.g. `send_email_without_confirm`, `notify`)
  - `visible_reply: required | forbidden | optional`
  - `max_messages`
  - `reason_code`

  Score deterministic parts (tool calls, silence) exactly, and use an LLM judge only for tone and conciseness.
- **Include these slices:**
  - combined intents;
  - hedged phrasing;
  - fragment bursts (bursty, per ProAgentBench);
  - mid-task corrections (steer);
  - "already confirmed" re-asks;
  - worker results with nothing new (dedupe);
  - mis-fired triggers (expect `wait`);
  - quiet-hours pushes;
  - post-task "recovery" turns (expect no generic "let me know if…" closings, per ProactBench).
- **Report notify precision and recall separately.** Track "messages per event" and "inappropriate silence" as in ProACT. Keep a frozen regression set, since rule and prompt changes caused the original brittleness.
- Use a user simulator (tau-bench style) with persona and style variation for multi-turn flows. Validate the judge on a human-labeled subset, and spot-check with a second model family as ProactBench did.

### Gaps
- Did not fetch Sierra's tau-bench or tau²-bench primary pages this pass, so their specific user-simulation methodology is not cited here.
- No public benchmark found that specifically targets *personal-assistant push-notification* appropriateness across email, calendar and code sources; Mimir will likely need its own suite.
- No industry data from Intercom Fin, Character.ai or other companion apps on response-decision evaluation was found.
