# [DONE][SEC-002][SEC-003] Exact Desktop Principal

**Owner:** Repository maintainer

**Branch:** `feat/sec-002-exact-desktop-principal`

**State:** `DONE`

**Audit IDs:** SEC-002, SEC-003

**Base:** `e3515a3` (SEC-001 central action-policy seam + FS-001 + repository review/release gates; 2.2.0 / bridge 14)

## Task

Close the Desktop attribution gaps identified by SEC-002 and SEC-003 without changing the
Desktop product tier/defaults planned for SEC-004, SEC-005, SEC-006 and SEC-007 or introducing WS-001 WorkspaceLease semantics.
Every model-facing Desktop mutation, application/process launch and clipboard operation must be
authorized for the exact companion request/chat/session Principal before irreversible work begins.

## Product decision

Clipboard read is treated as sensitive disclosure, not as an anonymous observation. It therefore
requires the same exact Principal as clipboard write. Ordinary screen/window observation remains
outside this new identity requirement unless an existing lower state-owner rule already requires
caller-local observation state.

`Allow unattributed calls` remains a product setting for eligible self-contained calls such as
Core file work and bounded JavaScript. It does not grant global Desktop mutation, application
launch or clipboard authority. SEC-004, SEC-005, SEC-006 and SEC-007 still own first-launch defaults and the restricted-vs-full
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
The unrelated `allowUnattributedCalls` setting is read only after identity and input/output
acknowledgement awaits, at the final ambiguity decision point. A setting change while the call is
paused therefore applies to that same call rather than being frozen at request start.

The central policy owns this product decision. Existing lower owners remain authoritative below
it: Windows caller-local observation state, native frame/ref generations and geometry checks,
browser-chord protections, native helper generations, live capability checks and Read-only mode.
Windows observation state is keyed by the stable observe-to-act owner pair
`(localSessionId, conversationId)`: Compact & Resume can keep the same local session while replacing
the attached conversation, and the replacement conversation must receive a fresh frame/index cache.
For supported Windows mutation/application-launch/clipboard work and retained macOS composite
mutation/clipboard work, live capability, Read-only and caller-lifecycle authority is revalidated
at the final native or Electron side-effect boundary after relevant browser/window/helper-queue
waits. Windows passes this preflight per invocation rather than storing it on the cached caller API,
so a later request cannot inherit an older registrar or operation classification.

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
  blocking; that is SEC-004, SEC-005, SEC-006 and SEC-007.
- No WorkspaceLease or revocation-generation contract; that is WS-001.
- No redesign of retained macOS screen-read verification/capture authority. Mid-call screen
  revocation during verification/capture is an adjacent read-authority follow-up, not part of the
  SEC-002/SEC-003 mutation/clipboard finding closed here.
- No removal of existing Desktop features or schemas.

## Validation

- `npm run typecheck` passed.
- Final focused authority/regression set passed: 8 files, 248 passed / 7 platform-skipped,
  including the complete agents suite (155/155), live setting changes during the bounded identity
  wait, and setting changes held across both input and background-output acknowledgements.
- Independent native-policy re-review also passed 91 focused Desktop/policy tests / 7 skipped,
  17/17 partial-batch/helper-retirement/identity-recovery tests, and 163/163 agents + run-inbox
  tests. It found no remaining blocker in the reported macOS Control/Read-only/caller-lifecycle
  mutation TOCTOU.
- Full MCP integration passed: 173 passed / 6 platform-skipped.
- Windows Desktop + code-mode + disabled-tool + MCP integration passed together: 222 passed / 6
  platform-skipped after the review repair.
- Renderer settings/layout coverage passed: 77/77 tests.
- `npm run verify:notices` passed: 93 production packages, 7 catalog entries and 730 pinned
  native source archives/patches validated.
- `npm run verify:privacy` passed: public-history privacy gate clean on the local branch.
- `git diff --check` passed.
- Final Windows review repair passed `npm run typecheck` plus 10 focused Desktop/policy/code-mode
  files: 154 passed / 7 platform-skipped. The regressions hold Windows browser-chord/window awaits
  while Control, Read-only or caller lifecycle changes; hold direct clipboard work before its final
  preflight; prove per-call Windows API preflight forwarding; and prove a queued clipboard write
  rechecks authority after an earlier exclusive action releases.
- The Windows adapter now permits a shared unattributed cached context only for read/observation
  methods. Mutation and application-launch paths require exact identity locally as well as through
  the central policy seam, so `Allow unattributed calls` cannot become a fallback input principal if
  a higher-level guard is bypassed.
