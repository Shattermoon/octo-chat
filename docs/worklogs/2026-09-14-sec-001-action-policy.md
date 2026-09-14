# SEC-001 central action-policy seam

**Owner:** Maintainer A

**Branch:** `feat/sec-001-action-policy`

**Program item:** PR-02 / SEC-001

**Base:** `658cc29` (2.2.0 / bridge 14)

## Task

Introduce the behavior-preserving Principal / ActionContext / central policy vocabulary described
by the 2026-09-14 audit and remediation program. Route existing Core, Desktop and Plugins
authority gates through that seam without implementing PR-03's stricter Desktop identity policy,
PR-05's restricted Desktop product, or changing first-launch defaults.

## Invariants

- Existing direct filesystem sandbox checks remain the direct-file boundary.
- Process ownership/custody, Desktop frame/ref generations and plugin admission remain below the
  new policy layer and are not weakened or replaced.
- Current user-visible allow/deny behavior and refusal text stay unchanged in this PR.
- Code-mode children re-evaluate live policy per nested call; an outer decision is never cached.
- External plugin annotations are not trusted as proof that an arbitrary integration action is
  read-only.
- Unknown caller behavior stays exactly as it is until PR-03.

## Plan

1. Add one central action vocabulary and pure structured decision owner.
2. Project the existing exact call evidence into a Principal at the MCP policy boundary.
3. Make the shared registrar capability guard use that policy owner.
4. Route manual/composite Core/Desktop/Plugins gates through the same owner while retaining their
   existing subsystem checks and response text.
5. Add focused policy/routing regressions, then run the relevant MCP/Desktop/Plugins suites and
   typecheck.

## Evidence

- Pre-change focused baseline from audit worker: `kernel-tool-disabled-message`,
  `tools-desktop-windows`, `kernel-desktop-identity`, `plugins-surface`: 32 tests passed.
- `npm run typecheck` — passed.
- `npx vitest run test/action-policy.test.ts test/kernel-tool-disabled-message.test.ts
  test/tools-desktop-windows.test.ts test/kernel-desktop-identity.test.ts
  test/plugins-surface.test.ts test/macos-desktop-hardening.test.ts
  test/tools-desktop-permissions.test.ts test/tools-desktop-runtime.test.ts
  test/windows-desktop-recording.test.ts` — 9 files / 66 tests passed.
- `npx vitest run test/code-mode-mcp.test.ts test/mcp-tool-declarations.test.ts
  test/plugins-surface.test.ts test/kernel-run-inbox.test.ts` — 4 files / 32 tests passed,
  including the existing live-permission recheck between awaited code-mode children.
- `npx vitest run test/mcp.test.ts -t "capability gating|desktop capabilities"` — 32 passed / 147
  skipped. This intentionally selects the permission suites rather than the whole file because
  PR-01 owns the already-known deterministic `exec_command` schema-budget failure on current
  main.
- `git diff --check` — passed.

No package/installed/live-browser claim is made by this PR. It changes pure policy/dispatch
plumbing and retains the subsystem-specific execution owners below it.
