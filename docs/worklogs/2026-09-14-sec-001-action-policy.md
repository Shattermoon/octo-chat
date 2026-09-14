# SEC-001 central action-policy seam

**Owner:** Repository maintainer

**Branch:** `feat/sec-001-action-policy`

**Audit ID:** SEC-001

**Base:** `e36d78e` (FS-001 + repository CodeRabbit policy + REL-001 release-oracle repair; 2.2.0 / bridge 14)

## Task

Introduce the behavior-preserving Principal / ActionContext / central policy vocabulary described
by the 2026-09-14 audit and remediation program. Route existing Core, Desktop and Plugins
authority gates through that seam without implementing the SEC-002/SEC-003 stricter Desktop identity policy,
the SEC-004/SEC-005/SEC-006/SEC-007 restricted Desktop product, or changing first-launch defaults.

## Invariants

- Existing direct filesystem sandbox checks remain the direct-file boundary.
- Process ownership/custody, Desktop frame/ref generations and plugin admission remain below the
  new policy layer and are not weakened or replaced.
- Current user-visible allow/deny behavior and refusal text stay unchanged in this PR.
- Code-mode children re-evaluate live policy per nested call; an outer decision is never cached.
- External plugin annotations are not trusted as proof that an arbitrary integration action is
  read-only.
- Unknown caller behavior stays exactly as it is until SEC-002/SEC-003.
- Policy observers receive detached decision snapshots and cannot mutate the authoritative
  decision returned to an adapter.
- Composite capability admissions record whether capabilities are alternatives (`any`) or a
  single requirement, so later diagnostics/policy consumers cannot misread a capability list as
  conjunctive authority.
- Principal fields are a point-in-time snapshot of identity evidence at policy evaluation. A
  subsystem may strengthen identity later in the handler; this PR does not turn the snapshot into
  durable authority or a lease.
- Behavior-preserving `kind: 'none'` routes use the shared `enforcePolicy` wrapper, so a later
  Principal/lease policy denial stops execution before feature, identity, IO, or durable-state work.

## Plan

1. Add one central action vocabulary and pure structured decision owner.
2. Project the existing exact call evidence into a Principal at the MCP policy boundary.
3. Make the shared registrar capability guard use that policy owner.
4. Route manual/composite Core/Desktop/Plugins gates through the same owner while retaining their
   existing subsystem checks and response text.
5. Add focused policy/routing regressions, then run the relevant MCP/Desktop/Plugins suites and
   typecheck.

The top-level `read` and `apply_patch` admissions intentionally preserve their existing
"any exposed capability keeps the tool callable" behavior. Exact path/per-hunk product permission
checks stay below policy in this behavior-preserving PR; `effectiveAuthority.capabilityMode='any'`
makes that transitional shape explicit instead of implying every listed capability is required.

## Evidence

- Pre-change focused baseline from audit worker: `kernel-tool-disabled-message`,
  `tools-desktop-windows`, `kernel-desktop-identity`, `plugins-surface`: 32 tests passed.
- `npm run typecheck` — passed.
- `npx vitest run test/action-policy.test.ts test/kernel-tool-disabled-message.test.ts
  test/tools-desktop-windows.test.ts test/kernel-desktop-identity.test.ts
  test/plugins-surface.test.ts test/macos-desktop-hardening.test.ts
  test/tools-desktop-permissions.test.ts test/tools-desktop-runtime.test.ts
  test/windows-desktop-recording.test.ts` — 9 files / 71 tests passed after the capability-mode
  and forced-policy-denial regressions were added.
- `npx vitest run test/code-mode-mcp.test.ts test/mcp-tool-declarations.test.ts
  test/kernel-run-inbox.test.ts` — 3 files / 24 tests passed,
  including the existing live-permission recheck between awaited code-mode children.
- After REL-001 merged, `npx vitest run test/mcp.test.ts` — 173 passed / 6 platform-skipped,
  including surface budgets, capability gates, Desktop permission contracts, command/process
  custody and sandbox enforcement.
- `npm run verify:notices` — passed (93 production packages, 7 catalog entries, 730 pinned native
  source archives/patches).
- `npm run verify:privacy` — passed after rebasing on `00ecf79`.
- `git diff --check` — passed.
- CodeRabbit's review correctly identified that the initial observer received the authoritative
  mutable decision object. Commit `616287f` detaches the observer snapshot; the regression
  deliberately changes the observed effect to allow and proves the real decision remains deny and
  the guarded action does not run.
- A follow-up completeness review found that `session`, `update_plan`, `agents` and
  `session_finish` were classified but had not crossed the seam, and that artifact download's
  remote fetch was hidden inside its local write classification. They now emit behavior-preserving
  allow-only application-state decisions and an explicit `remote-read` subeffect respectively.
  `test/action-policy.test.ts` exercises the registered Core control-plane handlers before their
  existing feature gates. After this addition: focused policy/Desktop/Plugins 50/50 passed,
  nested/stateful 24/24 passed, and the policy/kernel subset 17/17 passed with typecheck clean.
- Independent re-audit found that `any-capability` authorization was semantically correct at
  runtime but ambiguous in structured output because only the capability array was emitted. The
  decision now carries `capabilityMode` (`none`, `single`, or `any`), and a regression proves an
  `any` requirement is allowed by one live alternative while remaining unambiguous to later
  diagnostics/policy consumers.
- The then-required counterpart review found that the first allow-only application-state/remote-read
  routes observed policy but discarded the decision. `session`, `update_plan`, `session_finish`,
  `agents`, and `download_artifact:remote` now run their existing bodies only inside
  `enforcePolicy`. A regression forces a central deny on `session` and proves its pre-existing
  feature gate is never reached. Current `kind: 'none'` policy is still allow-only, so this changes
  no present permission or successful feature behavior while making the seam safe for SEC-002/SEC-003, SEC-004/SEC-005/SEC-006/SEC-007, WS-001 and GH-001.
- CodeRabbit's assertive current-head review found that the pure policy returned `allow` for an
  enabled write capability before consulting the Read-only override. Production capabilities are
  normally masked before this seam, but the central policy contract must be independently correct.
  Read-only write denial now precedes the enabled-capability allow branch; regressions exercise an
  enabled `command` and every enabled write capability under Read-only and prove the guarded action
  never runs.
- After that enforcement fix, the 3-file nested/declaration/inbox set remained 24/24 green and the
  full MCP suite remained 173 passed / 6 platform-skipped; notices, privacy and diff checks also
  remained green on the `e36d78e` base. Fresh supported-platform CI and the then-required human re-review of
  the exact pushed SHA remain required before merge.

No package/installed/live-browser claim is made by this PR. It changes pure policy/dispatch
plumbing and retains the subsystem-specific execution owners below it.
