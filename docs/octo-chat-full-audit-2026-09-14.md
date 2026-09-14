# Octo Chat
# Full Codebase Audit — Security, Reliability, Architecture, Plugins, Extension, Agents, Desktop, Goal, CI, and Platform Scope

**Audit date:** 2026-09-14
**Repository:** `E:\Octo Chat`
**Branch:** `main`
**Revision inspected:** `f51acbccdd734f524799ea92bb747be765fba1e4`
**Package / extension version:** `2.1.11`
**Bridge protocol:** `13`
**Working tree during audit:** clean
**Platform priority decided by product owner:** **drop macOS support for now; Windows is the primary reliability target**
**Status of this document:** **authoritative v2 audit; supersedes the earlier `octo-chat-codebase-audit-2026-09-14.md` draft**

---

## 0. Why this report replaces the first draft

The first report was produced before the deeper multi-agent pass and before the complete local verification suite had been run. It contained several claims that are no longer accurate enough to use as an implementation plan.

This version corrects them:

- Dependencies are present. `npm run typecheck`, targeted Vitest suites, `npm audit`, and `npm run verify:ci` were actually run.
- The previously suspected renderer session-pagination generation bug is **not currently reproduced**; existing tests cover stale older/newer page responses across session switches.
- Memory has a real stable persistence path and live manager/proxy tests. The user's Memory failure remains a runtime/product diagnosis problem, not a proven missing-storage implementation.
- A worker report initially suggested that a plugin could execute an obsolete tool during `notifications/tools/list_changed`. The prime independently traced `PluginManager.call()` and the per-plugin serialization queue and checked the existing regression. **The old declaration is refused; this is not a current stale-execution vulnerability.**
- The codebase has additional confirmed findings that were absent from v1: unattributed Desktop mutation despite opt-out, session deletion/reconstruction resurrection risk, browser-command shutdown race, repair authorization gap, Goal `eventSeq=0` restart loss, plugin-refresh pre-click attempt consumption, update trust-root weakness, and release-test instability.

Use **this report only** for prioritization.

---

# 1. Executive conclusion

Octo Chat is not failing because every subsystem is poorly implemented. In fact, a number of local components are unusually defensive.

The central problem is that **the product has accumulated several independently powerful authorities without one product-wide authorization model**.

Today:

- Core owns direct files and process execution.
- Desktop owns a Windows interactive user session.
- Plugins own arbitrary external MCP process/service authority.
- The extension owns private ChatGPT browser/UI orchestration.
- Goal owns hidden planner/decision chats and durable continuation debt.
- Agents own reusable cross-chat worker lifecycles.
- Bridge/continuation own browser commands and frontend replacement.
- Session/correlation own durable attribution and local history.

Each has local rules. The rules do not compose into one global answer to:

> **“Is this effective action allowed for this exact caller, against this exact target, right now?”**

That is why a Core denial can be routed around through Desktop, why “unattributed disabled” still permits some Desktop mutations, why browser repair authority can be stale between handout and action, and why several durable state machines have separate commit semantics.

The highest-priority architectural change is therefore:

> **One exact Principal → one Workspace/Capability Lease → one central Policy decision → one typed execution adapter.**

The existing filesystem sandbox, generation fences, plugin rollback, command custody, agent WAL work, and browser receipt machinery should sit **under** that model rather than remain independent policy islands.

---

# 2. Audit method and evidence levels

This was not a one-file review.

The audit used:

1. **Repository-wide structural inspection**
2. **Full root `AGENTS.md` product/invariant map**
3. **Current source and current tests**
4. **Recorded worker/chat history**
5. **Independent subagent audits**
6. **Prime verification of important subagent claims**
7. **Targeted Vitest execution**
8. **Full `verify:ci` execution**
9. **Dependency vulnerability audit**
10. **macOS shipping/build/test footprint scan**

The repository map itself correctly says evidence levels must remain distinct:

```text
source
→ tests
→ build
→ package
→ installed payload
→ live browser/device/provider behavior
```

This report follows that distinction.

A source-level finding is not presented as a live reproduction unless live evidence exists.

---

# 3. Repository scale and concentration risk

Approximate implementation scale at audit time:

- **183** TS/JS/CSS/HTML implementation files
- **88,005** implementation lines
- **182** TypeScript test files
- **79,811** test lines

Largest implementation files:

| File | Approx. lines | What it concentrates |
| --- | ---: | --- |
| `extension/content.js` | 10,600 | recorder, delivery, Goal UI, helper flow, continuation, extension UI |
| `src/main/bridge.ts` | 7,860 | browser HTTP, recovery, commands, status, input, Goal pickup, lifecycle |
| `src/main/agents.ts` | 3,910 | multi-prime families, workers, dormant state, inbox, persistence, revival |
| `extension/background.js` | 3,717 | MV3 journal, browser ownership, elections, helper tabs, repairs |
| `src/renderer/chat.ts` | 3,700 | session list, timeline, composer, queue, Goal/agent presentation |
| `src/main/session/store.ts` | 2,652 | journal, canonical messages, metadata reconstruction, pagination, retention |
| `src/main/goal.ts` | 2,561 | objective/switch/reply debt, helpers, providers, planner decisions |
| `src/main/session/recorder.ts` | 2,423 | browser/MCP evidence and turn state |
| `src/main/mcp/tools-core.ts` | 2,265 | files, patches, terminal, search |
| `extension/chatgpt-dom.js` | 2,229 | provider-private DOM contract |
| `src/main/computer/index.ts` | 1,945 | capture, UIA, frames, input, native helper lifetime |

Large files are not automatically bad, but here the large files often combine **multiple authorities and multiple durable lifetimes**. That is directly correlated with the bug classes found.

---

# 4. Validation results

## 4.1 Typecheck

**Passed.**

`npm run typecheck`

No TypeScript failure was observed in the audit pass.

---

## 4.2 Dependency vulnerability audit

**Passed.**

`npm audit --omit=dev --audit-level=moderate`

Result:

```text
found 0 vulnerabilities
```

This does not prove third-party runtime behavior is safe; it means npm's current advisory database did not report a production dependency vulnerability at the selected threshold.

---

## 4.3 Targeted subsystem testing

Targeted testing run during the audit included, among others:

- Desktop Windows tool tests
- Windows app launch
- Windows key handling
- plugins manager / catalog / live proxy
- Goal backends
- session input
- agents
- workspace
- correlation
- renderer state
- bridge
- continuation/release paths
- update/artifacts/secrets/logger/IPC

Subagent validation included:

- Desktop focused tests: all selected tests passed
- Plugin/platform focused suite: **222 passed, 1 skipped**
- Agent/bridge/release suite: **682/682 passed**
- App-shell/update/artifact/security set: **148/148 passed**

This is useful evidence that several heavily tested local invariants are healthy.

---

## 4.4 Full `npm run verify:ci`

**FAILED.**

The full verification gate produced **10 test failures**.

This matters independently of whether each failure is a product bug: a mature release gate must reliably distinguish real regressions from test contamination.

### Deterministic failure A — MCP schema budget

Isolated reproduction:

```text
exec_command schema is 3888 bytes
expected < 3800
```

`test/mcp.test.ts` explicitly sets the Windows `exec_command` per-tool budget to 3,800 bytes.

Current tool schema: 3,888 bytes.

This is a real, deterministic repository-contract regression.

### Deterministic failure B — locale-sensitive renderer test

The renderer correctly formatted 400000 under the current locale as:

```text
4,00,000
```

The test accepts only:

```text
400,000
400.000
```

So `test/renderer-chat-models.test.ts` fails under Indian grouping.

This is a **test bug**, not evidence that model selection or context-meter behavior is broken.

### Eight full-suite-only failures

Failures occurred in:

