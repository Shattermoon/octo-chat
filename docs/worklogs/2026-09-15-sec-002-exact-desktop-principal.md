# [REVIEW][SEC-002][SEC-003] Exact Desktop Principal

**Owner:** Repository maintainer

**Primary branch:** `feat/sec-002-exact-desktop-principal` (merged as PR #5)

**Security follow-up:** `fix/sec-002-sec-003-macos-artifact-ownership`

**State:** `REVIEW`

**Audit IDs:** SEC-002, SEC-003

**Primary base:** `e3515a3` (SEC-001 central action-policy seam + FS-001 + repository review/release gates; 2.2.0 / bridge 14)

**Follow-up base:** `b81019c` (merged PR #5 on `main`)

## Task

Close the Desktop attribution gaps identified by SEC-002 and SEC-003 without changing the
Desktop product tier/defaults planned for SEC-004, SEC-005, SEC-006 and SEC-007 or introducing WS-001 WorkspaceLease semantics.
Every model-facing Desktop mutation, application/process launch and clipboard operation must be
authorized for the exact companion request/chat/session Principal before irreversible work begins.

PR #5 merged before one final CodeRabbit Major was closed: the retained macOS low-level frame/ref
stores were app-global and did not remember which exact caller attachment created an observation.
SEC-002/SEC-003 therefore remain in `REVIEW` until the immediate follow-up binds those artifacts to
their observing local-session + conversation owner and proves cross-principal/unattributed reuse is
refused before native input.

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
- No redesign of retained macOS screen-read permission or verification/capture liveness. This
  follow-up only binds a captured frame/ref's later reuse as mutation authority to its observing
  attachment. Mid-call screen revocation during verification/capture remains an adjacent
  read-authority follow-up, not part of SEC-002/SEC-003.
- No removal of existing Desktop features or schemas.

## Validation

### Immediate post-merge artifact-ownership follow-up

- Retained macOS screenshot frames and accessibility refs now carry an opaque stable owner derived
  from the exact local-session + conversation attachment that observed them. Request id is
  intentionally not part of this retained-artifact key because normal observe → act spans tool
  requests; every mutation still requires a fresh exact request/chat/session Principal through the
  existing action policy and final lifecycle preflight.
- The owner is encoded as an unambiguous serialized tuple rather than delimiter concatenation, with
  a regression for identifier pairs that would collide under `session:...:chat:...` formatting.
- A different conversation in the same local session cannot consume the source chat's frame/ref,
  another session cannot consume it, and artifacts created by unattributed observation remain
  unusable as later mutation authority.
- The low-level owner check is enforced where frames/refs are resolved, not only in the macOS MCP
  adapter, while internal/native callers that do not opt into an artifact owner retain their prior
  behavior.
- Focused follow-up validation: `npm run typecheck` passed; `git diff --check` passed; 10 focused
  Desktop/native/hardening/policy/code-mode/agents files passed with 326 tests / 8 platform-skipped.
- Full MCP integration passed independently with 173 tests / 6 platform-skipped; privacy and
  third-party notice/source-package verification also passed.
- No live macOS Desktop probe was exercised from this Windows development environment. The
  retained macOS contract is covered deterministically through the real computer owner with mocked
  stdio/addon transports plus MCP adapter tests; hosted release CI remains Linux/Windows only.
- Added regressions prove same-attachment observe → act remains functional, cross-conversation
  frame/ref consumption is rejected before a native request, and an unattributed observation cannot
  later be upgraded into exact-caller mutation authority.

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
- Hosted Linux/Windows CI and the repository maintainer's exact-final-SHA self-review are still
  required before merge and will be recorded on the pushed review head. CodeRabbit remains an
  additional automated review signal, not a substitute for the maintainer's review judgment.
