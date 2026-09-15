# [WIP][ID-001][SES-001] Durable request ownership and session deletion fencing

**Owner:** Maintainer B

**Branch:** `fix/id-001-session-deletion-fence`

**Audit IDs:** `ID-001`, `SES-001`

**Depends on:** none

**State:** `WIP`

## Invariant

An exact request-owner fact must not become unknown merely because diagnostic state is under
pressure, and deleting a session must permanently veto publication by reconstruction/open work
that began before the deletion.

## Semantic owners to reconfirm

- `src/main/session/correlation.ts`
- `src/main/session/store.ts`
- nearest session open/reconstruction/delete/prune call paths and tests

The audit was produced against an older tree. Current-source reconnaissance and reproduction are
required before implementation; this scaffold does not assume the old wording is still exact.

## Required regressions

- request ownership survives pressure beyond the former 50,000-entry bound;
- paused reconstruction -> delete -> resume cannot recreate the session directory, catalog row,
  or open session.

## Evidence

Pending. This branch intentionally contains only the PR/worklog scaffold until the Draft PR exists.