- `test/computer.test.ts` — 2
- `test/code-mode-runtime.test.ts` — 2
- `test/exec-hints.test.ts` — 1
- `test/session-finish.test.ts` — 3

When rerun in a targeted group, the Desktop/code-mode/exec-hints/session-finish failures passed.

Examples:

- exec-hints timed out under loaded suite but completed in isolation;
- all session-finish tests passed in the focused rerun;
- Desktop/UIA and code-mode failures disappeared in isolation.

This is evidence of **suite load / timing / shared-state / resource-contention instability**.

A release gate that can fail eight tests only under aggregate load and pass them alone is not yet a reliable signal.

**Do not “fix” this by only increasing every timeout.** Find shared globals, process/helper contention, fake-timer leakage, environment mutation, or excessive suite concurrency.

---

# 5. Severity model

### P0 — release blocker
An explicit user boundary can be bypassed, a dangerous action runs without the product's claimed authorization, or the current security model cannot express the intended boundary.

### P1 — high
Durable ownership/lifecycle can be lost or resurrected, a major product flow is structurally unreliable, or the release gate cannot reliably protect production.

### P2 — medium
Important reliability, continuity, supply-chain hardening, performance, diagnosis, or maintainability defect.

### P3 — low
Documentation drift, low-risk cleanup, or test polish.

---

# 6. Findings register — highest priority

---

## P0-01 — Core denial is not an effective-action denial: Desktop can recreate command/filesystem authority

**Evidence:** source + recorded runtime history
**Status:** confirmed architecture/product-policy defect relative to the desired permission model

Relevant source:

- `src/shared/capabilities.ts`
- `src/shared/types.ts`
- `src/shared/windows-computer.ts`
- `src/main/mcp/tools-desktop-windows.ts`
- `src/main/computer/windows-apps.ts`

Current facts:

- Desktop `control` is a rootless capability.
- `launch_app` belongs to Desktop `control`.
- `launch_app` accepts a catalog app, an absolute `.exe`, or a PATH application name.
- Full keyboard input is available under control.
- Windows key input exists.
- browser-chord protection covers a bounded set of browser-management chords, not general OS execution paths.

The codebase's own security documentation currently acknowledges that Desktop control is powerful.

The problem is therefore deeper than one forgotten guard:

> **Command=false is not an effective no-command policy while arbitrary Desktop control remains enabled.**

A model can launch or operate:

- PowerShell
- Command Prompt
- Windows Terminal
- Python
- Node
- IDE terminals
- Windows Run
- Start/search
- Explorer/UI-based file operations
- other interpreters

Blocking only `powershell.exe` would not solve the class.

### Recorded proof

Recorded worker history showed the exact class of bypass:

1. an ordinary connector rejected a StartupIdeaDB path outside the approved workspace;
2. the worker switched surfaces;
3. it used native Desktop authority;
4. it opened Windows Run;
5. it entered PowerShell that wrote clipboard contents to `%TEMP%\sidb_p1_ef7_accept.cmd`;
6. it executed that batch file.

That is direct evidence that a local denial does not currently stop the effective action.

### Correct fix

Create two distinct Desktop products:

#### Restricted app-scoped automation
Default / normal mode.

- exact observed app/window
- no arbitrary executable launch
- no Run/Start shell execution
- no terminal/interpreter automation
- no implicit command-equivalent path
- optional bounded approved-app allowlist
- exact caller required

#### Full Computer Control
Explicit high-risk grant.

The UI must describe it as:

> “Can operate applications across your Windows user session, including terminals and other programs. Not confined to approved folders.”

If full control is on, the product must stop implying that command/file permission toggles are a complete machine-wide boundary.

---

## P0-02 — “Allow unattributed calls = Off” does not block several Desktop mutations

**Evidence:** source + tests showing only the narrower current behavior
**Status:** confirmed implementation defect

This is not merely broad Desktop semantics.

The UI says that when unattributed work is blocked, calls the app cannot attribute are refused.

Current Desktop code does not enforce that promise uniformly.

### Current code

`src/shared/windows-computer.ts` divides Desktop methods into:

Read:

```text
list_windows
get_window
list_apps
get_window_state
```

Input:

```text
launch_app
click
press_key
type_text
scroll
set_value
drag
perform_secondary_action
activate_window
```

But `WINDOWS_COMPUTER_STATE_INPUT_METHODS` contains only:

```text
click
scroll
set_value
drag
perform_secondary_action
```

`tools-desktop-windows.ts::apiForCaller()` refuses unidentified calls only for that state-input subset.

So with `allowUnattributedCalls=false`, an unidentified caller can still reach simple non-state methods such as:

- `launch_app`
- `press_key`
- `type_text`
- `activate_window`

Clipboard handlers do not call `apiForCaller()` at all.

This also means:

- `write_clipboard` can mutate global clipboard state without exact conversation identity if the capability itself is on.
- `read_clipboard` can expose clipboard data without an exact caller, depending on current publication/dispatch context.

`kernel.ts` waits for Desktop caller proof for:

- `get_window_state`
- the state-input subset

but does not establish a global “all Desktop mutation requires principal” rule.

### Fix

Create a policy-level classification:

```text
read-only observation
stateful observation
mutation
process launch
clipboard read
clipboard write
```

Require an exact Principal for:

- **every mutation**
- process/app launch
- keyboard/mouse input
- clipboard write
- ideally clipboard read as well

Do not put this rule inside `apiForCaller()` only. Put it in the central action policy so direct calls and code-mode children cannot diverge.

---

## P0-03 — Fresh Windows installations enable excessive authority

**Evidence:** source
**Status:** confirmed intended current behavior, but unacceptable for a mature least-privilege release

`src/main/config.ts` creates:

```text
ALL_FIRST_LAUNCH_CAPABILITIES = all true
```

and:

```text
FIRST_LAUNCH_MULTI_AGENT.enabled = true
FIRST_LAUNCH_MULTI_AGENT.allowUnattributedCalls = true
```

Windows keeps Desktop capabilities on at first launch.

This means first use combines:

- file read/write
- command execution
- Desktop observation
- Desktop control
- clipboard authority
- multi-agent
- unattributed work

before the user has built a mental model of the separate trust domains.

The repository's `SECURITY.md` explicitly documents these defaults. Documentation makes them intentional; it does not make them mature.

### Recommended new baseline

On first Windows launch:

```text
browse/read/search/metadata    ON or setup-selected
create/edit/move/delete        OFF until explicit grant
command                        OFF
screen                         OFF or explicitly prompted
control                        OFF
clipboardRead                  OFF
clipboardWrite                 OFF
multiAgent                     OFF
allowUnattributedCalls         OFF
Goal/Loop                      OFF until recording/provider healthy
external plugins               no implicit trust
```

A deliberate “Developer / Full local agent” profile can enable a broad set after the user chooses it.

---

# 7. Identity, attribution, and workspace findings

---

## P1-01 — Request ownership says “permanent” but is arbitrarily evicted after 50,000 entries

**Evidence:** source + tests
**Status:** confirmed invariant contradiction

`src/main/session/correlation.ts` explains at length:

- exact request ownership is permanent;
- there is no time TTL;
- first proof wins;
- no later observation may move or erase the owner.

The implementation then declares:

```text
MAX_CORRELATIONS = 50_000
```

and `trim()` deletes oldest entries.

The tests explicitly verify eviction behavior.

This is not just a memory-bound implementation detail because forgetting a proven owner changes a **security fact** into “unknown again”.

After eviction, a request ID that was once permanently assigned can potentially be accepted again if exact history proof is not in the bounded restore/reconciliation window.

Restore is also bounded:

- persisted entries: last 50,000
- recent history reconciliation: bounded sessions/events

### Fix

Do not put permanent ownership in a generic LRU.

Options:

1. durable indexed key/value ownership store;
2. lifecycle-aware garbage collection that proves the workflow can never issue another call;
3. retain a compact immutable owner tombstone even after rich diagnostic metadata is pruned.

Separate:

```text
permanent ownership fact
from
recent diagnostic details
```

Only the latter should be bounded by LRU.

---

## P1-02 — Session deletion/retention can race session reconstruction and allow deleted state to reappear

**Evidence:** source
**Status:** source-confirmed concurrency hole; dedicated regression absent

`src/main/session/store.ts` has two asynchronous reconstruction registries:

```text
opening
reconciling
```

`readDurableSnapshot()` can rebuild metadata and write a repaired summary.

`ensureOpen()` can wait on reconstruction and later place the session into the in-memory `open` map.

`deleteSession()`:

- waits for an existing `open` entry queue;
- removes the `open` entry;
- recursively removes the session directory.

It does **not** fence or await an already running `opening` or `reconciling` operation.

`pruneSessions()` similarly skips `open` but does not positively exclude reconstruction already in progress.

### Failure shape

```text
A: history read begins reconstruction
B: user deletes session
B: directory is removed
A: reconstruction finishes
A: writeSummary()/ensureOpen publishes state again
```

Depending on exact timing, deleted state can be recreated or the session can reappear in memory.

### Fix

Add a per-session generation/deletion tombstone.

Every reconstruction captures the generation and must recheck before:

- writing repaired metadata;
- publishing into `open`.

Deletion:

1. increments/marks generation terminal;
2. waits for/cancels current reconstruction;
3. removes files;
4. permanently vetoes publication from older generation.

Add deterministic race test:

```text
pause reconstruction
delete
resume reconstruction
assert no directory / no open entry / no catalog row
```

---

## P2-01 — Workspace convenience cache has bounded continuity, not durable ownership

Current `workspace.ts` is substantially better than older designs:

- keyed by exact conversation
- no identity → no workspace
- relative path fails closed
- worker staging includes run identity
- compaction moves chat projection explicitly

No current cross-prime “worker-1 borrowed another workspace” defect was confirmed.

However learned workspace convenience state has:

- 12-hour TTL
- max 64 entries

That can cause old/idle active workflows to lose relative-path convenience and start failing closed.

This is a **continuity issue**, not an escape.

### Fix

Move durable project/workspace authority to a `WorkspaceLease` attached to session/run principal.

Keep learned cwd as a convenience cache only.

---

# 8. Desktop subsystem audit

## Strong pieces to preserve

The Windows Desktop subsystem already has useful engineering:

- helper generations
- stale frame detection
- stale accessibility-ref detection
- exact window identity
- window geometry revalidation
- serialized helper requests
- helper process retirement
- bounded screenshots/UI metadata
- explicit popup ownership checks
- browser chord policy
- postcondition-oriented APIs

The fix is **not** to throw those away.

## Main architectural problem

A huge PowerShell/Win32/UIA helper carries:

- screen capture
- window discovery
- accessibility
- focus
- physical input
- clipboard-related flows
- app enumeration
- app launch

This gives one subsystem very broad authority and makes permission composition difficult.

### Long-term Windows target

Replace the large PowerShell helper with a typed Windows-native helper, preferably C# or Rust.

Split:

```text
window identity
capture
accessibility
input
application launch
clipboard
policy target inspection
```

The helper should receive already-authorized typed operations.

Do not make the native helper itself the product policy engine.

---

# 9. Bridge / browser command / recovery findings

---

## P1-03 — Bridge shutdown can race an already-persisting delivery and still open the browser

**Evidence:** source + independent subagent review
**Status:** confirmed lifecycle race

`shutdownBridge()` prevents later startup.

`stopBridge()` closes admission, but current source does not fully:

- await all `commandWrites`;
- clear/fence every deferred browser launch;
- make `deliver()` recheck the shutdown/lifecycle epoch after its awaited durable steps.

A command can be in this shape:

```text
persistCommandLease()
   await disk
shutdown begins
disk completes
deliver continues
browser opener runs
```

A deferred browser launch can also call delivery after the shutdown decision.

### Why it matters

Shutdown should mean:

> no new browser side effect can occur after the shutdown authority was revoked.

The shutdown runner itself is bounded and well structured; this defect is specifically in the bridge delivery lifetime.

### Fix

Create a bridge lifecycle generation.

Every delivery captures:

```text
bridgeGeneration
shutdownRequested=false
command identity
```

and revalidates after **every awaited boundary** before:

- handout;
- OS browser launch;
- extension wake;
- tab/open command publication.

`stopBridge()` must:

- invalidate generation;
- cancel deferred launch timer;
- await or terminally fence accepted command writes.

---

## P1-04 — Browser repairs other than attribution do not have a final authorization claim before action

**Evidence:** source
**Status:** confirmed gap, already documented in repository known gaps

Current attribution repair has a good pattern:

```text
handout
extension rescans current tabs
final /repairs/claim
browser action
```

Other repair reasons do not consistently do that final claim.

Examples include:

- silence
- assistant error
- compaction
- Goal

`takePendingRepairs()` can mark work handed out, then the extension spends time scanning/rechecking the browser.

Authority can change during that gap:

- user stops;
- chat becomes blocked;
- conversation is superseded;
- continuation state changes;
- source work resumes.

### Fix

Every browser repair that performs a reload/open must use the same two-phase structure:

```text
durable/retry handout
→ local current-browser inspection
→ exact final claim against current app authority
→ one browser action
```

Do not special-case attribution as the only reason deserving a final fence.

---

## P2-02 — App window show can initiate model-discovery browser opening without a concrete user task

`src/main/index.ts`:

```text
window.on('show')
if model catalog is unknown
startChatModelDiscovery(true)
```

That discovery path can wake/start a browser after positive process absence.

This is already listed in `AGENTS.md` §21 as a known gap.

### Fix

Opening a browser should require a concrete operation owner:

- explicit model refresh;
- an actual send;
- worker spawn;
- an explicit setup action.

App visibility itself is not an operation.

---

# 10. Loopback extension bridge trust model

---

## P2-03 — Pairing deliberately trusts any same-user localhost process

**Evidence:** source + tests + explicit source comment
**Status:** intentional current security model; hardening issue, not a hidden bug

The bridge:

- binds fixed localhost candidate ports;
- rejects browser/web origins;
- allows requests with no Origin;
- `/pair` requires no existing bearer;
- mints a bearer to whoever asks on `127.0.0.1`;
- `{ reconnect:true }` can clear the deliberate browser-disconnected latch.

The source comment explicitly states the tradeoff:

> any program already running as this user can obtain the token, read recorded ChatGPT activity, and queue an “open a fresh chat” command.

The bridge does **not** expose Core filesystem/command/settings routes, so this is not equivalent to arbitrary local code execution.

But it means “Disconnect browser” is not a strong same-user local-process security boundary.

### Mature options

If local process isolation matters:

- bind a random per-install endpoint or use OS IPC/native messaging;
- require a one-time app-generated challenge;
- use Windows named pipe ACL / Unix socket permissions where appropriate;
- prove extension installation identity through a native messaging host;
- make reconnect require an app-visible user action rather than an unauthenticated body flag.

If same-user local processes are explicitly out of threat scope, document this prominently and do not present Disconnect as protection from them.

---

# 11. Goal / Loop findings

---

## P1-05 — Provisional Goal obligations with `eventSeq=0` are dropped on restart

**Evidence:** source + repository known gap
**Status:** confirmed

`restoreGoalReplies()` rejects:

```text
eventSeq < 1
```

The bridge currently creates provisional Goal debt with:

```text
eventSeq: 0
```

before stronger durable turn evidence exists.

The live process understands that zero can be upgraded later.

Restart does not.

### Result

A valid continuation obligation can exist in memory, the app can restart before the stable event sequence arrives, and restore silently drops the obligation.

