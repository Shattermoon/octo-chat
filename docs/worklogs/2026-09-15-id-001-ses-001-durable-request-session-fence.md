# ID-001 / SES-001 — durable request ownership and session deletion fence

**State:** REVIEW
**Audit IDs:** ID-001, SES-001
**Branch:** `fix/id-001-ses-001-durable-request-session-fence`
**Base:** `47117219b2a478b884f5369666911be202d4bdac` (PLATFORM-002 merged)
**Queue transition:** `9bf541e712466bdf04385399f433b7ab77a62a8e`

## Invariants

### ID-001 — request ownership

Once exact browser evidence proves `(requestId, conversationId, localSessionId)`, that first owner is
permanent authority. Diagnostic labels may be bounded or discarded, but capacity pressure, elapsed
time, restart, downgrade/re-upgrade, stale snapshots or a later contradictory page must never move or
erase the owner.

The browser `/correlations` handshake may report a request ID as confirmed only after that first-owner
fact crosses its durable commit boundary. A failed or ambiguous journal append publishes no owner and
wakes no waiter. Concurrent first claims serialize: one wins and every later different-conversation
claim is an explicit conflict.

### SES-001 — session deletion

Deletion is a lifecycle transition, not `rm -rf`. Once deletion starts, no new reconstruction, queued
mutation, asset/handoff write, session creation or conversation-based replacement may be admitted for
that retiring session or its current/historical ChatGPT lineage.

The semantic commit point is an atomic same-directory rename from the canonical session folder to an
ignored tombstone. Work admitted before the lifecycle flip drains first. Cleanup of the tombstone is
best-effort after commit. If the rename itself fails, the canonical directory is intact; lifecycle,
derived attachment ownership and negative conversation caches are restored before new creation may
proceed.

## Re-confirmed findings

At the merged base:

- request-owner facts and diagnostic context lived in the same bounded 50,000-entry registry, so
  capacity eviction could turn a previously owned request ID back into an unowned ID and allow another
  conversation to claim it;
- browser ownership was acknowledged before the debounced durable snapshot landed, leaving a crash
  window where an acknowledged bare request owner could disappear;
- restart recovery trusted a bounded/stale legacy snapshot plus a limited history window and therefore
  could not provide the promised permanent owner semantics;
- session deletion waited only for one captured open-session queue, without fencing concurrent cold
  reconstruction/reconciliation, direct asset/handoff writers, creation initialization or later queue
  admission;
- recursive removal was itself treated as deletion, so a failed partial remove could not safely roll
  lifecycle back; and
- recorder/IPC ownership could be detached before filesystem deletion had actually committed.

## ID-001 implementation

- Permanent authority is an unbounded in-memory `requestId -> { conversationId, sessionId }` map.
  Human/debug fields remain independently bounded and may be evicted without changing authority.
- New owners enter through a serialized async admission path. The append-only `request-owners.jsonl`
  journal commits before the owner is inserted into the live map or any exact-ID waiter is woken.
- Security-journal reads are fail-closed: only `ENOENT` means empty. Unknown schemas, malformed
  newline-terminated rows and conflicting committed owners abort restore.
- A final unterminated crash fragment is ignored. Before a later append, that torn tail is truncated
  back to the last committed newline. If `appendFile` rejects after writing some/all bytes, the journal
  rolls back to its exact pre-append length; failed rollback poisons new owner admission for the process.
- Journal authority always outranks legacy v3-v5 state. The old bounded snapshot is strict-read on
  startup only as fallback for IDs that neither journal nor retained exact history can recover. Valid
  owner fields are salvaged independently of diagnostic labels.
- Downgrade/re-upgrade recovery uses a non-authoritative per-session committed-byte watermark over
  `events.jsonl`. New/changed suffixes are parsed strictly for `request_id` tool ownership; recovered
  owners are journaled before the watermark advances. Missing/corrupt/failed watermark state costs only
  performance and causes safe re-scan. File shrink or an invalid byte boundary forces a full-session
  scan; only an unterminated final fragment is ignored.
- For a journal-absent ID, retained exact history and the legacy snapshot may corroborate the same
  owner, but disagreement is ambiguous old-v5 crash evidence and fails closed rather than assigning
  precedence to either source. Conflicting retained-history owners likewise fail closed.
- `/correlations` recomputes confirmation/conflict state after serialized admission, so two chats
  racing one unseen ID cannot both observe an ambiguous pre-commit answer.

## SES-001 implementation

