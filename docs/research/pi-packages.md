# pi package survey for Mimir

Surveyed **2026-11-22** against the npm registry (`keywords:pi-package`, the same index the
[pi package gallery](https://pi.dev/packages) uses) and the pi source at `earendil-works/pi`
(v1.6.0, MIT). Download counts are npm monthly downloads on the survey date.

## Ecosystem facts that shape every decision

- **14,161** packages carry the `pi-package` keyword. 46 topic searches returned **882** distinct
  packages relevant to a personal assistant. Most of them are **coding-agent and single-user CLI**
  tools: they assume a local terminal user, read config from `~/.pi/agent/...`, and use the TUI.
- **There are two pi extension systems, and they are not compatible:**
  - `@earendil-works/pi-coding-agent` extensions (`pi.registerTool`, `pi.on("tool_call")`, …).
    Every gallery package targets this API. It is built on `pi-agent-core` and is the **stable** surface.
  - `@earendil-works/pi-durable` extensions (`defineExtension({ tools, sections, hooks, tasks })`).
    Durable inbox, child tasks, sleep/wake, idempotent submissions — but **experimental** ("API changes
    without notice"), storage is SQLite/JSONL/memory/Cloudflare only (**no Postgres**), and gallery
    packages cannot load into it.
- The coding-agent **SDK works headless inside a server**:
  - `createAgentSession({ sessionManager: SessionManager.inMemory(), resourceLoader, noTools, … })`.
  - Extensions load through `DefaultResourceLoader({ extensionFactories })` or a custom `ResourceLoader`.
  - `session.bindExtensions({ uiContext })` lets the host implement `ctx.ui.confirm/select/input`,
    so an extension's "ask the user" dialog can become a Mimir approval card or choice card.
  - `session.steer()` / `session.followUp()` / `session.abort()` cover mid-task messages.
  - Events (`message_update`, `message_end`, `tool_execution_*`, `agent_end`, `agent_settled`) stream
    to the host.
  - Extension `tool_call` handlers **can block** a call (`{ block: true, reason }`) — this is where
    Mimir's policy gate lives.
  - The CLI's built-in **MCP**, **tool_search** and **codemode** extensions are available to SDK
    sessions via `createMcpExtension()`, `createToolSearchExtension()`, `createCodemodeExtension()`.

**Decision:** build on the `pi-coding-agent` SDK (stable, ecosystem-compatible). Mimir owns
durability (Postgres session entries + BullMQ), multi-tenancy, and the policy gate. Watch
`pi-durable`; revisit when it is stable and has a Postgres storage adapter.

## Adopt (use as a pinned dependency, after the Phase 1 spike confirms headless + multi-tenant use)

| Package                                   | License    | dl/mo | What Mimir uses it for                                                                                                                                                        | Caveat to verify in the spike                                                                              |
| ----------------------------------------- | ---------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| pi built-in `createMcpExtension()`        | MIT (pi)   | —     | Composio hosted MCP servers and user-added custom MCP servers                                                                                                                 | Per-user server config injected by Mimir, not read from files                                              |
| pi built-in `createToolSearchExtension()` | MIT (pi)   | —     | Deferred tools: keep ~10–15 tools loaded, search the rest                                                                                                                     | —                                                                                                          |
| pi built-in `createCodemodeExtension()`   | MIT (pi)   | —     | Later: code mode over many integration tools                                                                                                                                  | Needs a real sandbox; not before Phase 5                                                                   |
| `@tintinweb/pi-subagents` 0.26.2          | MIT        | 86.6k | Claude Code-style `Agent` / `get_subagent_result` / `steer_subagent`; background by default; completion delivered at the parent's next boundary; concurrency cap (default 10) | Whether children run in-process via SDK sessions; depth limit; tool restriction per child                  |
| `pi-subagents` 0.89.2 (nicobailon)        | MIT        | 1.06M | Alternative to the above: delegation, parallel runs, saved workflows, background jobs                                                                                         | Background children use a **detached Node runner** (extra processes per child) — likely wrong for a server |
| `pi-web-access` 0.48.0                    | MIT        | 1.37M | Web search, URL fetch, PDF extraction for research tasks                                                                                                                      | Output is untrusted → must be tagged for the taint gate                                                    |
| `@capdiem/pi-todo` 0.3.2                  | MIT        | —     | `update_plan`-style todo tool (snapshot plans, three states, stale-write guard)                                                                                               | That state is stored in session entries, not files                                                         |
| `@amaster.ai/pi-telemetry` 0.1.40         | Apache-2.0 | 5.4k  | Langfuse / OpenTelemetry traces, time-to-first-token, token and cost accounting                                                                                               | Reads config from `~/.pi/agent/settings.json`; may need to fork the config loader                          |

Pick **one** subagent package in the spike. Mimir's own long-lived background agents (watchers,
routines) stay on BullMQ either way, because in-process children die with the process.

## Port (read the source, re-implement the idea inside Mimir)

| Package                                 | License | What to take                                                                                                                                                                                                                                                                                    | Where it lands                                           |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pi-durable-bot` ("Pots") 0.8.8         | MIT     | The closest product to Mimir: an open-source Grok Bot alternative on pi-durable. Decision flow: a DM wakes the agent at once; other events are grouped (3 s after the last one, 20 s max) and go through a judge; busy agent gets new messages steered in; the agent can end with "do nothing". | Phase 2 inbox and response contracts                     |
| `@ai-outfitter/channels` 1.13.1 (alpha) | MIT     | Watchers that wake one session per task **only when a source detects matching work**; the wake is a body-free reference and content is fetched with `channel_read` inside explicit untrusted-content markers.                                                                                   | Phase 2 watchers, Phase 3 injection safety               |
| `@alphacoder-v0/pi-loops` 0.24.2        | MIT     | Loops that wake with their previous notes, run in a clean-context subagent, file findings to an inbox, and optionally pass a second adversarial "verify" subagent before reaching the user.                                                                                                     | Post-harness routines (§5); "nothing to report" handling |
| `pi-schedule-prompt` 0.5.1              | MIT     | The `schedule_prompt` tool contract: recurring (cron/interval), one-shot, idle jobs; optional per-job model in a separate session. Its timers are in-process, so re-implement on BullMQ.                                                                                                        | Phase 2 `schedule` tool                                  |
| `@gotgenes/pi-permission-system` 42.2.0 | MIT     | Allow / ask / deny gates over tools, MCP servers and skills; hides disallowed tools before the run. Config is a single file and the package has 267 releases (heavy churn), so port the model instead of depending on it.                                                                       | Phase 3 policy gate                                      |
| `pi-hermes-memory` 0.11.0               | MIT     | Secret scanning before a memory write; search over past sessions; background learning every N turns; procedural "how I solved it" notes.                                                                                                                                                        | Phase 5 integration safeguards; no engine port            |
| `pi-observational-memory` 3.1.4         | MIT     | Cache-friendly tiered compaction with observations and reflections. Compare against pi's built-in compaction first.                                                                                                                                                                             | Phase 5 compaction                                       |
| `@trevonistrevon/pi-loop` 0.8.2         | MIT     | Loop/monitor/workflow vocabulary. Its own docs say wakes are memory-only and it runs only while pi is active — not durable, so reference only.                                                                                                                                                  | Phase 4                                                  |
| `@onkernel/browser-loop` 0.12.1         | MIT     | Framework-neutral browser tool catalog with a `pi-agent-core` binding, running on Kernel browsers. Option to replace Browserbase, or port the catalog onto Browserbase.                                                                                                                         | Phase 3 browser tool                                     |
| `betterwright` 2.9.1                    | MIT     | Policy-guarded browser with trusted credential filling. Electron peer dependency, so not for the server.                                                                                                                                                                                        | Post-harness Vault (§2)                                  |
| `@alexeiled/pi-model-router` 0.25.0     | MIT     | Classifier-based model routing with soft budgets. Note: switching models mid-conversation breaks the prompt cache.                                                                                                                                                                              | Phase 5 model tiering                                    |

## Skip

| Package(s)                                                                                                             | Why                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `agents-cron`                                                                                                          | AGPL-3.0 — copyleft over the network; incompatible unless Mimir is AGPL                             |
| `personal-bot`, `@nothumanwork/pi-memory`                                                                              | No license — cannot legally reuse                                                                   |
| `@agimon-ai/po-*`                                                                                                      | BUSL-1.1 and alpha builds                                                                           |
| `billion-context` (~4M dl/mo)                                                                                          | 10,328 published versions since Aug 2026 (automated publishing); try pi's built-in compaction first |
| `pi-mcp-adapter`, `pi-mcp-extension`                                                                                   | pi now ships a built-in MCP extension                                                               |
| Gmail / Google / Calendar / Outlook packages (`@nexionsoftware/pi-gmail`, `pi-google-services`, `pi-codex-outlook`, …) | Single-user local OAuth; Mimir uses Composio multi-tenant connections                               |
| Telegram / WeChat / Slack bridges (`@llblab/pi-telegram`, `pi-wechat-assistant`, …)                                    | Chat channels are out of scope until after the harness; Mimir has its own web/desktop UI            |
| Desktop / terminal notification packages                                                                               | Mimir already has Web Push and Tauri notifications                                                  |

## Rules for third-party pi packages

1. **Pin exact versions** in `package.json` (no `^`/`~`). Upgrades go through a PR that links the
   upstream diff.
2. **Read the source before adding or upgrading.** pi's own docs warn that packages execute code and
   can ship skills that tell the model to run programs; OpenClaw's skill marketplace had hundreds of
   malicious skills in 2026.
3. **Load only from an explicit list** in Mimir's `ResourceLoader`. Never discover extensions, skills or
   settings from `~/.pi` or project directories in the server.
4. **Keep credential handling, approvals and memory authorization in Mimir.** Port those policy
   boundaries rather than delegating them to a pi extension. Memory engines/SDKs may be adopted
   behind Mimir's adapter after the Phase 7 comparison; do not port a new memory engine.
5. **Record each decision** (adopt / port / skip, with the reason) in this file.

## Memory direction (2026-11-23)

The active plan now calls for adopting an existing memory system after comparing
Mem0, Letta, Cognee, Supermemory and Graphiti. Phase 5 prepares context and
integration contracts; trials and the comparison report happen in Phase 7 after
staging readiness. Memory-related ideas in the port survey are references for
integration requirements, secret filtering and compaction, not a commitment to
build a custom memory engine. No candidate or memory package is selected yet.
See [the evaluation protocol](../memory-evaluation-plan.md).

## Phase 1 decisions (2026-11-22)

- Adopted `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` **1.6.0**, pinned exactly. Read the SDK/session manager, resource loader, extension runner and built-in tool-search source. Confirmed headless operation on Bun, inline extensions with `noTools: "builtin"`, in-memory session rehydration and a bound host UI. Scripted tests cover the protocol without network; `evals/harness` exercises the real configured model using synthetic integrations.
- Adopted pi's built-in `createToolSearchExtension()` from the same pinned SDK. Read `extensions/tool-search/{index,tool}`: it uses local BM25 over deferred metadata and only activates tools already registered in the session. Mimir's gate still checks the discovered tool when it is called. No MCP server or coding tool is loaded in Phase 1.
- Selected **`@tintinweb/pi-subagents` 0.26.2 as the Phase 4 port reference**, after reading `agent-runner`, `agent-manager`, `nested-tools`, and the extension entry point from its MIT npm tarball. Children use `createAgentSession()` in-process, with tool narrowing and nested-call gates. Direct adoption is unsuitable: its loader reads project/user settings, custom agent files and MCP config, and can persist filesystem sessions. Port its SDK-child and result contracts into Mimir's explicit resource list and Postgres/BullMQ ownership; do not install or load the package. The detached-process alternative remains skipped for server use.
- The interaction prompt copies OpenClaw's MIT [Execution Bias](https://github.com/openclaw/openclaw/blob/main/src/agents/system-prompt-policy-sections.ts) and [Promised Work](https://github.com/openclaw/openclaw/blob/main/src/agents/promised-work-prompt.ts) sections, with an explicit Phase 1 limitation on future work.

## Phase 2 decisions (2026-11-22)

- **Port, do not install: `pi-durable-bot` 0.8.8.** Read its npm source `dist/bot/{definition,bot,prompt}.js` and `dist/agent/agent.js`: bounded debounce, explicit wake reasons and busy-session steering. Mimir uses Postgres typed inputs and its existing BullMQ/Redis ownership rather than pi-durable storage or the package's filesystem/desktop runtime.
- **Port, do not install: `@ai-outfitter/channels` 1.13.1.** Read `extensions/channel-tools.ts`, source types and `task-plane/wake-queue.ts`. Ported body-free occurrence references and an explicit `channel_read` boundary. Durable observations and owner checks live in Mimir; source content uses the existing central untrusted-result wrapper.
- **Port, do not install: `pi-schedule-prompt` 0.5.1.** Read `src/{tool,types,scheduler}.ts`: once/interval/cron/idle timing, list/update/enable/disable/remove, and loop prevention. Mimir owns Postgres definitions and BullMQ scheduling, defaults to the user's timezone, and loads no local storage, TUI, arbitrary extensions or per-job skills. Jobs use the configured interaction model; per-routine model selection remains future configuration.
- Re-read the pinned pi 1.6.0 `AgentSession.steer`/`followUp`/`abort` implementation. Steering queues inputs after the current tool batch; the owner polls durable inputs across worker processes. No dependency version, ResourceLoader list or filesystem discovery setting changed.

## Phase 3 decisions (2026-11-23)

- Reuse the pinned pi 1.6.0 inline tool hooks and explicit resource loader. Mimir owns approval records, exact argument snapshots, pause/resume and the write-ahead action journal. No third-party approval, credential or MCP extension is installed or discovered.
- Custom streamable-HTTP MCP tools are adapted into ToolSpecs and always require a card. Fixed Composio inner-action metadata determines the risk shown for single calls and batches; unknown inner actions remain high risk. Tool annotations and descriptions cannot grant read-only privileges.
- Provider requests retain the existing Composio/Nango transport. Email drafts are Mimir-owned inert records; a reviewed send transmits the exact saved message through the connected Gmail account. Hosted browser submissions retain domain and budget checks and require a card. No dependency version changed.

## Phase 4 decisions (2026-11-23)

- **Port, do not install: `@tintinweb/pi-subagents` 0.26.2** (selected in Phase 1). Ported its in-process child contract: each delegation is a fresh `createAgentSession()` through the same pinned pi 1.6.0 runtime, explicit resource loader and inline extension, with a narrowed tool list and the parent's abort signal. Mimir owns the rest: `AgentRun` rows with parent/root/depth, BullMQ jobs for background agents, runtime-set result status, inbox delivery, budgets and cascade cancel in Postgres. Its settings/agent-file/MCP discovery and filesystem sessions are not used. No dependency was added or upgraded.
- `pi-durable` remains unadopted: background agents need Postgres ownership, per-user limits and Mimir's inbox, which it does not provide. Revisit only if pi-durable gains a pluggable store.

## Phase 5 decisions (2026-11-23)

- Reuse the pinned pi **1.6.0** compaction, session projection and context-edit APIs. Read `dist/core/compaction/compaction.js`, the session manager and `AgentSession` compaction/prompt paths. Native checkpoints retain the raw journal; append-only context edits clear older tool results. A pre-prompt projection check also covers zero-usage legacy history and Mimir's smaller configured context window.
- Use the exported native `compact()` with the original physical model, runtime auth and stable routing session ID. Summarization with an artificially small model window can collapse the output budget; extension exceptions can trigger fallback behavior, so a failed custom hook explicitly cancels compaction. Summarization usage is included in Mimir's run budgets and logs.
- Do not install `pi-observational-memory` or port a replacement extraction engine. Mimir owns output references, scoped provider contracts, migration inputs, credential filtering and measurement; external backend trials remain Phase 7. No dependency version, discovery setting or ResourceLoader allowlist changed.
