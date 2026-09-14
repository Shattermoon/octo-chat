# Octo Chat remediation program — single-maintainer linear execution plan

**Program baseline:** 2026-09-14
**Operating-model revision:** 2026-09-15 — one human maintainer, strictly linear implementation PRs
**Current repository line:** Octo Chat 2.2.0, bridge protocol 14
**Finding source:** [`octo-chat-full-audit-2026-09-14.md`](octo-chat-full-audit-2026-09-14.md)
**Historical engineering reports:** [`old docs-report/`](<old docs-report/>)

This document is the working plan for turning the 2026-09-14 audit into a sequence of reviewable pull requests owned by **one human maintainer using AI development workers**. Implementation is deliberately linear: one coding PR reaches review, evidence and merge before production work begins on the next PR. The plan defines ownership, dependencies, exact merge order, what may be investigated while CI/review is running, and the evidence required before each tranche is considered complete.

The audit was performed against the pre-reset 2.1.11 / bridge-13 tree. The current public line is 2.2.0 / bridge 14. Every implementation PR therefore starts by re-reading the current owner code and reproducing or re-confirming the finding on current `main`; an audit item is not permission to blindly paste an old fix into a moved subsystem.

## 1. Program objective

The program is complete when Octo Chat has one compositional authority model, durable ownership facts do not disappear or resurrect across crashes, browser/Goal/plugin workflows have explicit final-action fences, the Windows production path is what the tests actually exercise, and the release gate is repeatably green.

The program protects the strong invariants already identified by the audit:

- the direct filesystem sandbox remains the direct-file boundary;
- command/process custody, worker WALs and browser receipts keep their existing crash barriers;
- plugin mutations are never retried after an ambiguous side effect;
- plugin schema refresh continues refusing obsolete tool declarations;
- Electron renderer isolation/CSP/navigation guards remain strict;
- update download hashing and staged-file rehashing remain intact;
- frame, accessibility-ref, helper and run generations stay explicit;
- Memory storage is not rewritten speculatively before a production lifecycle test demonstrates a fault;
- session pagination and agent-family ownership are not redesigned without a new reproduction.

The central architectural target is:

```text
exact Principal
→ Workspace/Capability Lease
→ central Action Policy
→ typed execution adapter
→ subsystem-specific safety mechanisms
```

## 2. Human ownership model

One human maintainer owns the entire remediation program and is accountable for every pull request, review decision and merge. The previous authority-vs-reliability human split is retired. Semantic ownership still matters inside the codebase, but it no longer maps to separate people or parallel lanes.

| Human owner | Program scope | Typical semantic owners |
| --- | --- | --- |
| **Repository maintainer** | security, reliability, CI, Desktop, sessions, bridge, Goal, plugins, extension/provider adapters, workspace, updater/release | `config`, `capabilities`, policy/Principal/leases, MCP/Desktop/native boundaries, correlation/session state, bridge lifecycle, Goal ledgers, plugin manager/refresh, extension orchestration, stateful tests and release security |

For security- or durability-sensitive PRs, the maintainer performs an explicit **exact-SHA self-review after implementation is complete**, leaves a GitHub review comment recording the checklist/results/open risks, and merges only after required checks are green and substantive automated-review findings are resolved. Self-review is not described as independent human review; the evidence must be concrete enough for later audit.

### AI-worker rules

The maintainer may use up to **seven direct development subagents concurrently** when the work genuinely decomposes. Nested delegation is prohibited. Every worker receives:

- the exact project and base commit;
- one concrete question or implementation slice;
- the files or semantic owner it may change;
- invariants it must preserve;
- focused checks to run;
- the expected handoff format.

Workers on the same PR must have disjoint write ownership unless one is explicitly audit-only. The human maintainer reviews the complete diff and independently verifies security/durability claims; parallel AI reports are evidence inputs, not votes or approvals.

## 3. Work-in-progress and PR discipline

The goal is deterministic progress without hidden stacks or merge-conflict queues.

