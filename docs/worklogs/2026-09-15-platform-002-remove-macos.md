# PLATFORM-002 — remove macOS runtime and product support

**State:** DONE
**Audit ID:** PLATFORM-002
**Branch:** `feat/platform-002-remove-macos`
**Base:** `b81019cbe6504e8e5ef5243b58f3150049c546d1`
**Depends on:** SEC-002 / SEC-003 merged in PR #5

## Invariant

Octo Chat has exactly two supported runtime/release families: Windows and Linux. Native Desktop is
a Windows-only surface. An unsupported host must not acquire a dormant macOS helper, Desktop schema,
TCC permission path, packaging target, updater path or app-shell behavior merely because legacy code
still exists in the repository.

Dropping macOS must not narrow the supported Linux POSIX behavior, delete shared dependency/source
license evidence, erase stored Desktop capability choices that remain meaningful when a config is
opened on Windows, or weaken the Windows Desktop Principal/helper-generation boundaries established
by SEC-002/SEC-003.

## Re-confirmed current-tree finding

At the merged base, CI/release/package target selection already rejected Darwin, but the tree still
contained the Swift helper, N-API addon, legacy `observe`/`computer` Desktop registrar, TCC state and
renderer controls, macOS app-shell/browser/shell discovery branches, signing/smoke utilities and
mac-only tests. Current documentation still described that implementation as paused/retained.

## Change scope

- delete the macOS helper/addon, Desktop registrar, package seal/preparation/smoke scripts and
  dedicated macOS Desktop tests;
- remove macOS TCC state/IPC/preload/renderer UI and the dormant addon/subprocess transport from the
  shared native-computer owner;
- make non-Windows Desktop registration empty while keeping Windows Window2/clipboard/code-mode
  contracts and exact-Principal enforcement;
- remove Darwin tunnel/ripgrep release pins and unreachable Darwin package/runtime smoke branches;
- remove current-product macOS browser, shell, Homebrew, tray/Dock, Keychain and updater semantics;
- preserve Linux POSIX/browser/plugin/tunnel/keyring paths and shared native dependency/source
  inventory that also applies to Linux;
- change current public/maintainer documentation from “paused/retained” to explicitly unsupported;
- update the remediation board so PLATFORM-001 is recorded done and PLATFORM-002 is the active item
  immediately after merged SEC-002/SEC-003.

## Validation plan

Before review: typecheck; focused platform, packaging, MCP/Desktop, helper lifecycle, renderer,
browser/shell/tunnel/plugin/update/tray/window/config/security tests; privacy/notices; build; full
`verify:ci`. Package/runtime checks remain Windows/Linux-only. Any loaded aggregate-only timing
failure is isolated before classification rather than hidden by wider timeouts.

Before merge: push one clean review head; obtain at least two independent exact-head code reviews,
including one Windows/security boundary pass and one build/platform/documentation pass; validate
every substantive CodeRabbit finding against current code; require hosted Linux x64 and Windows x64
CI green; record the final head and residual risks here.

## Review evidence

Pre-review evidence on the implementation tree:

- `npm run typecheck` — pass.
- `npm run verify:privacy` — pass; public-history privacy gate clean.
- `npm run verify:notices` — pass; 93 production packages, 7 catalog entries and 730 pinned native source archives/patches validated.
- `npm run build` — pass.
- Broad focused regression before final review: 24 files, 532 passed / 5 skipped, then the post-review-fix platform/package/renderer/helper set passed 108/108.
- `test/mcp.test.ts` after the non-Windows contract cleanup: 173 passed / 1 Windows-host skip. Unsupported hosts publish no Desktop tools even if stored Desktop capabilities are enabled.
- Windows helper protocol/generation/retirement regressions remain green; independent native/security review found no High/Medium supported-surface regression.
- `npm run dist:dir:x64` — pass for Windows x64.
- `node scripts/smoke-packaged-runtime.mjs --platform win32 --arch x64` — pass; packaged Electron 44.3.0, Sharp 0.35.4/libvips 8.18.6, node-pty and tree-sitter runtime verified.
- Live-code/product scan found no remaining macOS/Darwin runtime branch in `src`, `scripts`, package config or GitHub workflows. Shared optional dependency/source-license metadata is intentionally retained where it also serves supported targets.

Local `npm run verify:ci` completed 4,329 passed / 25 skipped / 4 failed. `code-mode-runtime` and `exec-hints` passed immediately in isolation. The two `computer.test.ts` UIA failures also reproduced in isolation on this interactive Windows desktop because the currently selected browser window had no available current UIA root; deterministic helper generation/protocol/security suites remained green. This is recorded as environment/native-UIA evidence for hosted Windows CI rather than weakening the production UIA contract or widening test timeouts. Hosted Windows/Linux CI is therefore required before merge.