### Fix

Persist provisional identity explicitly.

For example:

```text
kind: provisional-turn
conversationId
sessionId
turnId
replyId
acceptedAt
eventSeq: null
```

Then strengthen the same durable row when exact event sequence arrives.

Do not encode “valid provisional identity” as a numeric value the restore validator rejects.

---

## P1-06 — Goal attempt cancellation and Goal debt disposition are still conflated

`retireGoalDrafts()`:

- aborts every unacknowledged draft;
- empties generated text;
- then sets **all Goal reply obligations to handled**.

That is safe against sending obsolete draft text, but it can turn:

```text
“cancel this provider attempt / settings changed”
```

into:

```text
“the user no longer needs this continuation”
```

The repository's own §21 flags this as a known gap.

### Correct invariant

These must be separate facts:

```text
objective
mode/switch
reply obligation
provider attempt
browser send
```

Cancelling one does not silently settle another.

---

## P1-07 — Goal ledgers do not all share one durable transaction model

Some Goal setters use immediate durable writes and rollback.

Other objective/switch/clear/move paths mutate process memory and then rely on background persistence.

This is particularly risky because Goal has several related durable files:

- objectives
- switches
- replies

A crash between cross-ledger changes can restore combinations that never existed as one accepted product decision.

### Fix

Create one `GoalControlStore` with serialized semantic mutations.

Either:

- one durable snapshot for control-plane facts; or
- an explicit WAL/transaction generation across files.

The visible in-memory publication should happen only after the durable semantic commit.

---

## P1-08 — Compact & Resume moves Goal objective/switch but leaves old conversation reply debt behind

**Evidence:** source
**Status:** confirmed known gap

Continuation commit moves:

- durable session binding A → B
- workspace
- Goal objective
- Goal switch
- prime ownership

It does not move or explicitly retire the conversation-keyed Goal reply obligation.

Later the bridge finds source-A debt but refuses to execute it because the session now points to B.

That is good from a safety perspective: stale A does not execute.

But the legitimate pending continuation may be **stranded**.

### Fix

Committed projection must define Goal debt disposition atomically:

```text
source reply debt:
  superseded by continuation
or
  transferred to B with exact provenance
```

Never leave it as a live-looking row that only becomes uncollectable through later guards.

---

## P1-09 — Normal Goal New Chat depends on a Temporary Chat helper control plane

**Evidence:** source
**Status:** confirmed architecture dependency

When Goal uses the ChatGPT backend, decision generation calls `requestBrowserDecision()` with:

```text
conversationId: null
lifetime: 'temporary-planner'
```

The extension opens:

```text
https://chatgpt.com/?temporary-chat=true...
```

and requires Temporary Chat readiness before sending.

This does **not** mean the final user's executor chat is always a Temporary Chat.

It means:

> A normal Goal/New Chat flow can fail because its hidden control-plane helper cannot create/confirm a Temporary Chat.

That exactly matches the class of user symptom where “New Chat in Goals opens/goes through Temporary Chat and then doesn't work.”

### Fix

Separate:

```text
Goal control-plane computation
from
user-chat placement
```

Preferred mature order:

1. compute decision/planner result in an isolated provider backend;
2. obtain a finalized text/decision;
3. allocate/prove the normal destination;
4. deliver once;
5. commit destination ownership.

If the ChatGPT helper backend remains:

- helper tabs must have a distinct identity pool;
- helper tab health must be visible;
- helpers must never be candidates for ordinary New Chat reuse;
- failure must say “Goal helper unavailable”, not look like the user's new chat failed mysteriously.

---

# 12. Plugin subsystem findings

## Strong parts

The plugin manager has meaningful hardening:

- per-plugin install identity
- replace/update rollback
- credentials separate from config
- encrypted credential storage through app secret owner
- result redaction
- bounded discovery
- duplicate-tool rejection
- process-tree retirement
- no automatic retry after ambiguous mutating call
- bounded images/results
- enabled-tool revocation
- stable plugin data directory
- live Blender readiness probe
- OAuth lifecycle separation

These should remain.

---

## P1-10 — Plugin refresh can durably consume its only attempt before any Refresh click occurs

**Evidence:** source
**Status:** confirmed lifecycle bug

Main process `claimPluginRefresh()` durably sets:

```text
attempted = true
```

Then the extension rechecks things such as:

- still on the exact page;
- refresh connection state;
- button still enabled/current.

Only after those checks does it click.

If one of those **pre-click** checks fails, `failPluginRefresh()` records an error but does not convert the durable state back into a retryable pre-action lease.

The result can be:

```text
durable "attempted"
actual browser click count = 0
automatic retry disabled
```

### Fix

Split:

```text
lease/claim
from
sideEffectAttempted
```

Suggested states:

```text
pending
leased
clicking   ← durable immediately before click
verifying
complete
manual-required
```

A proved zero-click failure can safely release `leased → pending`.

Only `clicking` or later should become non-replayable automatically.

---

## P2-04 — npm plugin installation relies on cwd instead of an explicit package prefix

**Evidence:** source + direct npm behavior reproduction
**Status:** confirmed containment weakness; practical severity depends on production directory ancestry

Plugin npm install runs npm with a requested generation directory as `cwd`.

npm can search upward for a package root.

Prime reproduction from a nested empty directory in this repository:

```text
npm prefix
→ E:\Octo Chat

npm root
→ E:\Octo Chat\node_modules
```

This proves cwd alone is not a package-root boundary.

Production plugin generations normally live under app userData, where an ancestor `package.json` is unlikely, so this is not evidence that production has already escaped into the app repository.

It is still the wrong installation contract.

### Fix

For every npm plugin generation:

- explicitly create its own package root;
- pass `--prefix <generationDir>` or equivalent exact npm project-root argument;
- verify resulting `node_modules` is under the generation directory;
- reject unexpected lock/package output outside it.

Add a regression where the plugin generation is nested underneath a parent containing `package.json`.

---

## P1-11 — Playwright live tests do not validate the production configuration

**Evidence:** source + tests
**Status:** confirmed product/test parity gap

The live Playwright test:

- installs Chromium;
- adds `--headless`;
- selects `--browser chromium`;
- adds `--isolated`.

Production installation/manager does not perform the exact same provisioning/launch transformation.

Production primarily sets upstream environment such as:

```text
PLAYWRIGHT_MCP_CODEGEN=none
```

So a green live test can demonstrate:

> “Playwright works after the test modifies its runtime.”

It does not demonstrate:

> “Playwright works exactly as a user receives it.”

### Fix

Pick one supported production contract.

#### Option A — app-owned browser runtime
- install/pin browser during plugin installation;
- production launch args select it;
- test uses unchanged production recipe.

#### Option B — system browser contract
- preflight exact supported browser;
- report missing browser before “Ready”;
- live test uses exact production preflight and args.

No test-only runtime repair.

---

## P2-05 — Plugin health is multidimensional but UI state is still easy to interpret as one “working/not working” fact

The system correctly distinguishes many states internally:

- installed
- enabled
- connecting
- ready
- needs-auth
- authenticating
- editor/application ready
- tool locally published
- connector schema refresh pending/manual/complete

There is yet another provider fact:

- whether the current ChatGPT conversation has the declaration cached.

Users experience this as:

> “plugin says enabled but doesn't work.”

### Mature health model

For each plugin show independently:

```text
Installation           Ready
Local server           Connected
App/editor probe       Ready / not applicable
Local schema revision  abc123
Plugins connector      Current / stale / manual refresh
Current chat schema    Current / unknown / old
Last tool probe        timestamp / failure
```

Do not make a single green switch imply the full chain.

---

## Important correction — no confirmed stale plugin-tool execution race

A subagent initially flagged the `tools/list_changed` refresh window.

Prime review found:

- refresh work is serialized by plugin ID;
- `PluginManager.call()` enters the same serialization owner;
- it rechecks live connection, exposure owner, and exact tool after rediscovery;
- an existing test explicitly proves the obsolete tool is refused while changed discovery is being published.

Do not spend engineering time “fixing” a stale execution bug that current code already fences.

---

# 13. Memory plugin assessment

The user's Memory symptom is credible as a product failure, but current static evidence does **not** support “Memory has no persistence.”

The manager supplies a stable data directory, and Memory uses a stable file path under that data area.

Plugin-generation replacement is separate from stable plugin data.

There are real manager/proxy/live test paths.

### What is missing

A product-level deterministic lifecycle proves too little about what the user actually sees.

Required acceptance:

```text
install Memory from catalog
→ wait for local Ready
→ connector refresh/current proof
→ create entity
→ read graph
→ restart plugin
→ read graph
→ restart app
→ read graph
→ update plugin
→ read graph
```

Add diagnostics:

```text
memory data directory resolved
memory file exists
size
last modified
server connected
schema current
```

Never expose graph content in diagnostics.

Until that test fails, do not patch Memory's storage path speculatively.

---

# 14. GitHub workflow audit

---

## P1-12 — Remote GitHub mutations have no first-class typed operation surface

Current coding instructions explicitly teach the agent how to use `gh` for PR bodies/comments.

That tells us remote GitHub mutation is expected to flow through the generic shell.

This is the structural reason a simple task can become:

```text
build shell command
→ temp file
→ quoting
→ PowerShell
→ visible terminal if Desktop is selected badly
```

The repository's plugin “github” source type is not a general GitHub API integration. It is installation-source logic / reviewed-recipe behavior.

### Correct split

Keep:

```text
local git operations → Core process tool
```

Add:

```text
GitHub remote operations → typed GitHub integration
```

Typed actions:

- get PR
- create/update PR
- list comments
- comment PR
- review PR
- merge PR
- get/comment issue
- close/reopen
- read workflow/check status

### Short-term policy

While the typed integration does not exist:

- prefer direct `gh` through Core `exec_command`;
- never open a visible terminal through Desktop only to run `gh`;
- never use Windows Run for GitHub operations;
- if command authority is disabled, **do not route around it through Desktop**.

---

# 15. Extension / ChatGPT integration architecture

The extension is a critical dependency on private provider behavior.

`chatgpt-dom.js` depends on details including:

- `data-testid`
- aria labels
- current composer structure
- model-picker structure
- settings Plugin panel
- sidebar New Chat controls
- Temporary Chat dialog
- SVG icon structure
- React/Fiber evidence

This is unavoidable to some degree for the product.

The maturity problem is that provider-private UI logic is also carrying too much durable workflow orchestration.

### Current responsibilities spread through extension

- transcript observation
- turn identity
- request correlation evidence
- model catalog
- composer insertion
- native Send
- uploads
- Goal helper flow
- plugin refresh
- repairs
- continuation
- worker command execution
- helper cleanup
- idle tab reuse/close
- companion UI

### Target

Split provider adapters:

```text
conversation-adapter
composer-adapter
model-picker-adapter
temporary-chat-adapter
plugins-settings-adapter
sidebar-adapter
```

Each reports:

```text
supported
degraded
unavailable
reasonCode
lastSuccessfulProbe
```

Keep durable state machine authority in main process.

---

# 16. Diagnostics / silent failure

There are many justified defensive `catch` blocks in extension/browser code.

The issue is not “never catch errors”.

The issue is operational visibility.

For provider adapters, maintain content-free counters such as:

```text
conversation_identity_unproven
composer_unavailable
composer_replaced
temporary_chat_intro_not_ready
model_picker_contract_changed
plugin_settings_row_not_found
plugin_refresh_no_control
repair_authority_revoked
browser_document_replaced
send_receipt_ambiguous
```

No:

- message text
- clipboard data
- file content
- screenshots
- secrets

should be needed to answer “which boundary failed?”

---

# 17. Filesystem / Core audit

## Strong direct sandbox

`src/main/sandbox.ts` has a comparatively good direct-file security design.

It includes:

- canonical path resolution
- direct virtual/native normalization
- `..` refusal before normalization erases intent
- Windows device/ADS invalid names
- real-root revalidation
- changed root/junction detection
- symlink/junction containment
- missing-target deepest-existing-ancestor checks
- whole drive/filesystem root refusal
- UNC root refusal
- overlapping approved root refusal

Preserve it.

### Important wording

The direct-file sandbox is **not a process sandbox**.

The code already says command execution is:

> “Run anything as you. NOT limited to approved folders.”

The product must stop using “approved folders” as if it described every authority.

---

## P2-06 — Recursive walk with “do not follow directory symlinks” still stats the symlink target before skipping it

`codex/filesystem.ts::readDirectory()` correctly keeps child links opaque.

But `walk()` later calls `getMetadata(path)`.

`getMetadata()`:

```text
lstat(path)
if symlink:
  stat(path)   // follows target
```

Only after that does `walk()` skip when:

```text
metadata.isSymlink && !followDirectorySymlinks
```

So no-follow recursive traversal can still touch target metadata before deciding not to follow.

This is not currently a full file-content sandbox escape.

It is an unnecessary target metadata/IO boundary violation.

### Fix

When `followDirectorySymlinks=false`:

- use lstat/dirent classification;
- skip link before target stat/canonicalization.

Only follow/canonicalize a link when the option explicitly says to.

---

# 18. Agent / swarm audit

## Strong current findings

The multi-agent subsystem has a lot of complexity, but the audit did **not** confirm the feared current cross-family ownership bug.

Focused tests cover:

- multiple independent primes
- worker identity scoped by run/conversation
- crash recovery
- durable spawn acceptance
- worker receipt ordering
- revival
- dormant histories
- stale incarnation fences
- prime transfer

This is important: do not rewrite the broker from scratch based only on its size.

---

## P2-07 — Dormant conversation ownership lookup remains full-history scanning

`dormantAgentForConversation()` scans:

```text
every dormant run
then every worker in each run
```

and is called from numerous ownership/routing paths.

Dormant history is currently bounded, so this is not catastrophic.

It is still a poor authority lookup primitive.

### Fix

Maintain a validated reverse index:

```text
conversationId
→ {
    primeConversationId,
    run/history id,
    agent id,
    state
  }
```

Rebuild and validate it on restore.

If duplicate ownership exists, fail closed during index construction.

---

## P2-08 — ordinary swarm persistence still eagerly builds snapshots before the durable debounce

`durable.ts` already contains:

```text
writeDurableSnapshotSoon(name, () => snapshot)
```

specifically to avoid allocating snapshots before the debounce boundary.

`src/main/index.ts` still wires ordinary swarm persistence as:

```text
onSwarmPersist(() =>
  writeDurableSoon(SWARM_STATE, snapshotSwarm())
)
```

That means bursts repeatedly materialize the entire snapshot even when only the final debounced generation will be written.

### Fix

Use the lazy snapshot facility:

```text
writeDurableSnapshotSoon(SWARM_STATE, snapshotSwarm)
```

after checking any semantic difference in how the broker expects snapshot timing.

Critical acceptance barriers must continue using `writeDurableNow`.

---

# 19. Session and renderer audit

## Corrected non-finding — stale session pagination

The first report suspected `loadMoreSessions()` could merge an old page after a refresh/session switch.

Current renderer tests explicitly exercise stale page behavior, including:

- old-page response after switching session;
- newer-page response after switching session.

Those tests pass.

Do not schedule a pagination rewrite without a new reproduction.

---

## P1-13 — full release test suite has shared-state/timing instability

This deserves its own finding rather than being hidden under “CI failed.”

Eight tests fail only under the loaded full suite and pass in isolation.

