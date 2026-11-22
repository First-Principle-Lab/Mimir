# Phase 3 implementation review

Scope: the full safe-write phase across ToolSpecs and pi, provider transports,
approval intake/UI, durable inbox resumption, action recovery, migration and
visible output. Phase 4 has not started. The completion gate is pending the
published full real-inference evaluation and required PR CI.

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
    currently have an email sending tool". Regression tests now accept those
    limitations and still reject fabricated success. The read-only suite also
    explicitly forbids all current write-tool names, including email_send.
11. The final error-path audit found that a resumed action's provider exception
    could reach the model without the central untrusted wrapper. A regression
    reproduced the missing wrapper before the fix. Resumed external actions now
    taint context before execution and centrally wrap errors too. The additional
    live scenario injects instructions after provider acceptance and checks that
    the attempt stays interrupted, no further action/card appears, replay does
    not repeat it and the user is told to verify the uncertain outcome.

## Verification and limits

- Frozen install, lint, workspace typecheck, all **253 tests** (forced uncached),
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

Pending a fresh full harness run and required PR CI. The initial published run
on `e8ac502` is preserved as
`eval/2026-11-22-harness-phase-3-safe-writes-completion-review` (31/32 scenarios;
the digest-clock evaluation finding above). The `-2` run on `b16d48a` records the
two read-only scoring findings (10/12 Phase 1 scenarios; later groups did not
run). The `-3` run on `8182a80` passes 32/32 scenarios and all 12 red-team checks;
the error-path fix above requires fresh published evidence. Earlier exploratory
checks do not replace the published completion gate.