- A full local `npm run verify` on the review-repair working tree reproduced the already-tracked
  CI-001 aggregate contamination: 11 failures among 4,441 tests, spread across code-mode timing,
  Windows live UIA/capture environment, exec-hints timing, MCP glob-scan timing and session-finish
  state/timing. Isolation then passed `code-mode-runtime` 14/14, `exec-hints` 118/118,
  `session-finish` 28/28 and MCP 173/173 with 6 platform skips. `computer.test.ts` retained two
  live-Windows UIA failures whose behavior depends on the foreground/browser desktop environment;
  the deterministic mocked Desktop authority suites are green. This PR does not widen timeouts or
  weaken assertions to make the aggregate oracle look green; CI-001 remains the owner of that
  instability.
- The macOS repair now rechecks live capability/Read-only and current caller lifecycle after the
  browser-chord await, after local waits, after helper queue/startup, and immediately before native
  helper send or Electron clipboard I/O. Mid-batch revocation preserves completed-count/failure-index
  evidence and uses no-retry-safe wording instead of falsely claiming that nothing ran.
- The supported Windows surface now uses the same final-boundary authority invariant for all nine
  mutation/application-launch methods and standalone clipboard read/write. Multiline `type_text`
  rechecks Control before focus, clipboard-write before clipboard publication, and Control again
  before Ctrl+V delivery.
- A dedicated multiline-paste regression revokes Control after clipboard publication but before
  Ctrl+V. It proves the clipboard write occurs exactly once, the final keypress is not dispatched,
  and the failure preserves `Clipboard text was replaced; paste delivery is not confirmed` so the
  model is not encouraged to retry the whole operation blindly.
- Independent review of the latest CodeRabbit findings found one additional supported-Windows
  blocker: the observation cache was keyed only by local session, so a replacement conversation
  after Compact & Resume could reuse the source conversation's Window2 indexes/geometry. The cache
  is now keyed by both local session and conversation, with a same-session/different-conversation
  regression. The review also confirmed that `type_text:clipboard` and
  `type_text:clipboard-write` both classify from the live `clipboardWrite` requirement and therefore
  enter the same `clipboard-write` exact-Principal policy; the differing suffix text is not an
  authorization bypass.
- The same review found a real lower-level generation race for a pinned mixed action whose helper
  retires while an asynchronous clipboard authority preflight is running. Clipboard read/write now
  recheck the pinned helper generation after the preflight and immediately before Electron I/O;
  the regression retires the ref owner inside that final preflight and proves the clipboard is not
  mutated. Native helper sends likewise recheck that the exact selected runtime is still active
  after the awaited final-authority callback and before `stdin.write` / worker `postMessage`; a
  regression retires that runtime inside the callback and proves no native input request is sent.
- CodeRabbit's final-lifecycle `conversationAttachment(...)=unknown` finding was valid for the
  in-flight sensitive call. Session-history deletion is not a permanent Block and a later request
  may establish a fresh exact attachment, but the already-running request can no longer prove that
  its captured request/chat/session Principal is current at the irreversible boundary. The final
  lifecycle check now fail-closes that call, with a regression that removes the attachment while the
  ownership read is pending. ID-001/SES-001 still own the broader deletion/reconstruction generation
  fence. The SEC-001 worklog-state warning was stale: SEC-001 is already merged on `origin/main`, so
  its `DONE` state is correct.
- Final pushed head `55cbbc01238771bf2e3f6f77f39924781794075f` received multiple exact-head
  read-only reviews with no High/Medium supported Windows/Linux blocker. Hosted run `34905980346`
  completed successfully on both Linux x64 and Windows x64, including published-plugin exercise.
  The aggregate local Windows oracle reproduced CI-001 resource/timing contamination; every affected
  failure class reran clean in isolation, and the split hosted jobs were green.
- CodeRabbit's substantive review was bound to older SHA `ca65939a718ce34a0b5145c7a74e7aeb32f98c03`.
  Its generation, final-attachment and Windows observation-cache findings were validated and fixed;
  its multiline suffix concern was disproved against the live clipboard-write policy; its SEC-001
  state warning was stale. The remaining macOS frame/ref-ownership concern is removed rather than
  repaired by PLATFORM-002. The stale `CHANGES_REQUESTED` review was dismissed with that disposition;
  the final-head CodeRabbit status was green but rate-limited.
- PR #5 merged on 2026-09-15 as `b81019cbe6504e8e5ef5243b58f3150049c546d1`.