- Every session has process-local lifecycle state and generation: active, deleting, deleted. Mutation
  admission checks active state synchronously; stale reconstruction/open work rechecks generation
  before publishing or writing repaired projections.
- Direct create/asset/overflow/handoff work is registered with the lifecycle before its first
  filesystem await. Deletion drains opening, reconciliation, direct work and the session queue before
  the rename commit.
- Scheduled metadata writes are suppressed while deleting; failed-delete rollback re-arms dirty
  metadata only after restoring active state.
- Explicit deletes coalesce on one transaction. Pruning atomically skips sessions that are open,
  opening, reconciling or have direct work in flight.
- Canonical deletion is `sessions/<id> -> sessions/.deleted-<id>-<uuid>` by same-directory rename.
  Recursive cleanup runs only after that commit and cannot resurrect the canonical path.
- Deletion retains the session's full durable `chatIds` lineage, not merely its current conversation.
  Recorder session creation waits for matching deletion settlement. A completely cold delete marks
  lineage unresolved before reading metadata; while unresolved, conversation creation waits
  conservatively rather than guessing which chat the retiring session owns.
- Generic ownership lookup does not cache a negative answer while matching or unresolved deletion is
  pending. Failed-delete rollback clears the bounded negative cache and invalidates the derived
  attachment catalog before new creation can proceed.
- The second production conversation-creation ingress, browser project binding in session input,
  applies the same delete wait/retry/superseded check before it may create a session.
- Compact & Resume rebind now treats the destination conversation as a deletion-fenced claim: it waits
  through any unresolved delete, rechecks a deletion-fenced miss, and reserves an existing target in
  that target session's direct-work lifecycle before deciding the destination is already occupied.
  Continuation performs the same pre-check; the store-level rebind fence remains authoritative for
  callers that race the pre-check itself.
- IPC keeps recorder attachment and chat-block state until tombstone rename succeeds. A failed commit
  therefore leaves the still-valid recorder epoch and block intact; a retry can delete cleanly.

## Independent design challenges resolved

The ID-001 reviewer challenged the initial implementation on journal read errors, ambiguous append
failure, stale legacy-snapshot precedence, old 100-session/1024-event migration limits, concurrent
HTTP first-owner races, and downgrade writes after a one-time migration marker. The implementation now
uses fail-closed journal semantics, append rollback/poisoning and per-session byte watermarks rather
than a permanent `migration complete` bit. Journal authority always wins. For an unjournaled id,
retained exact history and the legacy snapshot may corroborate one another, but if they disagree on
conversation or first local session epoch migration aborts instead of guessing which old crash order
was the original proof. Multiple retained-history owners for one unjournaled request are equally
ambiguous and also fail closed; event timestamps are never used as ownership evidence. Unambiguous
history-only and snapshot-only owners remain recoverable.

The SES-001 reviewer challenged creation initialization, queue-admission gaps, meta timers, cold
reconstruction, direct asset/handoff work, duplicate deletes, prune races, partial recursive-delete
failure, IPC detach-before-delete, failed-delete negative-cache/catalog restoration, current vs
historical lineage, completely cold-store deletion, the separate session-input project-binding
creation path, and finally a Compact & Resume rebind into a conversation whose existing session was
already deleting. Each identified production path is now fenced or moved behind the atomic tombstone
commit, with deterministic regressions for the race class.

## Local validation before review

- `npm run typecheck` — pass.
- ID-001 focused durability/correlation suite — 39/39 pass after the final streamed-reducer design.
- Specialist ID-001 re-review ran durable/correlation/full bridge coverage — 424/424 pass; no blocker
  in journal authority, strict legacy fallback, downgrade watermark semantics or `/correlations` ACK.
- SES-001 deterministic deletion suite — 13/13 pass, covering paused reconstruction, in-flight create,
  assets, handoffs, duplicate delete/rename failure, failed-delete catalog restoration, cold recorder,
  completely cold-store lineage loading, historical Compact & Resume lineage, deletion starting during
  the recorder's resume-settle wait, delete-vs-meta-flush, prune-vs-open, and rebind-vs-existing-target
  deletion rollback.
- Latest SES/input/IPC/attribution focused set — 108/108 pass.
- Latest ID-001 durability/backend/identity focused set — 59/59 pass.
- Latest session/continuation/correlation/deletion regression bundle — 268/268 pass after the final
  rebind destination fence.