1. There is exactly **one active implementation PR** at a time. Do not start production-code changes for the next PR until the current implementation PR is merged.
2. Do not create stacked implementation PRs. A dependency is satisfied by merging the parent to `main`, then starting the child from the new `main`.
3. While the active PR is waiting on CI, CodeRabbit or deliberate self-review, the maintainer may perform read-only investigation, reproduction, test design and planning for later PRs, but must not create a second production implementation branch.
4. Cross-cutting refactors are not mixed with unrelated fixes. A PR should close one coherent set of audit IDs with one rollback/review story.
5. Every implementation PR starts from current `main`, records the audit IDs it addresses, and says which audit claim was re-confirmed on the current tree.
6. Every PR description includes: invariant, dependency, changed semantic owners, migration/restore behavior if durable state changes, regression tests, focused checks, broader checks, and any remaining evidence level that was not exercised.
7. Before merge, the maintainer reviews the **exact final pushed SHA** and leaves a GitHub comment recording the security/durability checklist where applicable, changed semantic owners, validation evidence and known residual risk. If a new commit is pushed afterward, repeat that self-review on the new SHA.
8. Merge only after dependencies are satisfied, required hosted checks are green and substantive CodeRabbit findings on the final head are resolved or explicitly dispositioned. Prefer one coherent squashed/rebased commit per PR unless preserving contributor authorship requires a different history shape.

### Work-item, state and PR naming standard

The remediation roadmap uses a stable work-item identity that is separate from GitHub's immutable
pull-request number. Never use `PR-03`, `PR-17`, or another planned PR number as the task identity.

```text
Work item: RMD-###
PR title:  [RMD-###][STATE][AREA] Short imperative title
Branch:    rmd/###-<area>-<short-slug>
```

Example:

```text
[RMD-004][REVIEW][SEC] Enforce exact Desktop Principal
rmd/004-sec-exact-desktop-principal
```

State vocabulary is fixed:

| State | Meaning |
| --- | --- |
| `DONE` | merged to `main` and verified at the claimed evidence level |
| `ACTIVE` | the one work item currently receiving implementation changes |
| `REVIEW` | implementation is complete; exact head is in self-review/CodeRabbit/hosted CI |
| `READY` | next serial item; may start only after the current `ACTIVE`/`REVIEW` item is `DONE` |
| `QUEUED` | ordered future item whose technical dependencies are satisfied or not yet relevant |
| `BLOCKED` | an explicit technical dependency or external prerequisite is not yet satisfied |

Area codes stay short and map to the audit vocabulary: `SEC`, `REL`, `ID`, `BRG`, `WS`, `GH`,
`GOAL`, `PLUG`, `EXT`, `AG`, `PLATFORM`, `OBS`, `SUP`, `CI`, `DOC`, or `FS`. A PR body starts
with `Work item`, `State`, `Area`, `Audit IDs`, `Depends on`, and `Blocks` where applicable.
GitHub's `#<number>` remains only the hosting-system identifier/link; it never determines program
order or dependency identity.

Use the branch convention for new work starting with RMD-005. Do not rename an already-open branch
solely for cosmetic consistency; the current RMD-004 branch is grandfathered until it merges.

Recommended future branch names:

```text
rmd/005-id-durable-request-session-fence
rmd/006-sec-restricted-desktop-defaults
rmd/008-brg-lifecycle-generation
rmd/012-goal-reply-debt
```

## 4. Dependency map

The graph below records technical dependencies only. It does **not** authorize parallel implementation; the authoritative execution order is the serial queue in §5.

```mermaid
flowchart TD
    R001[RMD-001 Release oracle] --> R007[RMD-007 CI shared-state fixes]
    R002[RMD-002 Action-policy seam] --> R004[RMD-004 Exact Desktop Principal]
    R004 --> R006[RMD-006 Restricted/Desktop defaults]
    R002 --> R010[RMD-010 WorkspaceLease]
    R005[RMD-005 Correlation + session deletion] --> R010
    R002 --> R011[RMD-011 Typed GitHub integration]

    R008[RMD-008 Bridge lifecycle fence] --> R009[RMD-009 Final repair claims]
    R012[RMD-012 Goal debt foundations] --> R013[RMD-013 Goal control store]
    R013 --> R014[RMD-014 Continuation debt transfer]
    R014 --> R015[RMD-015 Goal helper isolation]

    R016[RMD-016 Plugin refresh lease] --> R018[RMD-018 Playwright parity]
    R018 --> R019[RMD-019 Memory lifecycle acceptance]
    R019 --> R020[RMD-020 Plugin health chain]

    R009 --> R021[RMD-021 Extension provider adapters]
    R015 --> R021
    R016 --> R021
    R021 --> R022[RMD-022 Main-side orchestration]

    R006 --> R024[RMD-024 Remove paused macOS runtime]
    R020 --> R027[RMD-027 Diagnostics page]
    R015 --> R027
    R021 --> R027
```

## 5. Work-item queue and merge order

The queue below is the authoritative implementation order. The maintainer completes and merges one implementation PR before beginning production changes for the next. `RMD-###` is the stable work-item identity; GitHub PR numbers are not used for ordering. Dependency arrows still explain *why* an item cannot move earlier.

