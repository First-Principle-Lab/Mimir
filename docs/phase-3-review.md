# Phase 3 implementation review

Scope: the full safe-write phase across ToolSpecs and pi, provider transports,
approval intake/UI, durable inbox resumption, action recovery, migration and
visible output. Phase 4 has not started. The requirement audit, scripted checks
and published real-inference evaluation pass. Required CI and final completion
status are recorded in [PR #5](https://github.com/First-Principle-Lab/Mimir/pull/5).

## Requirement audit

| Requirement                          | Implementation and verification                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed risk tiers and taint           | Every capability remains a ToolSpec. Both the pi tool-call hook and executor enforce fixed policy. Reads are allowed; internal reversible actions are journaled; external communication, destructive/identity/code capabilities and custom MCP require exact-argument cards. Untainted private calendar creation can proceed; an untrusted read makes later external writes require review. Session hydration restores taint from centrally wrapped output. |
| Composio inner actions               | Fixed explicit action metadata resolves every inner call and takes the highest batch risk; unknown actions stay high risk. Custom MCP always requires a card even when it claims to be a read. Server schema descriptions cross the untrusted discovery boundary too.                                                                                                                                                                                       |
| Exact approval cards                 | The database snapshots normalized tool arguments, provenance, risk, reason and a hash. The web renders those stored arguments as escaped text. Authenticated decisions cannot replace arguments, must match the hash and owner, and expire after 24 hours. A new user correction or stop cancels older pending/approved cards.                                                                                                                              |
| Waiting and resumption               | A proposal finishes its chat reply and leaves its existing run waiting_human without occupying a worker. A typed durable approval_answer resumes that same run, revalidates the exact snapshot and capability, executes once, then continues pi with its actual result. Declines, expiry, changed actions and ownership mismatches execute nothing. Usage accumulates across proposal and resumption.                                                       |
| Journal before side effects          | A unique ActionAttempt insertion commits before invoking each mutating tool. Keys derive from the user/draft for sends and run/tool/normalized arguments otherwise. Concurrent calls and new model call IDs cannot repeat an action. Retried success returns the recorded result.                                                                                                                                                                           |
| Crash/abort handling                 | An unfinished attempt becomes interrupted and is never automatically retried, even if the provider accepted it. A real subprocess SIGKILL verifies this boundary. A success already committed before a card-status crash is recovered from the journal. Stop and recovery replies report actual uncertainty.                                                                                                                                                |
| Unattended email                     | email_draft stores an inert Mimir-owned message. email_send expands its actual recipient/subject/body into the card and checks ownership and content again before a single Gmail send. Ambient work cannot send automatically. Drafts remain unsent on rejection or interruption.                                                                                                                                                                           |
| Central untrusted boundary and links | All untrusted results/errors, observations, worker text and custom discovery use the central wrapper. Chat final text, streamed text and notifications use one output sanitizer: only fixed product domains, explicit configured domains and domains from native user messages may appear as links. Tool output cannot grant a domain. Remote chat images are disabled in the renderer too.                                                                 |
| Write tools                          | Connected Gmail draft/send; calendar create/update; Notion create/rename; GitHub issue create/comment/update; bounded hosted-browser form submission; owner-scoped custom MCP. Provider paths and schemas are fixed. Arbitrary local execution/stdio is not exposed.                                                                                                                                                                                        |
| Exit criteria                        | Scripted crash and replay checks observe zero duplicated effects; redteam.ts passes policy/meta-tool/output-exfiltration checks. The full live-model gate and required CI are recorded below when published.                                                                                                                                                                                                                                                |

## Findings and resolutions

1. The first live exploratory browser case self-refused without discovering its
   deferred tool. The prompt now explains the write capabilities and requires
   relevant tool discovery before claiming unavailability. The affected live
   browser case then passed through approval, execution and socket delivery.
2. Approval resumption initially overwrote the proposal's usage totals. The run
   now accumulates both phases, with a regression assertion on the same run.
3. A crash between a committed successful attempt and its approval status update
   could incorrectly report uncertainty. Recovery now reconciles the recorded
   success without executing again.
4. A model tool-call ID reused with different arguments must not replay an
   unrelated success. The journal checks argument identity as well as its key.
5. MCP server tool names can exceed model API limits. Stable hashed names are
   capped at 63 safe characters; provenance retains the server/tool identity.
   MCP tool failures are errors and cannot become reported write successes.
6. Custom discovery metadata can itself contain instructions. Discovery output
   is marked untrusted whenever custom MCP schemas are present, preserving taint
   even before the first server invocation.

7. A notification receipt could arrive after the same run resumed an approval
   and replaced its latest reply ID. Inbox inputs now retain the original
   notification ID, so late receipts still update the correct routine occurrence.
8. Private-calendar auto-approval must not extend to arbitrary shared calendars.
   A non-primary calendar now requires a card even when there are no attendees.
9. The first published run passed 31/32 scenarios but checked the unattended
   draft notification before a legitimate low-priority digest was due. The
   evaluator now advances its delivery clock past that window and retains the
   authenticated socket-receipt requirement. The affected live rerun passed
   with low urgency, an unsent draft, no provider calls and a socket receipt.
10. The next published run rejected two truthful read-only replies because the
    deterministic scorer did not recognize "only have read access" or "don't
    currently have an email sending tool". A later run also exposed "couldn't
    find an email-sending tool". Regression tests now accept these common
    limitations and still reject fabricated success. The read-only suite also
    explicitly forbids all current write-tool names, including email_send.
11. The final error-path audit found that a resumed action's provider exception
    could reach the model without the central untrusted wrapper. A regression
    reproduced the missing wrapper before the fix. Resumed external actions now
    taint context before execution and centrally wrap errors too. The additional
    live scenario injects instructions after provider acceptance and checks that
    the attempt stays interrupted, no further action/card appears, replay does
    not repeat it and the user is told to verify the uncertain outcome.
12. CI's fresh web build exposed a failure in Next's Google Fonts download path
    that the local font cache had hidden. A clean Webpack build also reproduced
    the font-loader failure. Archivo and DM Sans are now local WOFF2 assets with
    their SIL licenses and source checksums, retaining the existing families,
    CSS variables and weights. The default Turbopack static build passes without
    the old cache. No agent behavior changed after the passing evaluation.

An independent pre-merge review (2026-11-23) re-read the full phase diff and
found two more defects, both fixed in `b135214` with regressions that fail on
the previous code:

13. `calendar_update_event` defaulted `attendees` to `[]` and PATCHed it, so an
    approved time change silently removed every guest (with `sendUpdates:
    none`, nobody was told). Omitted attendees are now left unchanged, a listed
    set replaces them, and approved updates notify existing guests.
14. The journal's `(runId, toolCallId)` uniqueness relied on provider call IDs.
    pi 1.6.0 passes them through unchanged: empty when a provider omits one, and
    per-message indices such as `functions.x:0` for some providers. A second,
    different action in the same run was then refused as an ID reuse. Journal
    rows now get a Mimir-unique call ID; exactly-once still comes from the
    action's idempotency key, which is unchanged.

The review also re-checked, without finding defects: approval ownership and
hash races, decline/expiry/cancel paths, same-run resumption, recovery of
`executing` approvals, taint restoration on hydration, Composio inner-action
risk, the accumulated-text stream sanitizer and the approval card's escaped
rendering. Design choices noted but not changed: every new chat message cancels
all pending cards in the conversation, including cards raised by ambient work;
provider 4xx responses are recorded as interrupted (uncertain) rather than
failed.

Found after merge, while building Phase 4:

15. Zod 4's `toJSONSchema()` defaults to output mode, so fields with defaults
    (`calendarId`, `attendees`, issue `body`, page `text`) were required in the
    schemas pi validates calls against, and the server-side defaults never
    applied. Fixed in [#7](https://github.com/First-Principle-Lab/Mimir/pull/7)
    with a regression test; its eval
    [`eval/2026-11-23-harness-tool-schema-defaults`](https://github.com/First-Principle-Lab/Mimir/tree/eval/2026-11-23-harness-tool-schema-defaults)
    passed 33/33 scenarios and 12/12 red-team checks, and the integrated
    Phase 3–4 gate `eval/2026-11-23-harness-phase-3-4-completion` passed on the merged tree.

## Verification and limits

- Frozen install, lint, workspace typecheck, all **255 tests** (forced uncached),
  duplication check and static web export pass locally. All three evaluation
  scripts pass a focused TypeScript check. Both schema migrations are forward-only.
- A fresh temporary database was upgraded through Phase 2, seeded with synthetic
  chat and an old ActionAttempt, then upgraded through Phase 3. History and the
  old journal survived, old idempotency keys were backfilled, both new tables
  existed and draft ownership/cascade constraints were installed. The database
  was removed afterward.
- Scripted tests cover ownership, decision/hash races, cancellation, expiry,
  draft contents, invalid provider paths, exact-once insertion, provider-response
  loss, actual SIGKILL recovery and same-run pi resumption. Real inference uses
  synthetic accounts/providers; no real account receives a write. The existing
  provider integration tests remain in place. A real hosted browser deployment
  still requires its configured Browserbase credentials and budget.
- Receipts prove client/provider acceptance, not human reading. Provider timeouts
  deliberately favor uncertainty over automatic retry. Drafts are stored in
  Mimir and are not copies in Gmail's Drafts folder.
- No dependencies were added/upgraded; pi remains pinned at 1.6.0 with the same
  explicit resource loader and discovery settings. Desktop Linux packaging's
  existing linuxdeploy limitation remains outside this static-export CI gate.

## Published evidence

The passing run is
[`eval/2026-11-23-harness-phase-3-review-fixes-3`](https://github.com/First-Principle-Lab/Mimir/tree/eval/2026-11-23-harness-phase-3-review-fixes-3).
It tests commit `b1352144202d2450a115b800e6c9a945c16760a3` with actual OpenRouter
inference using `~deepseek/deepseek-v4-flash-latest`:

- **33/33 scenarios pass:** 12 Phase 1, 11 Phase 2 and 10 Phase 3 cases.
- **12/12 red-team checks pass.** Crash/replay checks observe no duplicated effect.
- HTTP intake, BullMQ, pi, journals, exact-argument approvals, same-run resumption
  and authenticated socket delivery run through the implemented path. Account
  reads and provider/browser responses are synthetic; no real account is changed.
- Later commits only record this evidence. The API, worker, tools, prompts,
  migrations and evaluation code match the tested commit.

Earlier immutable runs retain the findings and their fixes. The initial run on
`e8ac502` is preserved as
`eval/2026-11-22-harness-phase-3-safe-writes-completion-review` (31/32 scenarios;
the digest-clock evaluation finding above). The `-2` run on `b16d48a` records the
two read-only scoring findings (10/12 Phase 1 scenarios; later groups did not
run). The `-3` run on `8182a80` passes 32/32 scenarios and all 12 red-team checks;
the `-4` run on `9356fca` records the additional refusal-scoring finding (11/12
Phase 1 scenarios; later groups did not run). The `-5` run on `51d8ff0` passed
33/33 before findings 13–14. On `b135214`,
`eval/2026-11-23-harness-phase-3-review-fixes` recorded 32/33: in
`declined-invitation` the model returned two empty responses after tool
discovery and never reached the calendar tool. That scenario then passed 4/4
isolated reruns. Its `-2` run is void: another process switched the shared
checkout mid-run, so the safe-write script was missing. The `-3` run, from an
isolated worktree, is the passing gate. Earlier exploratory checks do not
replace it.