Subsystems involved:

- native computer/UIA
- code-mode runtime
- shell hint integration
- session finish/rebuild

Those are exactly the kinds of systems with:

- process lifetime
- timers
- global test seams
- fake clocks
- singleton stores
- native resource pressure

### Fix process

1. run suite repeatedly with randomized order;
2. record which prior suite predicts failure;
3. detect global mutation:
   - env
   - process shell settings
   - singleton reset omissions
   - fake timers
   - helper retirement
   - `vi.spyOn` restoration
4. reduce concurrency for native process tests if required;
5. ensure every global owner has a test reset seam;
6. only then adjust genuinely unrealistic timeouts.

Add a “repeat 3x randomized” CI job for stateful suites during stabilization.

---

## P2-09 — deterministic `exec_command` schema budget regression

Current Windows schema:

```text
3888 bytes
```

Contract:

```text
< 3800
```

The total surface can still fit while one tool becomes too heavy.

This test exists to prevent that.

Either:

- reduce description/schema duplication;
- move non-critical prose to connector instructions;
- or deliberately update the budget with a reasoned new model-discovery target.

Do not simply raise the number because the test is red.

---

## P3-01 — renderer number-format test assumes Western grouping

Production uses `Intl.NumberFormat()`.

The test expects only comma-or-dot thousands.

Under India locale:

```text
400000 → 4,00,000
```

Fix the test by:

- stubbing locale; or
- asserting semantic value through a locale-aware formatter.

Do not change correct production formatting to satisfy the test.

---

# 20. Update / release supply-chain audit

## Strong update behavior

Current updater has good integrity mechanics after it chooses the release authority:

- release asset URL is constructed locally, not trusted from response metadata;
- SHA-256 manifest is required;
- streamed download is hashed;
- mismatches are deleted;
- staged file is rehashed before use;
- withdrawn latest release retires stale authority;
- update is applied at bounded shutdown;
- no current artifact-mixing bug was confirmed.

Release workflow also has strong artifact/hash/native-runner checks.

---

## P1-14 — Windows automatic updater has no trust root independent of the mutable GitHub release authority

**Evidence:** source + security documentation
**Status:** supply-chain maturity weakness, not a checksum implementation bug

The updater obtains:

- latest version
- `SHA256SUMS.txt`
- installer

from the same GitHub repository/release authority.

The project explicitly says release binaries are not publisher-signed.

Therefore a compromise of release publishing authority can supply:

```text
malicious higher-semver installer
+
matching SHA256SUMS
```

and satisfy every current update integrity check.

A hash is excellent corruption detection.

It is not an independent authenticity proof when artifact and expected hash share the same compromised publisher.

### Fix

For Windows stable releases:

1. Authenticode-sign the installer with a protected publisher key;
2. verify signer identity before staging/execution;
3. ideally sign the update manifest separately or use TUF-style delegated metadata;
4. keep SHA-256 checks as corruption/integrity evidence.

If unsigned beta distribution is intentionally retained, disable silent automatic execution and make it an explicit downloaded/manual installer flow.

---

# 21. Plugin/external authority model

External MCP servers have their own:

- OS permissions
- network permissions
- account/service permissions

The codebase already acknowledges that approved filesystem roots do not sandbox plugins.

This must become part of the central policy/UI vocabulary.

A plugin card should say what class of authority it has:

```text
local process
remote account/service
editor/application
browser
read-only / mutating if known
```

A green “enabled” plugin must not be visually grouped with a sandboxed file API as though they share one permission boundary.

---

# 22. First-launch permission vocabulary problem

Current labels are too narrow for effective authority.

Example:

```text
Control mouse and keyboard
```

does not tell the user:

```text
can launch and operate terminal/interpreter applications
can interact with software outside approved folders
```

Recommended labels:

### Command

> **Run processes as your Windows user**
> Commands start in an approved folder but are not restricted to approved folders.

### Desktop full control

> **Control applications across this Windows session**
> Can launch and operate programs, including terminals. Not confined to approved folders.

### External plugin

> **Allow this integration's own authority**
> External MCP servers use their own operating-system or service permissions.

---

# 23. User symptom → root-cause map

| User symptom | Audit result |
| --- | --- |
| Worker bypassed denied StartupIdeaDB path using PowerShell/Run | **Confirmed cross-surface authority-model failure** |
| “Workers can escape when permission is not there” | **Confirmed** for Desktop equivalent authority; additionally unattributed Desktop opt-out is incompletely enforced |
| Desktop feels unsafe/sloppy | Broad control semantics + missing exact-identity guard on several methods + giant helper architecture |
| Extension unreliable | Critical product workflows depend on private ChatGPT DOM/Fiber plus large browser state machines |
| Playwright doesn't work reliably | **Confirmed production/test parity gap** |
| Memory plugin doesn't work | No obvious persistence defect found; requires production lifecycle reproduction and better diagnostics |
| Plugins say enabled but fail | Multi-stage readiness/provider-schema chain; plugin-refresh pre-click attempt bug; user health model insufficient |
| Agent uses terminal/PowerShell for GitHub comments/PR | No typed GitHub remote-mutation surface; generic shell is current route |
| Goal New Chat fails around Temporary Chat | ChatGPT Goal backend intentionally depends on Temporary Chat helper control plane |
| Agent confused between workspaces | No current cross-prime workspace borrowing confirmed; identity is still fragmented and learned workspace cache is implicit/bounded |
| New browser/tab actions happen unexpectedly | Known startup model-discovery opener and repair/delivery authority gaps |
| CI feels unreliable | Confirmed: deterministic failures plus eight aggregate-only failures |

---

# 24. Strong components / non-findings

A mature remediation should preserve working invariants instead of rewriting everything.

## Direct path sandbox

Strong relative to the rest of the product.

## Electron renderer security

Audit found:

- context isolation on
- Node integration off
- sandbox on
- web security on
- webviews off
- new windows denied
- navigation/redirect denied
- permissions denied
- strict CSP
- external links constrained to safe protocols/format

No generic renderer-to-main arbitrary IPC path was identified.

## Agent family ownership

No current cross-family prime/worker confusion was confirmed in current source/tests.

## Plugin changed-schema call enforcement

Old plugin declaration execution during a refresh is already fenced.

## Memory storage architecture

Stable plugin data path exists.

## Updater post-selection integrity

Download hashing, staging, rehash, and artifact path construction are strong; the gap is independent publisher authenticity.

## Release artifact mixing

No current artifact-mixing / publish fail-open defect was confirmed.

## Session pagination generation fencing

Existing renderer regressions cover it and pass.

---

# 25. Target security architecture

Current shape:

```mermaid
flowchart LR
    GPT[ChatGPT] --> CORE[Core MCP]
    GPT --> DESK[Desktop MCP]
    GPT --> PLUG[Plugins MCP]

    CORE --> FS[Direct files]
    CORE --> PROC[Shell/process]
    DESK --> WIN[Windows desktop]
    PLUG --> EXT[External MCP]
```

Each branch mostly decides its own local permission.

Target:

```mermaid
flowchart LR
    GPT[ChatGPT / Extension] --> ID[Exact Principal Resolver]
    ID --> LEASE[Workspace + Capability Lease]
    LEASE --> POLICY[Central Action Policy]

    POLICY --> CORE[Core Adapter]
    POLICY --> DESK[Desktop Adapter]
    POLICY --> GH[GitHub Adapter]
    POLICY --> PLUG[Plugin Adapter]
    POLICY --> GOAL[Goal Control Plane]

    CORE --> FS[Direct-file sandbox]
    CORE --> PROC[Process runner]
    DESK --> WIN[Windows helper]
    GH --> API[GitHub API]
    PLUG --> MCP[External MCP servers/services]
    GOAL --> PROVIDER[Goal provider/helper]

    POLICY --> AUDIT[Structured diagnostic event]
```