### Stage 0 — establish a trustworthy oracle and the policy seam

These foundation work items were completed before the single-maintainer operating-model revision. Their audit IDs and Git history remain unchanged; only the roadmap identity is standardized here.

#### [RMD-001][DONE][REL] — deterministic release-oracle repairs

**Owner:** Repository maintainer
**Audit IDs:** REL-001, TEST-001, MCP-001 first tranche
**Depends on:** none
**Blocks:** CI-001 stabilization and every later claim that `verify:ci` is a trustworthy gate

Scope:

- bring the Windows `exec_command` schema back under the deliberate per-tool budget without deleting important safety semantics;
- make the number-format renderer assertion locale-safe rather than forcing US grouping in production;
- add an explicit measurement/helper if needed so schema-budget regressions are easy to diagnose;
- do not raise the schema limit merely to make the test green.

Exit evidence:

- deterministic failing tests pass repeatedly;
- typecheck passes;
- schema size is reported in the test failure when it regresses;
- no production locale behavior is forced to a particular grouping convention.

#### [RMD-002][DONE][SEC] — central action-policy seam, behavior preserving

**Owner:** Repository maintainer
**Audit ID:** SEC-001
**Depends on:** none
**Blocks:** RMD-004, RMD-006, RMD-010, RMD-011

Scope:

- introduce the internal `Principal` / `ActionContext` vocabulary and central policy decision seam;
- classify actions such as observation, data read/write, process execution, application launch, desktop interaction, clipboard read/write and remote mutation;
- route existing powerful adapters through the seam without intentionally changing effective permissions in this PR;
- return structured allow/deny reason codes suitable for later diagnostics;
- preserve direct sandbox, plugin and process-specific enforcement below this layer.

The PR stays reviewable by being mostly behavior-preserving. It must not simultaneously introduce the complete Desktop product redesign.

Exit evidence:

- existing Core/Desktop permission tests remain green;
- representative Core and Desktop actions demonstrably pass through one policy seam;
- no adapter can silently construct a second policy vocabulary for the same action class.

#### [RMD-003][DONE][FS] — filesystem no-follow symlink metadata boundary

**Owner:** Repository maintainer
**Audit ID:** FS-001
**Depends on:** none
**Status/role:** completed early before the single-maintainer renumbering; retained as the third work item in actual execution order

Scope: classify a directory symlink with `lstat`/dirent and skip it before target `stat` when no-follow is selected.

### Stage 1 — close the P0 authority gaps and stabilize stateful CI

#### [RMD-004][REVIEW][SEC] — exact Principal on every Desktop mutation

**Owner:** Repository maintainer
**Audit IDs:** SEC-002, SEC-003
**Depends on:** RMD-002
**Blocks:** RMD-006

Scope:

- require exact caller identity for every Desktop mutation, app/process launch and clipboard write;
- make an explicit product decision for clipboard read and encode it in the same policy rather than a separate handler shortcut;
- cover `launch_app`, `press_key`, `type_text`, `activate_window`, click/scroll/value/drag/secondary actions and code-mode children;
- treat clipboard read as sensitive disclosure requiring the same exact Principal;
- keep `allowUnattributedCalls` for eligible self-contained work, not as authority for Desktop mutation/app launch/clipboard access.

Required regression:

```text
unattributed disabled + every mutation class → DENY
known exact Principal + capability enabled → existing behavior
```

#### [RMD-005][READY][ID] — durable request ownership and session deletion fencing

**Owner:** Repository maintainer
**Audit IDs:** ID-001, SES-001
**Depends on:** none
**Enables:** RMD-010's durable lease integration

Scope:

- separate permanent request-owner facts from bounded diagnostic metadata;
- remove arbitrary LRU semantics from the security ownership fact or replace them with lifecycle-proven reclamation;
- introduce per-session deletion/reconstruction generation or tombstone semantics;
- prevent in-flight `opening`/`reconciling` work from writing/publishing a deleted session.

Required regressions:

- ownership survives pressure beyond the former 50,000-entry bound;
- paused reconstruction → delete → resume cannot recreate a directory, catalog row or open session.

#### [RMD-006][BLOCKED][SEC] — restricted Desktop, least-privilege defaults and truthful permission UX

**Owner:** Repository maintainer
**Audit IDs:** SEC-004, SEC-005, SEC-006, SEC-007
**Depends on:** RMD-004
**Blocks:** RMD-024 macOS runtime deletion if shared Desktop setup files overlap

Scope:

- introduce a restricted app-automation mode distinct from explicit Full Computer Control;
- prevent restricted mode from recreating command authority through terminals, interpreters, Run/Start or arbitrary executable launch;
- make fresh dangerous capabilities opt-in rather than all-on;
- default unattributed work and multi-agent broad authority conservatively;
- rewrite permission copy so command/Desktop/plugin authority is described accurately;
- add the StartupIdeaDB-class regression showing `command=false` cannot be routed around by restricted Desktop.

Exit condition for the security freeze:

```text
command OFF + restricted Desktop
→ no command-equivalent execution route

unattributed OFF
→ no Desktop mutation

fresh install
→ no silent full-session authority
```

#### [RMD-007][QUEUED][CI] — aggregate-suite contamination and timing repair

**Owner:** Repository maintainer
**Audit ID:** CI-001
**Depends on:** RMD-001
**Linear position:** after RMD-006 in the single-maintainer queue

Scope:

- add temporary repeat/randomized-order diagnostics to the stateful/native subset;
- identify leaked environment, singleton state, fake timers, helper processes, spies or resource contention causing aggregate-only failures;
- repair owners/reset seams instead of globally multiplying timeouts;
- reduce native-test concurrency only where evidence shows resource contention rather than state leakage.

Exit evidence:

- the previously aggregate-only failing suites pass repeatedly in loaded order;
- full verification is stable over multiple consecutive runs or remaining failures have a reproducible isolated cause with a dedicated follow-up PR.

### Stage 2 — browser lifecycle, workspace authority and typed remote actions

#### [RMD-008][QUEUED][BRG] — bridge lifecycle generation around browser delivery

**Owner:** Repository maintainer
**Audit ID:** BRG-001
**Depends on:** Stage 0 baseline only
**Blocks:** RMD-009

Scope:

- give each bridge lifecycle a generation captured by delivery;
- recheck generation after awaited persistence boundaries and before browser/OS side effects;
- invalidate/cancel deferred launch work at stop/shutdown;
- terminally fence or await accepted command writes.

Required regression: pause lease persistence, initiate shutdown, release persistence, prove no browser side effect occurs.

#### [RMD-009][BLOCKED][BRG] — final authority claim for every repair

**Owner:** Repository maintainer
**Audit ID:** BRG-002
**Depends on:** RMD-008
**Blocks:** RMD-021

Scope:

- standardize all browser repair reasons on handout → browser inspection → exact final claim → one action;
- include silence, assistant-error, compaction and Goal repairs, not only attribution recovery;
- revoke safely when block/stop/supersession/current-work changes during inspection.

#### [RMD-010][BLOCKED][WS] — durable WorkspaceLease

**Owner:** Repository maintainer
**Audit ID:** WS-001
**Depends on:** RMD-002 and RMD-005
**Linear position:** after RMD-009 in the single-maintainer queue

Scope:

- create a durable lease tied to Principal/session/run and approved root/project generation;
- transfer the exact lease to workers at durable spawn acceptance;
- rotate on project changes and reject stale-generation use;
- keep learned cwd/workspace cache as convenience only.

Regression: two primes/two projects plus reused worker labels cannot cross leases.

#### [RMD-011][BLOCKED][GH] — typed GitHub remote integration

**Owner:** Repository maintainer
**Audit ID:** GH-001
**Depends on:** RMD-002; merge after RMD-006 so remote mutation follows final policy vocabulary

Scope:

- retain local Git operations under Core process execution;
- provide typed GitHub read/mutate actions for PRs, comments, reviews, issues, merge/check status;
- route remote mutations through `remote-mutate` policy decisions;
- eliminate the product need to open a visible Desktop terminal merely to run `gh`.

#### [RMD-012][QUEUED][GOAL] — Goal reply-debt foundations

**Owner:** Repository maintainer
**Audit IDs:** GOAL-001, GOAL-002
**Depends on:** no Goal refactor parent; schedule after RMD-009 if bridge overlap is high
**Blocks:** RMD-013

Scope:

- persist provisional reply obligations explicitly instead of encoding them as invalid `eventSeq=0` on restore;
- strengthen provisional identity when exact event sequence arrives;
- separate provider/draft-attempt cancellation from semantic reply-debt disposition.

### Stage 3 — Goal and plugin reliability

Goal PRs are deliberately contiguous because they share one durable control plane. Plugin PRs follow in the same linear program where they touch the same manager/extension refresh lifecycle.

#### [RMD-013][BLOCKED][GOAL] — transactional Goal control store

**Owner:** Repository maintainer
**Audit ID:** GOAL-003
**Depends on:** RMD-012
**Blocks:** RMD-014, RMD-015