- Full deterministic session/ownership bundle — 8 files, 308/308 pass on the pre-final fence shape;
  the complete `test/session.test.ts` then passed 157/157 again on the final code shape after the
  project-binding/cache and resume-settle/create-admission fences.
- Full `test/bridge.test.ts` — 386/386 pass on the final code shape.
- `npm run verify:privacy` — pass.
- `npm run verify:notices` — pass; 93 production packages, 7 catalog entries and 730 pinned native
  source archives/patches validated.
- `npm run build` — pass.
- `git diff --check` — pass at the latest focused gate.
- The first full local `npm run verify:ci` attempt on pushed review head `6b9d5e3` exposed one
  deterministic harness regression from ID-001: `test/recorder-final-identity.test.ts` exercised real
  page request evidence but initialized only the session store, whereas production initializes the
  durable store immediately afterward and restores request ownership before bridge traffic. The test
  now mirrors production initialization; the file passes 23/23 and typecheck/diff-check remain green.
- That same aggregate run reproduced CI-001-style load sensitivity in unrelated runtime/plugin tests.
  `test/code-mode-runtime.test.ts` passes 14/14 in isolation and `test/plugins-manager.test.ts` passes
  49/49 with its one intentional live-package skip. No production timeout or plugin/runtime behavior
  was changed for those aggregate-only failures.
- CodeRabbit formal review `5211230418` was submitted against superseded head `6b9d5e3` but its three
  production comments still applied to the next head and were revalidated rather than dismissed as
  stale. All three were valid: request-owner history migration allocated the whole unread JSONL
  suffix; read-only lifecycle lookups inserted default rows into `sessionLifecycles`; and a synchronous
  inactive-session throw could escape `flushSessionEntry()`'s promise catch. Migration now streams
  fixed 64 KiB chunks, retains at most one bounded incomplete event row, and reduces exact evidence
  directly into the unique-owner map instead of returning a per-tool-call evidence array; read-only
  lifecycle checks use non-inserting lookups; queue admission preserves its synchronous state check
  but exposes refusal as a rejected promise, with a deletion/meta-flush race regression.
- A separate adversarial exact-head review found a migration ambiguity not reported by CodeRabbit:
  old v5 can leave snapshot owner A while later rebound owner B is present only in attributed history
  if the app crashes before its debounced snapshot catches up. The inverse stale-snapshot shape is also
  possible, so history cannot safely outrank snapshot unconditionally. Migration now fails closed on
  any unjournaled snapshot/history owner disagreement before writing the owner journal or watermark.
  A follow-up adversarial pass found the same ambiguity can exist with two conflicting retained-history
  owners and no surviving snapshot row after repeated v5 eviction; migration now fails closed there too.
- `AGENTS.md` was corrected to name `state/request-owners.jsonl` as permanent authority, the old
  `request-correlations.json` as strict migration fallback, and the 50,000 bound as diagnostic-only.
- A final SES-001 adversarial pass found a rebind TOCTOU that the original deletion suite did not cover:
  `findSessionByConversation()` intentionally returns a deletion-fenced miss, so Compact & Resume could
  treat a deleting destination as free and write a second durable owner. The store now waits for target
  deletion settlement and reserves an existing target through its lifecycle direct-work set; the
  continuation pre-check also joins the same deletion barrier. The new regression proves a failed target
  delete cannot leave both sessions claiming the destination.

## Remaining review/merge gates

The row entered `REVIEW` only after a fresh full session regression on the final code shape, final
ID-001 and SES-001 specialist no-blocker reviews, full bridge/build/privacy/notices gates and clean
`git diff --check`. PR #26 is the review host. The initially pushed `6b9d5e3` and its intermediate
review heads were superseded by the recorder-final-identity harness correction, the validated
CodeRabbit/adversarial production fixes, and the evidence updates above. Merge evidence must use the
final pushed SHA; earlier review/CI runs are supporting history only.

Before merge: the sole repository maintainer performs an exact-final-SHA self-review covering the
ownership, generation, side-effect, crash/revocation and restore invariants; substantive CodeRabbit
findings are validated individually and resolved or explicitly dispositioned; hosted Windows x64 and
Linux x64 CI must be green on the exact review SHA; and parallel AI review tracks are evidence inputs,
not human approvals. Stale formal reviews are dismissed only after current-head evidence is complete.
After merge, run a post-merge audit for bounded owner eviction, uncommitted `/correlations` ACK, stale
migration precedence, session resurrection and deletion-path bypasses before advancing the serial
remediation queue.