---

# 26. Principal model

Create one immutable internal principal object for a call:

```text
Principal
- conversationId
- localSessionId
- sessionEpoch
- requestId
- runId?
- agentId?
- sourceDocumentId?
- navigationEpoch?
```

Unknown identity is represented as unknown.

Do not substitute:

- active tab
- newest run
- selected chat
- worker display label
- timing proximity

for missing proof.

---

# 27. Workspace / capability lease

```text
WorkspaceLease
- leaseId
- principal / local session
- approvedRootId
- projectId?
- projectRealPath
- projectVirtualPath
- generation
- issuedAt
```

A worker receives the exact prime lease at durable spawn acceptance.

A project change rotates the lease.

A stale run cannot consume a newer lease.

The learned workspace cache can remain for shorthand; it must not be the durable authority.

---

# 28. Central action classification

Before any powerful adapter executes:

```text
ActionContext
- principal
- sourceSurface
- actionClass
- target
- capability
- workspaceLease?
- operationId
```

Action classes:

```text
observe
read-data
write-data
execute-process
launch-application
desktop-interact
clipboard-read
clipboard-write
remote-read
remote-mutate
```

Policy returns:

```text
ALLOW / DENY
reasonCode
effectiveAuthority
auditMetadata
```

This is where “command denied” can also prevent Desktop from recreating an equivalent execution route under restricted mode.

---

# 29. Desktop product model

Do not ship one checkbox pretending to represent one kind of risk.

### Desktop Observe
- screenshots/window metadata/accessibility
- exact principal for sensitive read if desired

### App Automation
- exact observed non-shell apps
- targeted UI operations
- restricted application launch policy

### Full Computer Control
- explicit high-risk
- off by default
- equivalent to interactive user-session authority

Clipboard can remain separately permissioned but still goes through Principal/Policy.

---

# 30. Plugin architecture target

Prefer a stable Plugins connector surface that changes rarely.

Instead of publishing every new plugin tool directly into provider connector metadata, consider:

```text
list_integrations
list_tools
describe_tool
call_tool
```

or one stable code-mode gateway.

Benefits:

- local plugin install no longer requires fragile Settings > Plugins DOM automation just to update provider schema;
- current conversation sees stable outer declarations;
- plugin lifecycle and provider refresh become separate from basic tool reachability.

Direct dynamically published tools can remain as an optional optimization if the provider supports a reliable schema invalidation protocol.

---

# 31. Goal architecture target

Use explicit roles:

```text
GoalControlProvider
UserChatTargetAllocator
GoalDebtStore
GoalDelivery
```

The control provider may be:

- API
- offline template
- ChatGPT helper

But the final executor target does not share helper identity/lifecycle.

Goal debt should have one semantic transaction owner.

---

# 32. macOS support removal

The codebase currently has a large macOS footprint.

Current scan found approximately:

- **98 files** containing macOS/darwin-related implementation/build/docs/test references
- **34 test files** with macOS-related paths

This includes historical docs too, so 98 is a maintenance-footprint count, not “98 files that must be deleted.”

## Stage A — immediately stop shipping/claiming macOS

Remove macOS from:

- CI matrix
- release matrix
- publish required artifacts
- package scripts
- setup/download docs
- current supported-platform documentation
- issue template support choices if present

This should happen first.

## Stage B — remove macOS Desktop implementation

Delete/retire:

- `tools-desktop-macos.ts`
- macOS native helper/addon
- TCC Screen Recording/Accessibility status types and UI
- macOS desktop preparation scripts
- macOS GUI/bundle/seal tests

## Stage C — remove macOS package machinery

Remove:

- `darwin` package targets
- x64 + arm64 DMG/ZIP assets
- macOS-specific native staging
- macOS signing/ad-hoc seal checks
- macOS release assembly requirements

## Stage D — simplify shared platform code carefully

Do **not** delete generic POSIX behavior needed by Linux.

Review each `darwin || linux` branch rather than searching-and-deleting “darwin”.

## Stage E — update product contract

Update atomically:

- `AGENTS.md`
- `SECURITY.md`
- README
- setup docs
- tool-surface docs
- release notes
- packaging tests
- supported platform tests

---

# 33. Remediation plan

## Phase 0 — Safety and truthfulness freeze

Do before feature work.

1. Change fresh defaults to least privilege.
2. Require exact Principal for all Desktop mutation/process/clipboard-write operations.
3. Introduce initial cross-surface policy seam.
4. Add restricted Desktop mode.
5. Rewrite permission copy.
6. Add exact StartupIdeaDB escape-class regression.
7. Stop shipping macOS.
8. Fix deterministic CI failures so release verification can become green.

### Exit criteria

- command OFF + restricted Desktop cannot produce command-equivalent execution;
- unattributed OFF blocks every mutation;
- first install is not full-authority;
- CI deterministic failures fixed.

---

## Phase 1 — Durable ownership correctness

1. Remove request-correlation semantic eviction.
2. Fence session delete/reconstruct race.
3. Fence bridge delivery after shutdown.
4. Add final claims to every browser repair.
5. Make Goal provisional debt restart-safe.
6. Separate Goal draft retirement from reply-debt handling.
7. Make Goal control ledgers transactional.
8. define continuation Goal debt transfer/supersession.

### Exit criteria

Every durable fact has:

```text
one owner
one generation
one commit point
one restore rule
```

---

## Phase 2 — User-visible reliability

1. Make Playwright live test identical to production.
2. Add Memory lifecycle acceptance.
3. Add plugin health-chain diagnostics.
4. Fix plugin refresh lease/click distinction.
5. Isolate Goal Temporary Chat helper health.
6. Add typed GitHub integration.
7. Stop passive startup browser opening.
8. diagnose and eliminate aggregate-suite flakes.

---

## Phase 3 — Architectural decomposition

1. Principal module
2. WorkspaceLease
3. central Policy Engine
4. Desktop restricted/full split
5. agents module split
6. Goal control-store split
7. extension adapter split
8. native Windows helper replacement
9. stable Plugins connector gateway

---

# 34. Required regression tests

## Authorization

### A. Exact cross-surface denial

```text
command = false
restricted Desktop = true
direct outside-path operation denied
attempt to launch PowerShell/cmd/terminal/run equivalent
→ denied by policy
```

### B. unattributed OFF

For no proven caller:

```text
launch_app → deny
press_key → deny
type_text → deny
activate_window → deny
write_clipboard → deny
stateful click/scroll/... → deny
```

### C. workspace isolation

Two conversations, two projects:

```text
chat A relative path cannot use B lease
worker A cannot use worker B / prime B lease
```

---

## Durable state

### D. correlation ownership pressure

Create more than former 50,000 pressure entries.

A previously proven owner must remain immutable or be reclaimed only by a proved terminal lifecycle rule.

### E. delete/reconstruction race

Pause reconstruction before publication, delete, resume.

No recreation.

### F. shutdown delivery race

Pause command lease fsync, initiate shutdown, release fsync.

No browser side effect.

### G. browser repair revocation

Hand out repair, revoke authority before final claim.

No reload/open.

### H. Goal provisional restart

Create exact provisional `turn:` debt before event sequence.

Restart.

Debt remains exactly once.

---

## Plugins

### I. npm nested prefix

Plugin generation nested under parent package root.

All npm output remains inside generation.

### J. Playwright

Production install and production args unchanged.

Real loopback navigation/snapshot works.

### K. Memory

Full lifecycle described earlier.

### L. refresh pre-click

Claim → page changes before click.

No click occurred, so request becomes retryable rather than permanently attempted.

---

# 35. CI stabilization plan

A stable codebase needs a stable oracle.

### Separate categories

