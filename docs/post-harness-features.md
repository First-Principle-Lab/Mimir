# Post-harness feature backlog

Features to build **after the new harness is ready**. Collected from
[SuperBot](https://github.com/davidondrej/superbot) (a self-hosted Grok Bot clone, MIT,
created 2026-11-15) and its `grok-bot-internals/` notes on how xAI's Grok Bot works
(sourced from https://docs.x.ai/grok-bot/overview, checked 2026-11-15).

Each item says where the idea comes from, what Mimir has today, and what to build.
Priority: **P1** = build first once the harness is stable, **P2** = next, **P3** = later / optional.

---

## 1. Approvals layer (P1)

**Source:** Grok Bot "Auto Review" + "Custom Rules" + approval cards.

How Grok Bot does it:
- Every action (command, app call, computer use) passes a **model-based review** before it runs — not a fixed allowlist. On by default.
- Users write plain-English rules, two kinds:
  - **Ask first** — always stops a matching action ("Ask first before sending any external email").
  - **Allow automatically** — lets it run unless the review finds another reason to stop.
  - If both match, Ask first wins. Max 20 of each, 1,000 chars each. Team rules can only be made stricter by personal rules.
- Built-in safety checks always apply, regardless of rules.
- Approval card buttons: **Allow once** (no rule saved), **Always allow** (run + save an Allow rule), **Deny** (don't run; don't retry until the user sends another message).
- Cards can carry warnings ("This can't be undone").
- Card from a chat waits forever; card from a routine/background work **expires after 30 minutes**.
- Sending a new message closes open cards in that chat.
- In group chats only the requester can approve.
- What to gate by default: sending messages/invites, publishing, purchases/money, deleting/overwriting data, changing permissions, production changes, accepting legal terms.

Mimir today: per-tool confirmation gates hard-coded in each integration (calendar 5.6.3, email draft→confirm, browser 5.9.4).

Build:
- One `ApprovalPolicy` evaluated by the harness before every consequential tool call (replaces the per-tool gates).
- `ApprovalRule` table (`userId`, `kind: ask_first|allow_auto`, `text`, `createdAt`), editable in settings and via chat.
- Tool metadata: `consequential: boolean`, `reversible: boolean`, `warning?: string`.
- Approval card message type with Allow once / Always allow / Deny; TTL 30 min for background origin.

## 2. Secrets never reach the model (P1, needed before browser logins)

**Source:** Grok Bot Vault / 1Password / Secure Forms / human takeover.

- Login lookup order: **Vault → 1Password → Secure Form** to the user. In all three the value is filled into the page directly; the model never sees it.
- API keys: secure secret card — masked, kept out of the transcript, not shown to the model.
- One-time codes: read from connected Gmail/Outlook.
- OAuth tokens stay on the backend (Mimir already does this via Composio).
- Logins, cards and contact info go in Vault, **never in memory**.
- **Human takeover** for SSO/passkeys, CAPTCHAs, QR codes, bank verification: user clicks "Take control", does only the blocked step, clicks "I'm done", Bot continues.

Mimir today: browser tool (Browserbase) has no credential handling; no takeover flow.

Build: `Vault` (encrypted per-user secrets, referenced by handle in tool calls, substituted server-side); Secure Form message type; Browserbase live-view takeover.

## 3. User-visible, user-editable memory (P1)

**Source:** Grok Bot memory behavior; SuperBot `MEMORY.md` + shared `USER.md`.

- The assistant decides on its own what to save (doesn't ask first).
- User can ask "What do you remember about me?", correct, or forget things **in chat**.
- Memory holds: preferences, lasting rules ("always ask before sending email"), facts about the user, a **dated log of past work**.
- A few facts are **global** (name, time zone) — tell one place, everywhere knows.
- Rules from xAI: memory is not a source of truth (re-check prices and changing numbers); secrets never in memory; back safety rules with approvals, not memory alone.
- Reset conversation → memory kept. Delete agent → its memory deleted. Delete account → all deleted.

Mimir today: `ExtractedFact` rows (pgvector, supersede-on-conflict, relation graph) — but no way for the user to see, correct, or delete them.

Build: `remember` / `forget` / `list_memories` tools in the harness; a settings view of facts; mark facts as `scope: global|agent`; "work log" entries per agent; memory-rule → approval-rule promotion.

## 4. Skills library (P2)

**Source:** Grok Bot skills; SuperBot `.agents/skills/`.

- **Skill** = reusable instructions for how to do a task. One private library shared by all agents, enable-able per agent.
- A good skill states: when to use it, inputs and access needed, steps, how to check the result, what to return, what needs approval.
- Workflow: **get the task working once → save it as a skill → schedule it.**
- **Teach a task:** user does a browser workflow once while the bot records the screen (≤10 min); the bot drafts a skill from it.
- Skills need a description — the model uses it to decide when a skill applies.

Mimir today: none. Triggers (4.11) cover scheduling, not reusable procedures.

Build: `Skill` table (`name`, `description`, `body` markdown, `enabledFor`), `save_as_skill` tool after a successful task, skill descriptions injected into the harness so it can pick one; later, record-to-skill from Browserbase sessions.

## 5. Routines with richer triggers (P2)

**Source:** Grok Bot routines; SuperBot `botctl` cron.

- Created by asking in chat; edited in chat ("Edit your routine: …"). Can be paused, resumed, edited, deleted.
- Each routine = **Instruction** + **When to run**.
- Triggers: plain-words schedule (user time zone), Slack (mention/phrase/reaction), **GitHub / Linear / Sentry / PagerDuty events**, email to the bot's own address (optionally filtered by sender), **inbound webhook** (`Authorization: Bearer <key>`; `200` = started, not finished).
- New routine waits for its next time; **Test** button runs it now (real work).
- Only new events trigger it; old events don't.
- Self-scheduling: agents can create their own routines (SuperBot: bots run `botctl` from their shell).

Mimir today: Triggers (4.11) with cron/reminders + Gmail/Calendar/GitHub watching.

Build: unify triggers as `Routine { instruction, when, skillId? }`; add generic inbound webhook trigger + Linear/Sentry event triggers; "Test now" action; per-routine pause/resume in UI.

## 6. Named, long-lived agents with one job (P3 — product decision)

**Source:** Grok Bot Bots; SuperBot team of bots.

- A Bot = name, picture, label, **one clear job**, its own conversation, its own growing memory.
- A **primary Bot** is the main contact: checks in on its own, coordinates the others, hands them work, and **creates new focused Bots when a job keeps coming back**.
- Bots message each other directly and can join group chats; they pass context via messages and shared files.
- Personal Bots have no settings page — change them by telling them in chat.
- Templates: share a Bot's identity + skills + routines (never its logins, computer, or history).
- SuperBot specifics: 12 robot avatar shapes × 11 colors; per-bot model + reasoning-effort picker.

Mimir today: ephemeral task agents (spawned per task, go dormant). Different model; decide deliberately whether to move to persistent personas.

## 7. Bot-to-bot handoff and ask (P3)

**Source:** SuperBot `botctl ask "<Bot>" "<message>"` / `botctl handoff`.

- One agent asks another; the other answers in its own chat and the reply returns to the caller.
- If it takes over ~9 minutes, the reply arrives later as a new message instead of blocking.
- `handoff` posts a question to the user and blocks until they answer.

Mimir today: orchestrator/worker fan-out (Phase 9) inside one task; no agent-to-agent messaging across tasks.

## 8. Choice cards (P2, small)

**Source:** SuperBot.

- A reply ending in a ` ```question ` JSON block renders as a multiple-choice card; the user's pick is sent back as `answer: {messageId, option}`.
- Cheap way to resolve ambiguity instead of a free-text clarification round-trip.

Build: `ask_user(question, options[])` tool in the harness → card message type.

## 9. Restart safety: interrupted, not re-run (P1, correctness)

**Source:** SuperBot runner.

- Queued messages run after a restart. A task that was **mid-run** is reported as **interrupted**, not re-run, so it can't repeat a side effect like sending an email.

Mimir today — known bug to fix with this:
- `apps/worker/src/email/email-send-job.ts:95` publishes "The email couldn't be sent…" on **every** failed attempt, but the job retries 5× (`queues.ts:30` → `retryPolicy`), so a flaky send can post up to 5 failure messages. The comment says "retries exhausted" but the code doesn't check `job.attemptsMade`.
- A crash between `sendGmailDraft` and `markEmailAction("executed")` reports a false failure (Gmail already consumed the draft).

Build: side-effecting tools record an `ActionAttempt` (idempotency key, `started|done|failed|interrupted`) before executing; on retry/restart, an attempt in `started` state is reported as interrupted and needs user re-confirmation instead of blind retry.

## 10. Prompt-injection provenance marking (P1, in the harness itself)

**Source:** Grok Bot.

- Only the user's own messages count as instructions. Text from emails, web pages, files is information.
- **Each message the model reads is marked as from the user or from someone else.**
- xAI: lowers risk, doesn't remove it.

Mimir today: per-prompt "UNTRUSTED DATA" wording (commit `588b2ad`). Build into the harness: every context item carries a `source: user|tool|external` tag rendered consistently, and consequential actions triggered while external content is in context go through approvals (#1).

## 11. Smaller items

- **Notify when done while away** (Grok Bot): background work continues with the app closed and the user gets a notification on completion — Mimir has Web Push (11.1); make sure every long task completion routes through the delivery decision (11.4).
- **Bot email address** (Grok Bot): each assistant gets its own inbox — users forward things to it; also a trigger source (#5) and an OTP source (#2).
- **Per-agent model / effort picker** (SuperBot): saved per agent; unset = default.
- **Live "what it's doing" status** (SuperBot): stream "Running: search_email…" status lines to the chat while an agent works.
- **Harness-agnostic adapters** (SuperBot): not needed — Mimir owns its harness. Noted only as a contrast.
- **Each bot gets its own browser screen / live view** (Grok Bot, SuperBot `screen.rs`): parallel computer use; not a security boundary. Pair with human takeover (#2).
- **Chats live outside the compute environment** (Grok Bot): wiping the machine loses no conversations — Mimir already stores everything in Postgres.

## What NOT to copy

- Running agents with permissions skipped on a shared machine (SuperBot runs `--dangerously-skip-permissions`) — incompatible with Mimir's multi-tenant design (14.5).
- Plain-text memory files re-sent in full every run — a step backwards from Mimir's retrieval-based facts.
- Shared sign-ins across all agents (Grok Bot caveat: one bot signs in → all are signed in) — scope credentials per user and per tool call.
