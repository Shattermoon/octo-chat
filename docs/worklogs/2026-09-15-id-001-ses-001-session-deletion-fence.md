# [WIP][ID-001][SES-001] Durable request ownership and session deletion fencing

**Owner:** Maintainer B

**Branch:** `fix/id-001-session-deletion-fence`

**Audit IDs:** `ID-001`, `SES-001`

**Depends on:** none

**Serial gate:** SEC-002 / SEC-003 follow-up PR #7 must reach `DONE` before this PR can leave Draft / proceed to merge review.

**State:** `WIP`

## Invariant

An exact request-owner fact must not become unknown merely because diagnostic state is under
pressure, and deleting a session must permanently veto publication by reconstruction/open work
that began before the deletion.

## Reconfirmed current-tree findings

The branch was cut from current `origin/main` at `b81019c`. Both audit claims still existed there:

- `correlation.ts` described first exact ownership as permanent but stored owner plus diagnostic
  fields in one `MAX_CORRELATIONS = 50_000` insertion-ordered map. `trim()` deleted old proven
  owners and restore sliced persisted state back to the same bound. The existing regression even
  asserted that an old proven id became `null` after pressure.
- `store.ts` shared reconstruction through `opening` / `reconciling`, while `deleteSession()` only
  waited an already-open entry queue before removing the directory. `readDurableSnapshot()` could
  still repair `meta.json`, `ensureOpen()` could still publish `open`, and recovered summaries
  could still update the attachment catalog after deletion began. Retention used the same unfenced
  directory-removal semantics.

No other open PR at reconnaissance time owned these semantic owners. GitHub PR #7 explicitly lists
`ID-001` / `SES-001` as non-scope.

## Implementation

### ID-001

- durable v6 correlation state stores only immutable `requestId + conversationId + sessionId`
  owner facts;
- permanent owners are no longer subject to an arbitrary entry-count trim;
- `messageId`, tool name and `observedAt` remain bounded process-local diagnostic detail only;
- v3-v5 durable rows migrate by extracting the same owner fact, and recorded exact calls still
  reconcile the bounded crash window on startup;
- no owner reclamation was invented: removal remains forbidden until a lifecycle can prove the
  request can never issue another call.

### SES-001

- deletion publishes a process-lifetime terminal session tombstone before its first await;
- durable reconstruction and catalog/open publication recheck that tombstone across awaited
  boundaries;
- summary repair refuses to mkdir/write/rename for a deleted id;
- deletion removes the directory once, drains the already-admitted `opening` / `reconciling`
  work, then performs a final sweep before retiring the catalog row;
- retention uses the same fenced removal primitive while retaining its existing "do not prune an
  open/opening session" rule;
- the inactive Unattributed-bucket deletion path publishes the same terminal tombstone.

The tombstone is intentionally process-lifetime rather than persisted. Session ids are never
reused, and no stale promise survives an app restart; durable absence of the directory is the
restart-side deletion fact.

## Required regressions

- request ownership survives pressure beyond the former 50,000-entry bound;
- paused reconstruction -> delete -> resume cannot recreate the session directory, catalog row,
  or open session.

## Evidence

- Draft PR #8 was opened from scaffold-only commit `933d885` before production implementation.
- The new >50,000 pressure regression failed against the pre-fix bounded owner registry and passes
  after the v6 owner/diagnostic split.
- Focused paused-reconstruction -> delete -> resume regression passes and proves no directory,
  session-list/catalog row or authoritative session remains.
- `npm run typecheck` — passed after implementation.
- `test/correlation.test.ts` — 13/13 passed.
- `test/session-input-retention.test.ts` — 9/9 passed.
- `test/session.test.ts` — 158/158 passed in a clean isolated full-file run after the deletion/retention fix.
- `test/code-mode-runtime.test.ts` — 14/14 passed in isolation after the aggregate gate reported failures there.
- `git diff --check` — passed.
- `npm run verify` — **not green** in the aggregate environment: 4,373 passed, 43 skipped and
  46 failed across 3 files after ~25 minutes. The failures included cascaded 30s timeouts in
  `session.test.ts` despite the same full file passing 158/158 in isolation, plus 5 aggregate-only
  failures in `code-mode-runtime.test.ts` despite that file passing 14/14 in isolation. This is
  recorded as aggregate/CI-001 evidence, not claimed as a passing full gate and not repaired in
  this PR without a reproducible PR-local cause.