Create one serialized semantic transaction owner for objectives, switches and reply obligations. Publish in-memory state only after the durable semantic commit or use an explicit WAL/generation with deterministic recovery.

#### [RMD-014][BLOCKED][GOAL] — continuation Goal debt disposition

**Owner:** Repository maintainer
**Audit ID:** GOAL-004
**Depends on:** RMD-013
**Blocks:** RMD-015

Make A→B continuation commit explicitly supersede or transfer source reply debt atomically rather than leaving a live-looking but uncollectable A obligation.

#### [RMD-015][BLOCKED][GOAL] — isolate Goal helper Temporary Chats from user targets

**Owner:** Repository maintainer
**Audit ID:** GOAL-005
**Depends on:** RMD-014
**Blocks:** RMD-021, RMD-027

Separate `GoalControlProvider`, `UserChatTargetAllocator`, debt and delivery roles. ChatGPT helper tabs get their own identity/health pool and can never be ordinary user-target candidates. Failures identify helper unavailability rather than looking like New Chat placement failure.

#### [RMD-016][QUEUED][PLUG] — plugin refresh lease vs actual click attempt

**Owner:** Repository maintainer
**Audit ID:** PLUG-001
**Depends on:** none technically; scheduled after RMD-015 by the linear queue
**Blocks:** RMD-021

Use explicit `pending → leased → clicking → verifying → complete/manual-required` semantics. A proved zero-click precondition failure releases the lease instead of permanently consuming the attempt.

#### [RMD-017][QUEUED][PLUG] — exact npm plugin installation root

**Owner:** Repository maintainer
**Audit ID:** PLUG-004
**Depends on:** none
**Linear position:** after RMD-016 in the single-maintainer queue

Force an explicit plugin generation project root/prefix and verify install output cannot walk to an ancestor package root. Add the nested-parent-package regression from the audit.

#### [RMD-018][BLOCKED][PLUG] — Playwright production/test parity

**Owner:** Repository maintainer
**Audit ID:** PLUG-002
**Depends on:** RMD-016 if shared readiness/refresh states are touched
**Blocks:** RMD-019

Choose and document one production browser contract, then make the live test use that exact install/provisioning/launch recipe with no test-only browser repair or extra flags.

#### [RMD-019][BLOCKED][PLUG] — Memory production lifecycle acceptance

**Owner:** Repository maintainer
**Audit ID:** PLUG-003
**Depends on:** RMD-018 production plugin harness
**Blocks:** RMD-020's health UI claims

Acceptance sequence:

```text
install
→ Ready/schema-current
→ create entity
→ read
→ restart plugin
→ read
→ restart app
→ read
→ update plugin
→ read
```

Do not change the stable Memory data path unless this test produces evidence requiring it.

#### [RMD-020][BLOCKED][PLUG] — plugin health chain and diagnostics signals

**Owner:** Repository maintainer
**Audit ID:** PLUG-005
**Depends on:** RMD-019 so the health vocabulary reflects proven production stages
**Blocks:** RMD-027

Expose installation, local server connection, app/editor probe, local schema revision, provider connector schema, current-chat declaration and last probe separately. A single enabled/green state must not imply the entire chain is healthy.

### Stage 4 — decomposition and secondary hardening

#### [RMD-021][BLOCKED][EXT] — provider-private extension adapters

**Owner:** Repository maintainer
**Audit ID:** EXT-001
**Depends on:** RMD-009, RMD-015, RMD-016
**Blocks:** RMD-022, RMD-027

Split conversation, composer, model-picker, Temporary Chat, Plugins settings and sidebar contracts behind explicit `supported/degraded/unavailable` adapter health. Preserve existing browser receipts/identity fences.

#### [RMD-022][BLOCKED][EXT] — move durable orchestration authority main-side

**Owner:** Repository maintainer
**Audit ID:** EXT-002
**Depends on:** RMD-021

Move durable workflow state out of provider-private DOM owners where possible. The extension should observe/perform bounded provider actions; the main process should own durable intent and generation state.

#### [RMD-023][QUEUED][AG] — agent lookup and persistence efficiency

**Owner:** Repository maintainer
**Audit IDs:** AG-001, AG-002
**Depends on:** none technically; scheduled after RMD-022 by the linear queue

Add a validated dormant `conversationId → owner` reverse index and use lazy debounced swarm snapshot materialization while retaining immediate durable acceptance barriers.

#### [RMD-024][BLOCKED][PLATFORM] — remove paused macOS runtime/helper/tests

**Owner:** Repository maintainer
**Audit ID:** PLATFORM-002
**Depends on:** RMD-006 if shared Desktop capability/config/setup files overlap

