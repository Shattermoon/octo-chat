# REL-001 deterministic release-oracle repair

**Owner:** Maintainer A

**Branch:** `fix/rel-001-release-oracle`

**Program item:** PR-01 / REL-001, TEST-001, MCP-001 first tranche

**Base:** `658cc29` (2.2.0 / bridge 14)

## Task

Restore the deterministic parts of `verify:ci` without weakening production behavior or raising
the schema budget. The public baseline also contained stale notice hashes that stopped CI before
the planned schema/locale oracle failures could run, so those reviewed-byte identities are repaired
in the same release-oracle change.

## Reproduced failures

- `verify:notices` rejected the committed HeyGen and Recraft service notices because their
  inventory SHA-256 values were stale.
- after those were corrected, native-source verification rejected the committed
  `COMPONENT-NOTICES.txt` because `componentNoticesSha256` was stale.
- Windows `exec_command` discovery measured 3,888 bytes against the deliberate `< 3,800` budget.
- the renderer test accepted US/European grouping only, while the current locale correctly renders
  `400000` as `4,00,000`.

## Changes

- update only the reviewed notice hashes to the exact already-committed notice bytes;
- shorten app-authored `cmds` and Windows `yield_time_ms` descriptions while retaining one-shell,
  per-command exit, continue-after-nonzero, first-nonzero, default-wait and range semantics;
- keep the Windows shell safety guidance unchanged;
- make the renderer assertion compare against the runtime locale's own `toLocaleString()` result;
- do not raise any schema limit and do not force production number formatting to another locale.

## Validation

- `npm run typecheck` — passed.
- schema-budget + exec schema contract focused test — passed; deterministic budget test passed 3
  consecutive isolated runs. The two description reductions remove 173 bytes, taking the observed
  Windows schema from 3,888 bytes to approximately 3,715 bytes.
- locale-sensitive renderer regression — passed 3 consecutive isolated runs.
- `npm run verify:notices` — passed: 93 production packages, 7 catalog entries and 730 pinned native
  source archives/patches validated.
- `test/plugins-catalog.test.ts` + `test/third-party-notices.test.ts` — 9/9 passed.
- `git diff --check` — passed.

## Remaining CI-001 evidence

A loaded local `verify:ci` run also reproduced the audit's separate aggregate/native instability:
the command-batch timing case failed under load but passed immediately in isolation, while two
Windows UIA tests depend on the live local browser/UIA root. Those are not repaired here by raising
timeouts or weakening UIA behavior; they remain CI-001 work after the deterministic oracle is green.
