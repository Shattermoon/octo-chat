# RMD-004 [REVIEW] — SEC-002 / SEC-003 exact Desktop Principal

**Owner:** Repository maintainer

**Branch:** `feat/sec-002-exact-desktop-principal`

**Program item:** RMD-004

**State:** `REVIEW`

**Area:** `SEC`

**Base:** `e3515a3` (SEC-001 central action-policy seam + FS-001 + repository review/release gates; 2.2.0 / bridge 14)

## Task

Close the Desktop attribution gaps identified by SEC-002 and SEC-003 without changing the
Desktop product tier/defaults planned for RMD-006 or introducing RMD-010 WorkspaceLease semantics.
Every model-facing Desktop mutation, application/process launch and clipboard operation must be
authorized for the exact companion request/chat/session Principal before irreversible work begins.

## Product decision

Clipboard read is treated as sensitive disclosure, not as an anonymous observation. It therefore
requires the same exact Principal as clipboard write. Ordinary screen/window observation remains
outside this new identity requirement unless an existing lower state-owner rule already requires
caller-local observation state.

`Allow unattributed calls` remains a product setting for eligible self-contained calls such as
Core file work and bounded JavaScript. It does not grant global Desktop mutation, application
launch or clipboard authority. RMD-006 still owns first-launch defaults and the restricted-vs-full
Desktop product split.

## Authority invariant

For a sensitive Desktop policy decision, an exact Principal means all three facts came from this
call's request correlation:

- `requestId` is present;
- `conversationId` is present;
- `localSessionId` is present.

No active-tab, latest-session, friendly agent name, or sole-candidate fallback can replace those
facts. Direct calls get a bounded chance to acquire late request correlation before policy runs;
code-mode children inherit the proven parent caller and re-enter a freshly built live registrar.
The unrelated `allowUnattributedCalls` setting is still read at its original post-identity-wait
point, so this PR does not accidentally snapshot that live Core/agent setting earlier while it
waits for browser evidence.

The central policy owns this product decision. Existing lower owners remain authoritative below
it: Windows caller-local observation state, native frame/ref generations and geometry checks,
browser-chord protections, native helper generations, live capability checks and Read-only mode.

## Covered actions

- Windows: `launch_app`, `click`, `press_key`, `type_text`, `scroll`, `set_value`, `drag`,
  `perform_secondary_action`, `activate_window`, `read_clipboard`, `write_clipboard`.
- Retained macOS `computer`: click/ref/value/pointer/drag/scroll/type/key/focus actions plus
  clipboard read/write. A `wait`-only batch remains timing-only and does not require identity.
- Desktop code mode: nested `sky.*` / `tools.*` calls cross the same live policy; an anonymous
  outer JavaScript runtime cannot recreate a denied Desktop mutation.

## Non-scope

- No change to first-launch capability or `allowUnattributedCalls` defaults.
- No App Automation vs Full Computer Control product tier or command-equivalent terminal/Run
  blocking; that is RMD-006.
- No WorkspaceLease or revocation-generation contract; that is RMD-010.
- No removal of existing Desktop features or schemas.

## Validation

- `npm run typecheck` passed.
- Focused security/regression set plus the complete agents suite passed: 9 files, 264/264 tests.
- Full MCP integration passed: 173 passed / 6 platform-skipped.
- Renderer settings/layout coverage passed: 77/77 tests.
- `npm run verify:notices` passed: 93 production packages, 7 catalog entries and 730 pinned
  native source archives/patches validated.
- `npm run verify:privacy` passed: public-history privacy gate clean on the local branch.
- `git diff --check` passed.
- A full local `npm run verify` reproduced the already-tracked CI-001 aggregate contamination:
  6 failures among 4,431 tests, all outside the RMD-004 authority paths. Each failing file then
  passed independently (`code-mode-runtime` 14/14, `exec-hints` 118/118, `renderer-state`
  38/38, `session-finish` 28/28), so this PR does not hide or widen timeouts to make the
  aggregate oracle look green. RMD-007 remains the owner of that instability.
- Independent RMD-004 audit found no High/Medium merge blocker and confirmed that the Windows
  observation-state/native generation owners remain unchanged below the central policy seam.
- Hosted Linux/Windows CI and the repository maintainer's exact-final-SHA self-review are still
  required before merge and will be recorded on the pushed review head. CodeRabbit remains an
  additional automated review signal, not a substitute for the maintainer's review judgment.