The release matrix is already Windows/Linux. This PR removes the dormant macOS Desktop helper/addon, package preparation/seal/smoke scripts and mac-only tests while preserving generic Linux POSIX behavior.

#### [RMD-025][QUEUED][BRG] — remove passive app-show browser opening

**Owner:** Repository maintainer
**Audit ID:** BRG-003
**Depends on:** none technically; scheduled after RMD-024 by the linear queue

Remove passive app-show browser opening; browser launch requires an explicit operation owner.

#### [RMD-026][QUEUED][BRG] — localhost trust decision and hardening

**Owner:** Repository maintainer
**Audit ID:** BRG-004
**Depends on:** none technically; scheduled after RMD-025 by the linear queue

Document the same-user localhost pairing threat decision and, if in scope, implement native/OS-IPC or challenge-based hardening.

`BRG-004` is allowed to end in an explicit documented threat-model decision before implementation if product requirements intentionally accept same-user local processes.

#### [RMD-027][BLOCKED][OBS] — content-free diagnostics page

**Owner:** Repository maintainer
**Audit ID:** OBS-001
**Depends on:** RMD-015, RMD-020, RMD-021 and stable Principal/lease vocabulary from RMD-002/RMD-010

Expose identity, workspace lease, Desktop mode/helper generation, plugin health chain, Goal debt/provider/target state and extension adapter health without message/file/clipboard/screenshot/secret content.

#### [RMD-028][QUEUED][SUP] — independent update authenticity

**Owner:** Repository maintainer
**Audit ID:** SUP-001
**Depends on:** no code dependency; production completion depends on publisher-key/signing infrastructure

Implement signer verification and signed-manifest/trust-root support appropriate for Windows automatic execution while preserving SHA-256 corruption checks. If signing credentials are not yet available, code/test the verification path and keep automatic execution policy honest until infrastructure is provisioned.

#### [RMD-029][BLOCKED][CI/DOC] — final release-oracle hardening

**Owner:** Repository maintainer
**Audit IDs:** CI-001 completion, DOC-001
**Depends on:** major state-machine work merged

Remove temporary diagnostic scaffolding that is no longer needed, retain useful repeat jobs for stateful owners, correct remaining plugin/tool documentation drift, and prove the supported Windows/Linux CI/release gate is repeatable.

## 6. What the maintainer does while waiting

Waiting for CI, CodeRabbit, a deliberate review pass or an external dependency does not justify a second implementation branch. The program stays linear. While the active PR is waiting, the maintainer may use the time for work that cannot create merge debt:

1. perform a read-only audit of the active PR against the security/durability checklist;
2. investigate the *next* queued PR on current `main` without editing production files;
3. reproduce a known failure and record the smallest deterministic test design without committing the fix yet;
4. inspect upstream/provider/platform behavior needed by a later PR and record evidence;
5. prepare adversarial test cases or migration/recovery scenarios as notes;
6. review CodeRabbit findings and CI failures for the active exact SHA;
7. update factual worklog evidence for the active PR.

Do not open a second coding PR, do not create a stacked child, and do not commit production changes for the next queue item until the active implementation PR is merged. AI workers may perform bounded read-only investigations in parallel; their reports are preparation for the maintainer's later implementation, not hidden parallel development.

## 7. Daily continuous-working loop

The maintainer repeats this operating loop:

1. fetch/sync current `main` and read this program's current queue;
2. take the first unmerged PR in the serial queue whose technical dependencies are satisfied and note them in the branch/PR description;
3. inspect current source/callers/tests before modifying anything;
4. delegate bounded slices to AI workers when useful, with a maximum of seven direct workers and no nested delegation;
5. keep one human semantic owner for the PR and resolve worker overlaps before integration;
6. run focused tests while iterating;
7. inspect the full diff, run the required subsystem gate, then open/update the PR;
8. perform an exact-final-SHA self-review; for high-risk work leave a GitHub comment that explicitly answers the checklist in §9 and records unresolved risk;
9. resolve or disposition substantive CodeRabbit findings and inspect hosted CI on that same final head;
10. merge only after dependencies and required checks are satisfied;
11. fetch current `main`, verify the merge, then begin the next serial queue item from that new base;
12. update this roadmap only when dependency/order reality changes—not for routine percentage/status tracking.

## 8. Required PR evidence

Every implementation PR must state which evidence level it actually reached:

```text
source
→ focused tests
→ full test gate
→ build
→ package
→ installed payload
→ live browser/device/provider behavior
```

Passing a lower level cannot be described as proving a higher one.

### Minimum by change class

