# FS-001 no-follow walk symlink metadata

**Owner:** Maintainer A

**Branch:** `fix/fs-001-no-follow-symlink-metadata`

**Program item:** PR-11 / FS-001

**Base:** `804be88` (release-oracle repair merged; 2.2.0 / bridge 14)

## Task

Keep a recursive walk configured with `followDirectorySymlinks=false` from following a directory
link merely to classify it. The existing direct-file sandbox and explicit metadata behavior stay
unchanged.

## Invariants

- Ordinary `getMetadata()` retains its current follow-a-link behavior.
- No-follow walk checks use `lstat` metadata and never call target `stat` for a symlink.
- The same no-follow rule applies to the walk root and descendants, including a readdir/lstat
  replacement race where a formerly ordinary entry becomes a link.
- `followDirectorySymlinks=true` retains the current explicit follow behavior and cycle fencing.
- Walk budgets, ordering and truncation semantics are unchanged. A dangling link in no-follow mode
  is intentionally skipped without a target-stat error, because observing the missing target would
  itself violate this boundary.

## Plan

1. Split metadata collection internally so callers can choose whether symlink target metadata is
   followed without changing the public `getMetadata()` contract.
2. Make `walk()` use the no-follow metadata path whenever its option says not to follow links.
3. Add direct regressions proving child/root/dangling directory links never issue target `stat`,
   prove the readdir→lstat replacement race skips a newly introduced link, and retain positive
   regressions preserving public metadata and explicit walk-follow behavior.
4. Run the filesystem/read backend focused suites, typecheck and diff checks.

## Evidence

- `npm run typecheck` — passed.
- `npx vitest run test/filesystem-walk-symlink.test.ts test/read-backend.test.ts
  test/sandbox.test.ts` — 3 files passed; 90 tests passed / 10 platform skips after the 804be88
  rebase and replacement-race regression.
- The new regressions prove no target `stat` for a child directory link or symlink walk root when
  no-follow is selected, prove a directory entry replaced by a link between readdir and lstat is
  skipped without target `stat`, lock the intentional dangling-link skip semantics, and prove both
  public metadata and explicit follow mode still follow links.
- `npm run verify:privacy` — passed.
- `npm run verify:notices` — passed (93 production packages, 7 catalog entries, 730 pinned native
  source archives/patches).
- `git diff --check` — passed.

Evidence level reached: source -> focused filesystem/read/sandbox tests -> typecheck/privacy. No
build, package, installed-payload or live-provider claim is made by this filesystem-only PR.

This PR intentionally does not claim an atomic handle-stable directory walk against a directory
that is replaced *after* its `lstat` but before a later path-based `readdir`; Node's cross-platform
path APIs do not provide that guarantee here. FS-001's audited boundary is narrower: do not follow
or target-stat a path once the no-follow metadata inspection identifies it as a link.
