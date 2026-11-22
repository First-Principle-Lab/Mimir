# Tool Layer and Safety Layer for a Personal-Assistant Harness (Mimir), as of Nov 2026

Context: TypeScript/Node harness; Composio (OAuth + hosted MCP tools for Gmail/Calendar/GitHub/Notion/Linear), Browserbase for browser use, user-added custom MCP servers. Today each integration has its own confirmation gate, and injection defense is "UNTRUSTED DATA" prompt wording. Goal: the harness owns tools and safety centrally.

## 1. Tool design: tool count, deferred loading, consolidation, descriptions, errors, output size, code mode

### Takeaway
Keep a small always-loaded core (3–5 tools) and defer the rest behind search. Build task-level tools rather than 1:1 API wrappers. Return concise, name-resolved, size-capped output, and write errors that tell the model what to do next. For multi-step data work, code-execution ("code mode") saves a lot of tokens, but it needs a real sandbox, so treat it as phase 2 for a solo developer.

### Cited Findings
**Consolidation, naming, outputs, errors (Anthropic, "Writing effective tools for agents")**
- Don't wrap API endpoints 1:1. Consolidate workflows into single tools, e.g. a `schedule_event` tool instead of separate list-availability and create tools, or `search_logs` that returns only relevant lines with context. Too many or overlapping tools distract agents. — [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Namespace tools by service and resource (e.g. `asana_search`, `asana_projects_search`). Prefix vs. suffix choice measurably affects results, so test it. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Return high-signal fields. Resolving UUIDs to natural-language names improved retrieval precision. Offer a `response_format` param (`"concise"` / `"detailed"`) so the agent can ask for IDs only when it needs them for follow-up calls. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Use pagination, range selection, filtering and truncation with sensible defaults: "For Claude Code, we restrict tool responses to 25,000 tokens by default." When truncating, tell the agent how to narrow its search. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Error messages should give specific, actionable fixes, not opaque codes or tracebacks, and can show a correctly formatted input example. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Write descriptions as if for a new team member. Use unambiguous parameter names (`user_id`, not `user`). Enforce schemas strictly. Small description changes gave large gains. Evaluate with realistic multi-step tasks, read transcripts, and use held-out sets. — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- OpenAI's guidance points the same way: clear names and detailed descriptions, enums and object structure "so invalid states can't be expressed", and `strict: true` for schema-conformant arguments (requires `additionalProperties: false` and all properties in `required`). — [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling/index.html); [Apidog summary](https://apidog.com/blog/openai-function-calling/)
- Sources disagree on whether strict mode fully guarantees schema adherence: a community thread reports violations, while OpenAI's docs describe constrained sampling. — [OpenAI forum](https://community.openai.com/t/strict-mode-does-not-enforce-the-json-schema/1104630); contradicted by [OpenAI docs](https://developers.openai.com/api/docs/guides/prompt-generation)
- OpenAI's function-calling guide mentions a tool search feature available on gpt-5.4 and later. — [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling/index.html)

**How many tools; tool search / deferred loading**
- Anthropic's docs: tool-selection accuracy "degrades significantly" past 30–50 tools. Tool search keeps accuracy high across thousands. Tools marked `defer_loading: true` stay out of context until searched. Regex and BM25 variants exist (`tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`). Keep the 3–5 most-used tools non-deferred. — [Claude docs: Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- A 5-server MCP setup with 58 tools used about 55K tokens before the conversation started, and Anthropic has seen 134K tokens of definitions. Tool search cut context from about 77K to about 8.7K tokens (85%) and raised MCP-eval accuracy from 49% to 74% (Opus 4) and from 79.5% to 88.1% (Opus 4.5). Use it when definitions exceed 10K tokens, there are 10+ tools or multiple MCP servers, or selection is inaccurate. Skip it for fewer than 10 tools. Whole MCP servers can be deferred. — [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Tool Use Examples (`input_examples`, 1–5 realistic examples per tool) improved complex-parameter accuracy from 72% to 90% in internal testing. They are worth adding for nested tools and look-alike tools. — [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Composio's tool router is session-scoped and uses meta-tools. The workflow is: `COMPOSIO_SEARCH_TOOLS` (takes an array of English queries, returns tool slugs, full schemas, connection status, and workflow guidance), then `COMPOSIO_MANAGE_CONNECTIONS` if a toolkit isn't connected, then `COMPOSIO_MULTI_EXECUTE_TOOL`. A REST execute-meta endpoint takes the meta-tool slug plus arguments. — [Composio meta tools](https://docs.composio.dev/reference/meta-tools); [Composio search_tools](https://docs.composio.dev/toolkits/meta-tools/search_tools.md); [Composio REST execute-meta](https://docs.composio.dev/reference/v3/api-reference/tool-router/postToolRouterSessionBySessionIdExecuteMeta.md)

**Code execution as tools ("code mode")**
- Anthropic, "Code execution with MCP": expose MCP tools as code files in a tree (e.g. `./servers/salesforce/updateRecord.ts`) that the agent explores on demand, or offer a `search_tools` call with a detail-level parameter. In Anthropic's example, token use fell from 150,000 to 2,000 (98.7%). Filtering runs in the sandbox ("The agent sees five rows instead of 10,000"). The client can tokenize PII (e.g. `[EMAIL_1]`) so real values flow tool-to-tool without passing through the model. Working code can be saved and turned into a Skill by adding a SKILL.md. Caveat: agent-generated code "requires a secure execution environment with appropriate sandboxing", resource limits, and monitoring. — [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Programmatic Tool Calling (Claude API): add a `code_execution` tool and set `allowed_callers: ["code_execution_20250825"]` on tools callable from code. Average tokens on complex research tasks fell from 43,588 to 27,297 (37%). One example shrank about 200KB of raw expense data to about 1KB. Good candidates are idempotent, parallel-safe tools. Not worth it for single calls. — [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Cloudflare Code Mode converts MCP schemas into a TypeScript API with doc comments that the LLM writes code against (`@cloudflare/codemode`). Cloudflare claims an 81% token reduction, and its full API MCP server covers 2,500+ endpoints with just `search()` and `execute()` in about 1,000 tokens. These are vendor figures. — [Cloudflare blog: Code Mode](https://blog.cloudflare.com/code-mode/); [Cloudflare blog: Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/); [Cloudflare docs](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)

### Inferences
- **Concrete Mimir tool layer.** Define one internal `ToolSpec` type with: `name` (namespaced, e.g. `gmail_search_threads`), `description`, zod/JSON schema, `risk` (see section 3), `idempotent`, `outputBudgetTokens`, `defer: boolean`, `provenance` (first-party / Composio / user MCP), and an `execute(ctx, args)` wrapper. Wrap every source (Composio, Browserbase, user MCP) in this type so gating, logging, truncation, and taint tagging happen in one place.
- **Always loaded:** a few task-level tools (e.g. `email_search`, `email_draft`, `calendar_find_time_and_propose`, `browser_task`, `memory_*`) plus a `tool_search`. Defer everything else, including all user-added MCP servers.
- **Composio meta-tools need special handling.** If Composio's tool router is used, the safety gate must inspect the inner tool slug and arguments passed to `COMPOSIO_MULTI_EXECUTE_TOOL`. Gating on the meta-tool name alone would let any action through. A simpler alternative is to fetch schemas from Composio and present them as Mimir's own deferred tools, executing directly, so the harness's tool search and policy see real tool names.
- **Output and errors in one wrapper.** Enforce a hard output cap (e.g. 10–25K tokens) with a truncation note telling the model how to narrow the query. Catch provider errors and rewrite them into actionable messages (e.g. "Calendar 'work' not found; available: personal, family").
- **Code mode is phase 2.** Its biggest win is bulk data work (inbox triage across hundreds of messages). For a solo developer, a V8 isolate or container sandbox is a significant security surface. Start with direct tool calls plus task-level consolidation.

### Gaps
- No primary source found for a specific OpenAI numeric tool-count limit (the oft-quoted "fewer than 20 functions" was not confirmed).
- I did not find independent (non-vendor) benchmarks of Cloudflare Code Mode, or accuracy numbers for Composio's tool router.

## 2. Skills: Agent Skills, OpenClaw skills, skills vs. tools, learning and saving skills

### Takeaway
Skills are progressively disclosed instructions plus optional scripts. Only the name and description sit in context until the skill is needed. Tools are callable capabilities. A personal assistant can let the model draft new skills, but they should go live only after review, because skills are effectively trusted code and prompt. ClawHub showed what a skill marketplace attracts.

### Cited Findings
- A skill is a directory with `SKILL.md` whose YAML frontmatter requires `name` and `description`. The disclosure levels are: (1) name and description loaded into the system prompt at startup, (2) the full SKILL.md body read when relevant, (3+) bundled files (e.g. `forms.md`) read only when needed. — [Anthropic: Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Skills can bundle scripts for deterministic work. The script runs without being loaded into context, so the skill should say whether to run or read it. Install skills only from trusted sources, because malicious skills can direct exfiltration. Audit bundled files and watch for external network calls. Anthropic hopes to let agents "create, edit, and evaluate skills on their own". Today authors can ask Claude to capture successful approaches into a skill. — [Anthropic: Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Code written in a code-execution environment can be saved as reusable functions and turned into a Skill with a SKILL.md. — [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- OpenClaw "Skill Workshop" is the governed path for agent-created or updated skills. It is disabled by default (`plugins.entries.skill-workshop`), writes workspace skills only, fails `create` if the skill exists, keeps drafts until they are applied, and can quarantine drafts (e.g. "Needs security review"). Precedence is workspace > `~/.openclaw/skills` > bundled. Discovery accepts only SKILL.md files whose realpath stays inside the configured root. Secrets injected via `skills.entries` env go into the host process, not the sandbox. — [OpenClaw docs: Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop.md); [OpenClaw docs: Skills](https://docs.openclaw.ai/tools/skills.md)
- Grok Bot: a Bot can save a taught task as a skill and rerun it on a schedule as a routine. — [xAI Grok Bot docs](https://docs.x.ai/grok-bot)
- ClawHub incidents:
  - An ICLR 2026 paper audited 2,556 public skills and flagged 49 as likely malicious, including card and LinkedIn credential harvesters and memory poisoning. — [ICLR 2026: ClawdPwned](https://iclr.cc/virtual/2026/10016269)
  - Koi Security's "ClawHavoc" campaign counted 341 malicious skills, and Trend Micro confirmed Atomic macOS Stealer delivery. — [DEV summary](https://dev.to/onlymakeai_c48c7734b1a892/clawhavoc-how-341-malicious-skills-targeted-openclaw-users-220m); [TechRadar](https://techradar.com/pro/security/multiple-malicious-openclaw-skills-found-online-including-two-macos-infostealers)
  - Unit 42 found five malicious skills that passed ClawHub's automated checks. — [Unit 42](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain/)
  - ClawHub added VirusTotal and ClawScan screening. — [Dark Reading](https://www.darkreading.com/cyber-risk/malicious-openclaw-skills-clawhub-threaten-ai-supply-chain)
  - Counts vary by source (49, 341, and an unverified 1,184 via SC Media). — [SC World](https://scworld.com/brief/massive-openclaw-supply-chain-attack-floods-openclaw-with-malicious-skills)
- Cisco's AI security team tested a third-party OpenClaw skill that silently performed data exfiltration and prompt injection. This is a secondary report. — [TechRadar: OpenClaw skills guide](https://www.techradar.com/pro/what-are-openclaw-skills-a-detailed-guide)

### Inferences
- **Skills vs. tools in Mimir.** Tools are typed, gated capabilities owned by the harness. Skills are Markdown procedures (e.g. "weekly invoice reconciliation", "how I like meeting replies") that reference tools by name. Skills should never carry their own credentials or bypass the policy engine. Any script in a skill runs through the same gated tool path, such as a sandboxed `run_script` tool.
- **Learning loop.** After a successful multi-step task, Mimir proposes "save as skill?" and drafts the SKILL.md. Two safeguards follow:
  - Store the draft as quarantined until the user approves it in the UI.
  - Never auto-create or modify a skill in a session that ingested untrusted content, because a skill is persistent prompt injection (the memory-poisoning vector seen on ClawHub).
- **Provenance.** Track a `source` for each skill (user-authored, agent-drafted-approved, imported) and refuse third-party marketplace skills by default.

### Gaps
- No evaluation data found on how well auto-generated skills perform, or on skill-description triggering accuracy at scale.

## 3. Permissions and approvals: modes, classifiers, rules, UX, taxonomies

### Takeaway
The current state of the art (Claude Code auto mode, Codex `auto_review`, Grok Bot Auto-review) layers checks in order:
1. Deterministic allow and deny tiers.
2. A model-based reviewer that sees only the user's own messages and the proposed action, never untrusted tool output.
3. Plain-English user rules that can only tighten behavior.
4. Approval cards (Allow once / Always allow / Deny) with expiry for background work.

Outbound communication that the user didn't explicitly request falls back to draft-then-confirm. Most of this is implementable by a solo developer.

### Cited Findings
**Claude Code auto mode (model-classifier approvals)**
- Users accept 93% of manual permission prompts. Auto mode replaces most prompts with classifiers. — [Anthropic: Claude Code auto mode](https://www.anthropic.com/news/claude-code-auto-mode)
- Tiers:
  - Tier 1 is a read-only allowlist plus user allow rules. Broad code-execution allow rules (blanket shell, wildcarded interpreters) are dropped in auto mode.
  - Tier 2 allows in-project file edits without a classifier call.
  - Everything else goes to a transcript classifier (Sonnet 4.6) that sees only user messages and the agent's tool calls. Assistant text and tool outputs are stripped, "reasoning-blind by design".
  - The classifier runs in two stages: a fast yes/no filter told to "err on the side of blocking", then chain-of-thought only when flagged. Stage 2 reuses the same prompt, so it is mostly cache hits.
  
  — [Anthropic Engineering: Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
- A separate server-side probe scans tool results for hijack attempts and injects a warning that tells the agent to re-anchor on the user's request. Because the classifier never sees tool results, it is "structurally resistant to injection". — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-auto-mode)
- Measured error rates (Stage 1 only vs. full pipeline):
  - False-positive rate on real traffic (n=10,000): 8.5% vs. 0.4%.
  - False-negative rate on real overeager actions (n=52): 6.6% vs. 17%, which the authors call "the honest number".
  - False-negative rate on synthetic exfiltration (n=1,000): 1.8% vs. 5.7%.
  
  Most misses happen when the classifier wrongly judges that a prior approval covers this action's blast radius. — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-auto-mode)
- Default block rules (more than 20) fall into four groups: destroy or exfiltrate data, degrade security posture, cross trust boundaries, and bypass review or affect others. Intent is read conservatively: "everything the agent chooses on its own is unauthorized until the user says otherwise", and "clean up my branches" does not authorize a batch delete. A denial returns to the agent as a tool result telling it to find a safer path. After 3 consecutive or 20 total denials, the run stops and escalates to the human. Headless mode terminates instead. — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-auto-mode)
- Docs: auto mode "reduces permission prompts but does not guarantee safety." Users can configure trusted environment and services. — [Claude Code docs: auto mode config](https://code.claude.com/docs/en/auto-mode-config)

**Codex**
- The common default is `sandbox_mode = "workspace-write"` plus `approval_policy = "on-request"` (alias `--full-auto`). `on-request` stays in the sandbox and asks only to cross the boundary. Network is off by default in workspace-write. `danger-full-access` plus `never` removes both. — [OpenAI Codex: sandboxing](https://developers.openai.com/codex/concepts/sandboxing); [Codex agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)
- Newer docs add `approvals_reviewer` (`user` by default, or `auto_review`) to choose who handles approval requests, and say the `untrusted` approval policy has been retired. Older pages still describe it, so there is a conflict between doc versions. — [Codex agent approvals & security](https://developers.openai.com/codex/agent-approvals-security); [Codex auto review (zh-Hant)](https://developers.openai.com/zh-Hant/docs/sandboxing/auto-review)

**Grok Bot Auto-review (plain-English rules)** (docs moved from cursor.com/help to docs.x.ai)
- Auto-review checks each action (commands, connected apps, computer use) before it runs. It considers what the user asked for in their own messages: "Text from an email or web page doesn't count as your request." Built-in checks always apply. — [xAI: Approvals, security and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Rule types:
  - **Ask first** rules always stop matching actions.
  - **Allow automatically** rules let matching actions through only if the review finds no other reason to stop.
  - When both match, Ask first wins.
  
  Limits are 20 Allow and 20 Ask-first rules, each up to 1,000 characters. At the cap, "Always allow" replaces the oldest Allow rule. Example rules: "Ask first before sending any external email" and "Allow automatically when running `git status` in `/workspace/reports`". The docs warn against broad rules like "allow everything in the browser". Team rules apply first, and personal rules "can only make behavior stricter". — [xAI docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Card semantics:
  - **Allow once** runs the action without saving a rule.
  - **Always allow** saves an Allow rule.
  - **Deny** blocks the action, and the Bot won't retry or re-ask until the user's next message.
  - Cards from chat-started work have no timer. Cards from routines, incoming messages, or background work expire after 30 minutes, after which the user must ask the Bot to retry.
  - A new chat message closes open cards. Changing Auto-review settings closes all cards.
  - In group chats only the requester can answer, and there is no Always allow. — [xAI docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Email policy: email requested in chat sends once allowed. Email from routines, incoming messages, or other unrequested work waits as a draft until the user presses Send. Forwards, and emails with attachments that can't be fully read, always wait for approval. — [xAI docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- The Bot can propose adding, changing, or removing an Auto-review rule on a card the user confirms (0.75.2+). — [Search summary of Grok Bot docs](https://cursor.com/help/grok-bot/approvals)
- Field reports:
  - In 0.78.1, the classifier errored before many actions, and the workaround was turning Auto-review off. — [Cursor forum](https://forum.cursor.com/t/grok-bot-auto-review-classifying-error-no-approval-card-0-78-1/176550.md)
  - Cards kept appearing even after an Always-allow rule was saved. — [Cursor forum](https://forum.cursor.com/t/auto-review-still-prompts-after-always-allowed-standing-approval/172859)
  - Users asked for webhook-triggered routines to count as user intent for predeclared outbound actions. — [Cursor forum](https://forum.cursor.com/t/webhook-triggered-grok-bot-routine-should-count-as-user-intent-for-predeclared-outbound-actions/169720)

**ChatGPT agent, Poke, Meta**
- OpenAI designs agents to "get a final confirmation from you before taking certain consequential actions like completing a purchase or sending an email". Watch Mode requires the tab to be active on sensitive sites such as banks. — [OpenAI: Prompt injections](https://openai.com/index/prompt-injections/)
- Simon Willison couldn't trigger Watch Mode on GitHub or a bank site and is skeptical it is a meaningful mitigation. — [Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)
- Poke, per leaked system prompts (unofficial): user sign-off on content and recipients is required before email dispatch, drafts are shown via a `display_draft` call, and confirmations cover send, forward, reply, and calendar events. No official Interaction Company documentation was found. — [Poke system prompt (compiled)](https://glama.ai/mcp/servers/@JamesANZ/system-prompts-mcp-server/blob/404ce4c27a251680432b073a7eb9ac660a206329/prompts/Poke/Poke_p3.txt); [Mintlify mirror](https://www.mintlify.com/x1xhlol/system-prompts-and-models-of-ai-tools/commercial/poke)
- Meta calls human approval the preferred supervision today, but notes it is disruptive for background processes, and that users who blindly confirm warnings defeat it. — [Meta AI: Practical AI agent security](https://ai.meta.com/blog/practical-ai-agent-security/)
- An arXiv preprint argues approval dialogs can be forged when the agent writes its own summary of the action, so the human approves a narrative rather than the real call. This is a secondary report; I did not read the full paper. — [arXiv 2606.02668](https://arxiv.org/html/2606.02668)

### Inferences
**Consequential-action taxonomy for Mimir.** Attach a `risk` to every ToolSpec, assigned by the harness rather than the tool provider. MCP annotations are only hints (see section 6). Suggested tiers:
- `read_private`: search or read email, calendar, Notion.
- `write_reversible_self`: draft, label, archive, create a private Notion page.
- `communicate_external`: send, reply, forward, invite attendees, comment publicly, post to Linear or GitHub, any browser form submit.
- `destructive`: delete or trash in bulk, cancel events with attendees, revoke.
- `financial_identity`: purchase, payment, change password or 2FA, OAuth grants.
- `code_exec`.

Default policy by tier:
- `read_private` and `write_reversible_self` run automatically.
- `communicate_external` auto-runs only if it matches an explicit user request in this session and no untrusted content is in the taint set (section 4). Otherwise it becomes a draft plus a confirm card.
- `destructive` and `financial_identity` always ask.
- Unknown tools from user-added MCP servers default to ask until classified.

**Classifier reviewer (cheap model).** Input is only the user's turns plus the structured proposed call (tool name, arguments, resolved recipients and domains). Never pass tool results or assistant prose. Output is `allow | ask | block` with a reason. Run deterministic rules first and the classifier only on gray cases. Mirror Claude Code's escalation: stop after N denials.

**Rules UX.** Store plain-English user rules (Grok-style, capped at about 20 each) and feed them to the classifier. Also compile what you can into deterministic predicates, e.g. a recipient domain allowlist.

**Card rendering.** Render approval cards from the actual tool arguments (recipient, subject, body diff, event attendees), never from the model's description of them. This addresses the forged-summary attack.
- Buttons: Allow once / Always allow (scoped to tool + argument pattern, e.g. a recipient domain) / Deny.
- Deny feeds back to the model as a tool result, and the model must not retry until the next user message.
- Background cards expire (30 minutes is a reasonable default per Grok). On expiry, keep the draft.

**Background routines.** At routine creation, the user predeclares allowed outbound actions (e.g. "send this digest to me"). This is the intent the classifier honors later. Anything not predeclared becomes a draft. This is also the feature request raised on the Grok forum.

**Avoid over-approval.** Claude Code's main miss mode was assuming a prior approval covered a bigger blast radius. Scope "Always allow" narrowly and count-limit bulk operations (e.g. "trash 3 emails" does not cover 300).

### Gaps
- I did not fetch Claude Code's hooks documentation in this session. PreToolUse-style hooks are the obvious model for a pluggable policy hook in Mimir, but the specifics should be verified at code.claude.com/docs.
- I did not find full documentation of Codex `auto_review` internals, or official Poke documentation.
- I did not research OWASP Top 10 for LLM / Agentic AI taxonomies in this pass.

## 4. Prompt injection: trifecta, Rule of Two, CaMeL, design patterns, provenance, spotlighting, incidents, benchmarks

### Takeaway
No prompt wording or filter reliably stops prompt injection. The practical defenses are architectural:
- Track which context items are untrusted (taint).
- Once a session is tainted, deny autonomous consequential actions; require human approval or a fresh, clean context.
- Keep the action reviewer blind to untrusted content.
- Use spotlighting and an injection probe as cheap defense in depth.

Full CaMeL-style capability interpreters exist but are heavy for one developer.

### Cited Findings
**Frameworks**
- Lethal trifecta (Willison): access to private data, exposure to untrusted content, and a way to communicate externally. A single MCP such as Supabase or GitHub can supply all three. — [Simon Willison: Supabase MCP lethal trifecta](https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta)
- Meta's Agents Rule of Two (Oct 31, 2025): until injection can be reliably detected, a session should have at most two of [A] processing untrustworthy input, [B] access to sensitive systems or private data, [C] changing state or communicating externally. — [Meta AI](https://ai.meta.com/blog/practical-ai-agent-security/)
  - If all three are needed, the agent shouldn't run autonomously: use human approval, other reliable validation, or a fresh context window.
  - A session can move between configurations, e.g. start in [AC] for web access, then disable outbound communication before touching internal systems.
  - Email-bot example: [BC] processes only trusted senders, [AC] has no sensitive data, [AB] sends only to trusted recipients or after human approval of the draft.
  - Travel agent [AB]: human confirmation of reservations, and web requests limited to URLs returned from trusted sources.
  - Browsing assistant [AC]: sandboxed browser "without preloaded session data".
  - Meta calls the rule "a supplement — and not a substitute" for least privilege.
- Willison called the Rule of Two the best practical advice available today. — [Simon Willison](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/)
- Critics note the Rule of Two is scoped to single agents and doesn't cover multi-agent propagation. — [Ken Huang](https://kenhuangus.substack.com/p/the-rule-of-two-vs-reality-why-metas)

**Design patterns** ("Design Patterns for Securing LLM Agents against Prompt Injections", 2025)
- The six patterns:
  1. Action-Selector: actions without feedback.
  2. Plan-Then-Execute: tool outputs can affect content but not which actions run.
  3. LLM Map-Reduce: sub-agents process untrusted items and return constrained results.
  4. Dual LLM: a privileged LLM coordinates a quarantined LLM that returns symbolic variables.
  5. Code-Then-Execute: CaMeL-style DSL with data-flow tracking.
  6. Context-Minimization: drop unneeded content from context.
  
  Core principle: once an agent has ingested untrusted input, it must be impossible for that input to trigger consequential actions. The case studies include an Email & Calendar Assistant. — [Simon Willison: Design patterns paper](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/)
- CaMeL (Google DeepMind) uses a custom Python interpreter that extracts control and data flow from the user query, attaches capabilities to values, and enforces policies at tool calls without changing the LLM. It solves 77% of AgentDojo tasks with provable security vs. 84% undefended (an earlier version said 67%). In one comparison with Claude 3.5 Sonnet it recorded 0 successful attacks, vs. 8 for a tool filter and 44 undefended. Its main limitation is that users must define security policies. — [arXiv 2503.18813](https://arxiv.org/abs/2503.18813); [Simon Willison on CaMeL](https://simonwillison.net/2025/Apr/11/camel/)

**Spotlighting and probes**
- Microsoft Spotlighting has three modes: delimiting, datamarking (interleave a token such as `^` through untrusted text and tell the model), and encoding (e.g. base64). Datamarking and encoding significantly reduce attack success rate with negligible task impact. — [arXiv 2403.14720](https://arxiv.org/abs/2403.14720)
- A secondary post claims attack success fell from over 50% to under 2% on GPT models (unverified against the paper). Spotlighting is used in Prompt Shields, Azure AI Content Safety. — [Microsoft Tech Community](https://techcommunity.microsoft.com/discussions/azure-ai-foundry-discussions/reliability-starts-with-separating-instruction-from-content/4553127); [MSRC blog](https://www.microsoft.com/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks)
- In the LLMail-Inject CTF (839 participants, 208k+ submissions against an LLM email assistant), 0.8% of submissions achieved end-to-end success. A secondary source concludes spotlighting doesn't hold against adaptive attackers. — [spotlighting-datamarking repo](https://github.com/realArcherL/spotlighting-datamarking)
- Claude Code runs a server-side injection probe on tool results that adds a warning to re-anchor on the user's request (see section 3). — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-auto-mode)
- OpenAI's CISO calls prompt injection "a frontier, unsolved security problem". OpenAI advises not giving agents wide latitude to follow instructions from emails. — [OpenAI: Prompt injections](https://openai.com/index/prompt-injections/); [Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)

**Incidents**
- GitHub MCP (Invariant Labs, May 2025): a malicious public issue made an agent leak private-repo data through legitimate tool calls (a "toxic agent flow"). It was an architectural issue, not a server bug. Mitigations: one repo per session, least-privilege tokens, runtime guardrails. Invariant shipped toxic-flow analysis in MCP-scan. — [Invariant Labs](https://invariantlabs.ai/blog/mcp-github-vulnerability); [Invariant: Toxic flow analysis](https://invariantlabs.ai/blog/toxic-flow-analysis)
- Supabase MCP (July 2025): a support ticket injected Cursor's agent, which ran with the `service_role` key that bypasses Row-Level Security. — [Simon Willison](https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta)
- EchoLeak (CVE-2025-32711, Aim Security, June 2025): a zero-click email to Microsoft 365 Copilot exfiltrated data. It bypassed Microsoft's XPIA classifiers, evaded link redaction via markdown, and used a CSP-approved Microsoft domain for exfiltration. The email was phrased as instructions to the human, not to the AI. Microsoft patched it. — [arXiv 2509.10540](https://arxiv.org/html/2509.10540v1); [Dark Reading](https://www.darkreading.com/application-security/researchers-detail-zero-click-copilot-exploit-echoleak)
- OpenClaw/ClawHub malicious skills: see section 2.

**Benchmarks**
- AgentDojo (NeurIPS 2024) is the benchmark CaMeL is evaluated on. — [arXiv 2503.18813](https://arxiv.org/abs/2503.18813)

### Inferences
These are practical steps for a solo developer, in priority order.

1. **Taint tracking at the harness level.** Every context item gets a provenance label:
   - `user` (the user's own chat turns)
   - `system`
   - `trusted_tool` (structural metadata the harness controls)
   - `untrusted` (email bodies, web pages, calendar descriptions from others, GitHub issues, Notion pages shared by others, any user-added MCP output, browser DOM)
   
   The session holds a `tainted: boolean` (or a set of sources). This takes about 50 lines of TypeScript and powers everything else.
2. **Policy keyed on taint.** When tainted, `communicate_external`, `destructive`, and `financial_identity` actions require a human card, even if a rule would otherwise auto-allow them. Recipient and URL arguments that appear only in untrusted content (not in user turns or the contact list) get flagged. This is the Rule of Two enforced in code.
3. **Reviewer blind to untrusted text.** As in Claude Code and Grok, the action classifier sees only user turns and the structured call. This is cheap and robust.
4. **Quarantined reader (Dual-LLM-lite or Map-Reduce).** For bulk inbox triage, a sub-call with no tools reads each email and returns a constrained schema, e.g. `{category: enum, needsReply: bool, summary: string<=200}`. The privileged agent sees only these fields. Free-text summaries can still carry injections, so prefer enums and IDs.
5. **Spotlighting.** Wrap untrusted content in delimiters with a random per-session tag plus datamarking. This replaces the per-prompt "UNTRUSTED DATA" wording with one central wrapper. Treat it as defense in depth, not a boundary.
6. **Exfiltration channels.** Don't render model-produced markdown images or links to arbitrary domains in the Mimir UI (the EchoLeak vector). Strip or proxy them. Restrict browser navigation in tainted sessions to user-provided or allowlisted domains.
7. **Least-privilege scopes per integration.** Use the GitHub one-repo-per-session lesson and avoid admin or service-role keys.
8. **CaMeL-style interpreters** are the strongest option but have the highest cost. Plan-Then-Execute is a feasible middle ground for routines: the plan (tool list and order) is fixed from the user request before any untrusted data is read.

### Gaps
- I did not retrieve InjecAgent results or the latest AgentDojo leaderboard numbers (2026) in this pass.
- I found no published evaluation of injection-probe classifiers (Claude Code's or others') with false-negative rates.
- OWASP Agentic Top 10 not reviewed.

## 5. Credentials: keeping secrets away from the model, vaults, auth contexts, human takeover

### Takeaway
The model should never see a secret. Use OAuth tokens held by Composio or the harness, vault fill-ins injected outside the model's context (1Password Agentic Autofill on Browserbase, Grok Vault and Secure Forms), persisted browser auth contexts created once by a human through Live View, and explicit human takeover for SSO, 2FA, CAPTCHA and passkeys.

### Cited Findings
- Grok Bot credential priority is Vault login first, then a connected password manager (e.g. 1Password), then a Secure Form. Vault logins and Secure Form values are filled into pages "without being shown to the model". Secure Forms mask the value and keep it out of the transcript. Users should never paste passwords, OTPs, or API keys in chat. Exception: in app chats a Bot can see a saved card's number and CVC to type at checkout, and saved cards fill without per-payment approval unless the user opts out. — [xAI docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- Grok Bot takeover: for SSO, passkeys, CAPTCHA, approval on another device, or bank card verification, the user chooses "Take over" or "Take control", completes the step, presses "I'm done", and tells the Bot to continue. Hardware security keys can be used via the desktop with per-use approval. Note that the shared cloud computer keeps browser sessions and CLI credentials across all Bots. — [xAI docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- 1Password Secure Agentic Autofill with Browserbase (launched Oct 2025):
  - Credentials never enter the LLM context.
  - Each access request needs human approval in 1Password.
  - It uses an encrypted Noise Framework channel and keeps audit logs of when, where, and how credentials were used.
  - Browserbase's Oct 22, 2026 changelog says 1Password handles OAuth, token management and autofill in the extension, and removes filled values after submission.
  
  — [1Password blog](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents); [TechRadar](https://www.techradar.com/pro/security/1password-might-just-have-a-solution-to-the-password-security-problem-posed-by-ai-agents); [Browserbase changelog](https://browserbase.com/changelog/1password-for-agents)
- Browserbase's recommended pattern is to log in manually once via Session Live View, then persist auth with Contexts (`persist: true`; cookies, localStorage, IndexedDB). Contexts last until deleted or invalidated, though sites may still expire cookies. When 2FA can't be bypassed, hand control back to the user via Session Live URLs. Treat live URLs as sensitive, because anyone holding the link may be able to view or control the session. — [Browserbase: Authentication](https://docs.browserbase.com/guides/authentication); [Browserbase: Contexts](https://docs.browserbase.com/features/contexts); [ClawHub skill review (security caveat)](https://clawhub.ai/browserbase-sessions)
- Anthropic code-execution pattern: the harness tokenizes PII (`[EMAIL_1]`) before the model sees it and substitutes real values at tool-call time. — [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)
- MCP spec rules relevant to user-added servers:
  - Servers MUST NOT accept tokens not issued to them (no token passthrough).
  - Clients SHOULD block private IP ranges and validate redirects (SSRF).
  - Authorization URLs MUST use http or https only, and clients MUST NOT open URLs via shell.
  - One-click local servers need a consent dialog showing the exact command, and should run sandboxed.
  - Use progressive least-privilege scopes and avoid wildcard scopes.
  
  — [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)

### Inferences
- **Mimir rules:**
  1. Secrets live only in Composio (OAuth) and an encrypted harness store, and are referenced by handle, e.g. `{{secret:github_pat}}`. They are substituted inside `execute()` after the policy check and redacted from logs and tool results.
  2. Add a "secure input" card in the Mimir UI (like Grok's Secure Forms) that writes directly to the vault, so the user never types a secret into chat.
  3. For Browserbase, use one Context per site or account, created by the user through a Live View "connect this site" flow.
  4. Browser sessions for untrusted research tasks use a fresh context with no logins, per Meta's [AC] browsing configuration.
  5. Expose a `request_human_takeover(reason)` tool that pauses the run and sends the user the Live View link.
- **User-added MCP servers are untrusted code and data.** Show the exact command or URL at install, run stdio servers in a container, mark their output untrusted, and default their tools to ask.

### Gaps
- I did not research Anchor Browser auth profiles specifically.
- 1Password Agentic Autofill availability outside Enterprise plans as of Nov 2026 is unclear (sources conflict between "early access" and "open beta for Enterprise").

## 6. Idempotency and safety of side-effecting tools under retries

### Takeaway
Retries belong in the tool layer, not the model loop. Derive a stable idempotency key per logical operation, record the intent and outcome durably before and after the side effect, check the record on retry, and verify the result (e.g. look up the Sent folder) when the provider has no native idempotency key. MCP `idempotentHint` and `readOnlyHint` annotations are only hints.

### Cited Findings
- An arXiv preprint derives the key from the action's content and reuses it across attempts. A server that honors keys gives at most one effect. Verifier-only approaches are best-effort and can duplicate under races. — [arXiv 2608.02645](https://arxiv.org/pdf/2608.02645)
- A related preprint studies where exactly-once lives (model vs. harness vs. tool contract) for duplicate side effects in LLM agents. I found only the title. — [arXiv 2609.29095](https://arxiv.org/pdf/2609.29095)
- Checkpointing stops completed steps from re-running but can't tell whether an interrupted write landed, so idempotency is still needed. — [Akka guide](https://akka.io/guides/retry-without-repeating-side-effects)
- One write-up traced a duplicate email to a durable-framework replay whose step cache ignored the idempotency key. Temporal, Inngest, and Restate prevent re-execution only when the step cache is keyed correctly. — [DEV: Why your AI agent sent that email twice](https://dev.to/milo_antaeus_784320e2f2f9/why-your-ai-agent-sent-that-email-twice-an-idempotency-field-guide-46le)
- Use a stable key per logical operation, not per tool call. Reject key reuse with a different payload (conflict). The agent loop is a poor retry owner because rephrasing defeats exact matching. — [DEV: Idempotency for agent actions](https://dev.to/tridaai/idempotency-for-agent-actions-3cfn); [Idempotency keys are the seatbelt](https://my-slops.github.io/Blog/posts/2026/03/idempotency-keys-are-the-seatbelt-for-ai-agents)
- MCP idempotent and read-only annotations are hints, not enforcement. Providers without key support can still duplicate. — [DEV: Make your agent's API calls idempotent](https://dev.to/mukundakatta/make-your-agents-api-calls-idempotent-before-you-need-to-2994)
- Anthropic recommends idempotent, parallel-safe tools as candidates for programmatic or code-driven calling. — [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)

Note: these sources are mostly practitioner blogs and preprints, not benchmarked studies.

### Inferences
**Mimir implementation**, an `actions` table in SQLite or Postgres with `id, session_id, tool, args_hash, idem_key, status(pending|approved|executing|succeeded|failed|unknown), provider_ref, created_at`.
1. On a side-effecting call, compute `idem_key = hash(session_id, tool, canonical(args))`, or bind it to an approved draft ID, which is ideal: approval cards approve a specific draft ID, and execution is "send draft X" exactly once.
2. If a row exists with `succeeded`, return the stored result. If `executing` or `unknown`, reconcile first. For Gmail, search Sent for the draft or `Message-ID` header the harness set. For Calendar, set a client-generated event ID or `iCalUID`. For Linear and GitHub, search by an embedded marker before re-creating.
3. Store the approval-to-action binding. A retry after a crash must not need re-approval, but a changed payload must.

**Draft-then-send helps here too.** It turns "send" into an operation on a stable server-side object (the draft ID), which is naturally deduplicated, and it doubles as the approval artifact.

**Mark `unknown` on timeouts** and never auto-retry `communicate_external` actions. Surface them to the user instead.

### Gaps
- I did not verify which Composio Gmail, Calendar, Linear, or GitHub actions accept native idempotency keys or client-supplied IDs. Check per action.
- The arXiv preprints were seen only via search snippets and were not read in full.