| Change class | Minimum evidence before merge |
| --- | --- |
| pure policy/state logic | focused deterministic regression + typecheck + relevant stateful suite |
| Desktop/native boundary | focused native/tool tests + full relevant MCP/permission suite; package smoke when packaged bytes change |
| bridge/extension browser behavior | bridge + extension focused tests; live browser evidence only when the PR claims provider behavior |
| durable session/Goal/agent state | crash/restart regression plus focused store/state-machine suite |
| plugin manager/install | plugin manager/installer/proxy tests; live plugin test when claiming external runtime readiness |
| release/update | source tests + build/package/hash/signature evidence appropriate to the changed stage |
| CI-only | demonstrate the failure before and stable repeated pass after; avoid changing production behavior to satisfy a flaky oracle |

## 9. Review checklist for security and durability PRs

Before merging a security- or durability-sensitive PR, the maintainer answers these questions explicitly in the exact-SHA self-review comment:

- Who owns the action/state before and after this change?
- What exact generation/Principal proves that owner?
- Can a second surface recreate an action that this PR denies?
- Where is the irreversible side-effect boundary?
- Is authority revalidated immediately before that boundary after every relevant `await`?
- What happens if the process crashes before and after the durable commit?
- Can deletion/revocation be undone by in-flight stale work?
- Does restore reconstruct one state that could actually have been accepted live?
- Does the test exercise the failing interleaving, not only the settled happy path?
- Did the PR preserve existing no-retry, sandbox, receipt and generation invariants?

## 10. Stage release gates

### Gate A — after Stage 1

- deterministic schema/locale tests are green;
- `command=false` plus restricted Desktop cannot create command-equivalent execution;
- unattributed disabled means no unattributed mutation;
- fresh installs no longer silently grant broad dangerous authority;
- aggregate test instability has a reproducible owner and is either fixed or narrowed to an explicit remaining PR.

No new high-authority feature work should bypass this gate.

### Gate B — after Stage 2

- permanent ownership facts do not disappear under cache pressure;
- deleted sessions cannot be resurrected by reconstruction;
- shutdown cannot later create a browser side effect;
- every repair has a final action claim;
- workers/projects use explicit durable workspace leases;
- remote GitHub mutation no longer requires Desktop-terminal improvisation.

### Gate C — after Stage 3

- Goal provisional debt survives restart exactly once;
- attempt cancellation does not silently settle semantic debt;
- continuation debt is explicitly transferred/superseded;
- helper Temporary Chats cannot be confused with user targets;
- plugin refresh distinguishes lease from click;
- Playwright live tests use production configuration;
- Memory persistence has a production-path lifecycle acceptance test;
- plugin status describes the full readiness chain.

### Gate D — mature-release candidate

- provider-private extension dependencies are isolated behind health-reporting adapters;
- durable orchestration owners live main-side where practical;
- supported platform scope contains no accidental macOS shipping path;
- update execution has an authenticity policy suitable for automatic installation;
- diagnostics identify subsystem failures without private content;
- full supported-platform verification is repeatably green;
- the current README, `SECURITY.md`, `AGENTS.md`, setup docs and tool surface describe actual authority and supported behavior.

## 11. Single-maintainer serial task board

The following order is authoritative unless a newly reproduced dependency forces this document to be revised. `State` uses the vocabulary in §3. The next implementation always starts from current `main` only after the current `ACTIVE`/`REVIEW` item is `DONE`.