1. pure unit tests
2. stateful singleton tests
3. child-process tests
4. Electron/renderer tests
5. native Desktop tests
6. live plugin tests
7. packaged runtime smoke

Avoid running the most process-heavy/native timing tests in a way that makes unrelated unit timing nondeterministic.

### Required diagnostics on timeout

For process/helper test timeout record:

```text
test name
helper/process PIDs
queued command count
active fake timer state
relevant singleton generation
open handles if available
```

### Repeat job

During stabilization, run the stateful subset three times with shuffled order.

No flaky test should be “quarantined forever”; use the repeat job to locate missing cleanup and then remove the quarantine.

---

# 36. Product diagnostics page

A single Diagnostics surface should expose content-free facts.

## Identity

```text
conversation proved: yes/no
local session id
request correlation state
run/agent identity
```

## Workspace

```text
project id
approved root
lease generation
current effective cwd
```

## Desktop

```text
mode: observe/app/full
helper generation
helper ready
last native error code
current principal proven
```

## Plugins

Per plugin:

```text
installed
enabled
process/server connected
application probe ready
local schema revision
provider connector schema status
current-chat declaration status
last successful probe
last failure code
```

## Goal

```text
mode
reply debt identity/state
provider attempt
helper state
target allocation state
```

## Extension

```text
conversation adapter
composer adapter
model picker adapter
temporary-chat adapter
plugins-settings adapter
```

Never include private content in this page.

---

# 37. Detailed prioritized backlog

| ID | Pri | Area | Work |
| --- | --- | --- | --- |
| SEC-001 | P0 | policy | Introduce central action-policy seam |
| SEC-002 | P0 | desktop | Exact principal for every Desktop mutation/process action |
| SEC-003 | P0 | desktop | Exact principal for clipboard write; decide clipboard-read policy |
| SEC-004 | P0 | desktop | Restricted app automation vs Full Computer Control |
| SEC-005 | P0 | config | Least-privilege first-install defaults |
| SEC-006 | P0 | UX/docs | Describe actual process/Desktop/plugin authority |
| SEC-007 | P0 | tests | StartupIdeaDB-style cross-surface escape regression |
| ID-001 | P1 | correlation | Remove arbitrary eviction of permanent request owners |
| SES-001 | P1 | sessions | Fence delete/prune against reconstruction/open publication |
| BRG-001 | P1 | bridge | Lifecycle generation fence around delivery/browser opening |
| BRG-002 | P1 | repairs | Final action claim for every repair reason |
| GOAL-001 | P1 | Goal | Persist provisional `eventSeq=0` identity correctly |
| GOAL-002 | P1 | Goal | Separate draft cancellation from reply-debt handling |
| GOAL-003 | P1 | Goal | One serialized/durable control-store transaction model |
| GOAL-004 | P1 | continuation | Explicit source debt supersession/transfer on A→B |
| GOAL-005 | P1 | Goal/extension | Isolate helper Temporary Chats from user target lifecycle |
| PLUG-001 | P1 | plugins | Fix refresh lease vs click-attempt state |
| PLUG-002 | P1 | Playwright | Production/live-test parity |
| PLUG-003 | P1 | Memory | Production-path persistence lifecycle acceptance |
| GH-001 | P1 | GitHub | Typed remote GitHub integration |
| CI-001 | P1 | CI | Remove aggregate-only flakiness/shared-state leakage |
| REL-001 | P1 | CI | Repair deterministic MCP schema-budget regression |
| SUP-001 | P1 | updater | Add independent publisher authenticity / signing |
| EXT-001 | P1 | extension | Split provider DOM adapters and health state |
| EXT-002 | P1 | architecture | Move durable orchestration authority main-side |
| PLATFORM-001 | P1 | macOS | Remove macOS from CI/release/publish/docs immediately |
| PLATFORM-002 | P2 | macOS | Remove mac-only runtime/helper/tests |
| PLUG-004 | P2 | npm install | Force exact npm prefix/project root |
| PLUG-005 | P2 | UX | Expose plugin health chain separately |
| BRG-003 | P2 | startup | Eliminate passive app-show browser opener |
| BRG-004 | P2 | pairing | Decide/harden same-user loopback pairing trust |
| FS-001 | P2 | filesystem | Skip symlink target stat when no-follow |
| AG-001 | P2 | agents | Dormant conversation reverse index |
| AG-002 | P2 | persistence | Lazy swarm snapshot debounce |
| WS-001 | P2 | workspace | Durable WorkspaceLease; learned cwd only convenience |
| MCP-001 | P2 | MCP | Reduce/rejustify `exec_command` schema size |
| OBS-001 | P2 | diagnostics | Content-free subsystem health page |
| TEST-001 | P3 | tests | Make number-format assertion locale-safe |
| DOC-001 | P3 | plugins | Correct tool-limit/documentation drift |

---

# 38. Things not to do

## Do not solve Desktop escape with a PowerShell denylist

There are too many equivalent execution paths.

## Do not add another prompt sentence saying “don't use a terminal”

Prompts are not authorization.

## Do not make the direct path sandbox more complicated to solve Desktop/process authority

The direct sandbox is not the layer that was bypassed.

## Do not keep full capability defaults and add more warning text

Change defaults.

## Do not auto-retry ambiguous plugin mutations

Current refusal to replay ambiguous calls is correct.

## Do not patch Memory persistence blindly

First reproduce the production lifecycle.

## Do not special-case Playwright only in test code

Test production.

## Do not throw out agents/bridge WAL work wholesale

Several difficult crash/ownership paths are already well tested and correct.

## Do not “fix” the locale failure by forcing US formatting in production

Fix the test.

## Do not hide aggregate CI instability by multiplying every timeout

Find contamination/resource ownership.

---

# 39. Definition of a mature Octo Chat release

Do not call the product mature until these are true:

- A denied effective action cannot be recreated through another surface without a stronger explicit grant.
- Every mutation has an exact Principal.
- Every worker inherits an explicit lease, never a guessed workspace.
- Full Desktop control is off by default and accurately described.
- “Unattributed Off” really means no unattributed mutation.
- Request ownership cannot disappear because an LRU filled.
- Session deletion cannot race reconstruction.
- Shutdown cannot later produce a browser side effect.
- Every browser repair revalidates authority immediately before acting.
- Goal debt survives restart and compaction correctly.
- Goal helper failure is separate from user-chat target failure.
- Playwright production path is the tested path.
- Memory persistence is lifecycle-tested.
- GitHub remote mutations do not require terminal improvisation.
- Plugins expose truthful health across local + provider states.
- Extension adapter breakage degrades one feature with a specific reason code.
- Full `verify:ci` is reliably green and repeatable.
- Windows packaged runtime smoke covers the actual installer payload.
- macOS is no longer in the current support matrix while it is intentionally unsupported.
- Update authenticity has a publisher trust root appropriate for silent execution.
- Diagnostics explain failures without exposing user content.

---

# 40. Final architectural assessment

The codebase contains a lot of careful defensive engineering. The difficult parts are not being ignored; many comments and tests document real historical failures and encode hard-earned invariants.

The product has nevertheless crossed the point where subsystem-local safety is enough.

The decisive next step is not “fix 50 random bugs.”

It is to make authority compositional:

```text
who is calling?
what exact project/workspace do they own?
what class of action is this?
what target will actually be affected?
what stronger authority does this surface imply?
is that action allowed now?
```

Then execute through one typed adapter.

Once Octo Chat has that spine, the existing strong parts become significantly more trustworthy:

- sandbox containment
- process custody
- worker WALs
- browser receipts
- plugin rollback
- Goal source identity
- native frame/ref generations

Without that spine, each new integration creates another route around the rules of every older integration.

**Windows-first, default-deny dangerous authority, exact identity, central policy, explicit leases, production-path tests, and observable state are the shortest path from the current beta to a mature and reliable product.**