Independent pre-review findings were dispositioned before the review commit: regenerate the tracked `THIRD-PARTY-NOTICES.txt` from the updated native-license source, and remove stale Linux/non-Windows MCP expectations for the deleted legacy `observe`/`computer` surface. Both are fixed and revalidated above.

Hosted CI on review head `72e662a2ea255466998b26d39935ee260523faa6` exposed one Linux-runner-only test-harness regression in `test/computer-generation.test.ts`: after the macOS transport was removed, the lifecycle suite now spoofs `process.platform` to `win32` for every case. Node's `os.tmpdir()` chooses its environment strategy from that spoofed value, and GitHub's Linux runner has no Windows `TEMP`/`SystemRoot`, so helper/screenshot setup attempted `mkdtemp` under the synthetic path `undefined\\temp`. Production Linux never publishes/runs Desktop and production Windows has a real Windows temp environment; the failure was therefore in the cross-host Windows simulation, not a supported runtime path. The suite now captures the real host temp directory before spoofing `process.platform`, stubs `TEMP` to that directory for the Windows simulation, and restores the environment afterward. The repaired helper lifecycle set passes 29/29 locally with typecheck and `git diff --check`; a fresh hosted Linux/Windows run is required before merge.

CodeRabbit formal review `5208939897` was submitted against superseded head `523d4d84e8a0f7a835bbd0dfc58a9eec5ebad96a` with five actionable comments. Each was rechecked against current code rather than accepted mechanically. The PLATFORM-002 `ACTIVE`/`REVIEW` mismatch was already fixed in `72e662a`. Browser discovery, fresh-config capability projection and updater staging already failed closed on Darwin; their comments identified valid missing negative regressions, so explicit Darwin assertions were added. Tunnel discovery was a valid runtime finding: `commonBinaryDirsForPlatform('darwin')` still returned home-directory candidates and `locateBinary` could also accept a hint, bundled binary or PATH entry. The repair is intentionally stronger than the narrow comment: unsupported platforms now return `null` before any tunnel executable candidate is considered, and common-directory discovery also returns an empty list. Focused browser/config/tunnel/update/packaging/platform/computer-generation validation passes 183 tests with one host-dependent skip; typecheck and `git diff --check` pass. The generic static-analysis warning about the internally generated Desktop helper script path does not represent request-controlled traversal and required no production change.

Hosted Windows verification on exact head `2a166f62180d3838493cec0df4a74f130d2ef662` later exposed a separate aggregate-suite timing failure in `test/bridge.test.ts`: the three-worker bootstrap regression waited for three browser opens with `vi.waitFor`'s short wall-clock polling budget while each open is intentionally downstream of a serialized `writeDurableNow` command-lease transition. The exact test and its seven-test worker-bootstrap group passed in isolation, an earlier hosted Windows run had passed the same production path, and the full current bridge file passed once rerun locally. The test now waits on the real transaction boundary with `flushDurable()` before asserting the three opens; no production worker/bootstrap timeout, browser grace period or delivery semantics changed. The seven worker-bootstrap tests pass, the full bridge suite passes 383/383, and typecheck plus `git diff --check` remain green. A fresh exact-head Windows/Linux hosted run is still required before merge.

## Merge and post-merge evidence

- Final reviewed branch head: `faf4a3ff3699a847397ea6f1ca12c7f4924ae4ba`.
- Exact-head hosted CI run `34962158338` passed Linux x64 and Windows x64, including the published-plugin exercise on both supported hosts. The first Windows plugin attempt hit transient Fetch startup latency plus a Blender temp-directory handle race; a failed-job rerun on the identical SHA passed without product/test changes.
- Three independent exact-head reviewers passed the final `2a166f6..faf4a3f` delta and confirmed it was test/worklog-only; prior Windows/security, Linux/platform and packaging/provenance reviews covered the executable head.
- CodeRabbit formal review `5208939897`, submitted against superseded head `523d4d84`, was dismissed only after every actionable finding had been revalidated/resolved and current hosted CI was green.
- PR #9 was squash-merged to `main` as `47117219b2a478b884f5369666911be202d4bdac` on 2026-09-15.
- Post-merge scan found no tracked macOS helper/addon/Desktop registrar/package-seal/smoke path and no `darwin`/`macOS`/`macos` executable references under `src`, `scripts`, GitHub workflows, package config or builder config. Remaining Darwin/macOS strings are historical/support-policy text or third-party source/license metadata.
- Post-merge `main` validation passed `npm run typecheck`, focused platform/package/browser/config/tunnel/update/feature/connection regressions (180 passed, 1 host-dependent skip), and `npm run verify:notices` (93 production packages, 7 catalog entries, 730 pinned native source archives/patches).

PLATFORM-002 is complete. Windows and Linux are the only supported runtime/release families, and native Desktop remains Windows-only.