| Seq | Work item | Area | State | Scope | Depends on / gate |
| ---: | --- | --- | --- | --- | --- |
| 001 | RMD-001 | REL | `DONE` | release-oracle/schema/locale repairs | none |
| 002 | RMD-002 | SEC | `DONE` | central action-policy seam | none |
| 003 | RMD-003 | FS | `DONE` | no-follow symlink metadata boundary | none |
| 004 | **RMD-004** | SEC | **`REVIEW`** | exact Desktop Principal | RMD-002 |
| 005 | **RMD-005** | ID | **`READY`** | durable request ownership + session deletion fencing | serial gate: RMD-004 must become `DONE` |
| 006 | RMD-006 | SEC | `BLOCKED` | restricted Desktop + least-privilege defaults | RMD-004 |
| 007 | RMD-007 | CI | `QUEUED` | aggregate-suite contamination/timing repair | RMD-001; scheduled after RMD-006 |
| 008 | RMD-008 | BRG | `QUEUED` | bridge lifecycle generation | Stage 0 baseline; scheduled after RMD-007 |
| 009 | RMD-009 | BRG | `BLOCKED` | final repair authority claim | RMD-008 |
| 010 | RMD-010 | WS | `BLOCKED` | durable WorkspaceLease | RMD-002 + RMD-005; scheduled after RMD-009 |
| 011 | RMD-011 | GH | `BLOCKED` | typed GitHub remote integration | RMD-002 + final RMD-006 policy vocabulary |
| 012 | RMD-012 | GOAL | `QUEUED` | reply-debt foundations | scheduled after RMD-011/RMD-009 |
| 013 | RMD-013 | GOAL | `BLOCKED` | transactional Goal control store | RMD-012 |
| 014 | RMD-014 | GOAL | `BLOCKED` | continuation debt disposition | RMD-013 |
| 015 | RMD-015 | GOAL | `BLOCKED` | helper Temporary Chat isolation | RMD-014 |
| 016 | RMD-016 | PLUG | `QUEUED` | refresh lease vs click attempt | scheduled after RMD-015 |
| 017 | RMD-017 | PLUG | `QUEUED` | exact npm installation root | scheduled after RMD-016 |
| 018 | RMD-018 | PLUG | `BLOCKED` | Playwright production/test parity | RMD-016 if shared readiness state changes; after RMD-017 |
| 019 | RMD-019 | PLUG | `BLOCKED` | Memory production lifecycle acceptance | RMD-018 |
| 020 | RMD-020 | PLUG | `BLOCKED` | plugin health chain + diagnostics signals | RMD-019 |
| 021 | RMD-021 | EXT | `BLOCKED` | provider-private extension adapters | RMD-009 + RMD-015 + RMD-016 |
| 022 | RMD-022 | EXT | `BLOCKED` | move durable orchestration main-side | RMD-021 |
| 023 | RMD-023 | AG | `QUEUED` | agent lookup + persistence efficiency | scheduled after RMD-022 |
| 024 | RMD-024 | PLATFORM | `BLOCKED` | remove paused macOS runtime/helper/tests | RMD-006 where shared Desktop files overlap |
| 025 | RMD-025 | BRG | `QUEUED` | passive app-show browser opening removal | scheduled after RMD-024 |
| 026 | RMD-026 | BRG | `QUEUED` | localhost trust decision/hardening | scheduled after RMD-025 |
| 027 | RMD-027 | OBS | `BLOCKED` | content-free diagnostics page | RMD-010 + RMD-015 + RMD-020 + RMD-021 |
| 028 | RMD-028 | SUP | `QUEUED` | independent update authenticity | external signing infrastructure may gate production completion |
| 029 | RMD-029 | CI/DOC | `BLOCKED` | final release-oracle hardening | major state-machine work merged |

This is a **one-implementation-PR-at-a-time** program. Parallelism is limited to bounded AI investigation inside the current PR or read-only preparation for later work. There is no second human lane, no counterpart-review gate, no fallback coding branch, and no stacked implementation queue.

## 12. Backlog coverage

The plan maps every audit backlog item to a stable remediation work item or explicit decision point:

| Audit ID | Work item |
| --- | --- |
| SEC-001 | RMD-002 |
| SEC-002, SEC-003 | RMD-004 |
| SEC-004, SEC-005, SEC-006, SEC-007 | RMD-006 |
| ID-001, SES-001 | RMD-005 |
| BRG-001 | RMD-008 |
| BRG-002 | RMD-009 |
| BRG-003 | RMD-025 |
| BRG-004 | RMD-026 |
| GOAL-001, GOAL-002 | RMD-012 |
| GOAL-003 | RMD-013 |
| GOAL-004 | RMD-014 |
| GOAL-005 | RMD-015 |
| PLUG-001 | RMD-016 |
| PLUG-002 | RMD-018 |
| PLUG-003 | RMD-019 |
| PLUG-004 | RMD-017 |
| PLUG-005 | RMD-020 |
| GH-001 | RMD-011 |
| CI-001 | RMD-007, RMD-029 |
| REL-001, MCP-001, TEST-001 | RMD-001 |
| SUP-001 | RMD-028 |
| EXT-001 | RMD-021 |
| EXT-002 | RMD-022 |
| PLATFORM-001 | already completed on the 2.2.0 public baseline; keep covered by packaging tests |
| PLATFORM-002 | RMD-024 |
| FS-001 | RMD-003 |
| AG-001, AG-002 | RMD-023 |
| WS-001 | RMD-010 |
| OBS-001 | RMD-027 |
| DOC-001 | RMD-029 |

If a future reproduction disproves an audit item, close it by adding the proof/test to the appropriate PR or by documenting the non-finding here. Do not preserve work merely because it appeared in the audit.
