# Octo Chat

**A local ChatGPT coding workspace with MCP tools, durable sessions, reusable workers, Goal/Loop automation, plugins, and optional Windows desktop control.**

[Releases](https://github.com/Shattermoon/octo-chat/releases) · [Setup](docs/setup.md) · [Plugins](docs/plugins.md) · [Security](SECURITY.md) · [Audit](docs/octo-chat-full-audit-2026-09-14.md) · [Remediation plan](docs/remediation-program-2026-09-14.md) · [Contributing](CONTRIBUTING.md)

Octo Chat runs on your computer and gives ChatGPT a set of local MCP connectors. Core handles approved project files and terminal work, Desktop adds native Windows automation when you explicitly enable it, and Plugins exposes external MCP integrations you install in the app.

> **Beta:** Octo Chat is still under active development. Review the permission model before connecting it to ChatGPT, and keep backups of important work.

## What it does

- **Local coding tools** — read, search, edit, patch, save generated artifacts, and run real terminal commands.
- **Durable sessions** — keep local activity/history, continue work across chats, and Compact & Resume long conversations.
- **Reusable workers** — spawn parallel ChatGPT workers, message them, let them sleep, and wake the same conversations later.
- **Goal and Loop** — optionally drive follow-up turns from a saved objective or continuous loop policy.
- **External MCP plugins** — install reviewed or custom MCP servers and expose them through a separate Plugins connector.
- **Windows desktop automation** — optional screen/window inspection, app control, input, and clipboard tools.
- **Companion extension** — connects ChatGPT pages to the local app for conversation identity, recording, model selection, delivery, workers, and recovery.

## Supported platforms

| Platform | Current support |
| --- | --- |
| Windows 10/11 x64 / ARM64 | **Supported** — Core, Plugins, companion extension, and native Desktop automation |
| Linux x64 / ARM64 | **Supported** — Core, Plugins, companion extension; no native Desktop automation |
| macOS | **Not supported** — no current build, CI, packaging target or native Desktop backend |

Chrome, Edge, or Brave is required for the companion extension workflow.

On Linux, prefer the DEB on Debian/Ubuntu. If the host disables unprivileged user namespaces, the portable AppImage can fall back to `--no-sandbox`; the release workflow smoke-tests that fallback explicitly.

## Get started

1. Install an Octo Chat build from [Releases](https://github.com/Shattermoon/octo-chat/releases), or run it from source.
2. Open **Settings → Workspace** and approve the project folders ChatGPT may access directly.
3. Open **Settings → Setup** and configure the **Octo Chat Core** connector in ChatGPT Developer mode. Follow the [setup guide](docs/setup.md).
4. Load the bundled `extension/` directory as an unpacked browser extension when prompted.
5. Add **Octo Chat Desktop** only if you want Windows desktop automation, and **Octo Chat Plugins** only if you install external MCP integrations.

The three model-facing connector identities are:

```text
Octo Chat Core
Octo Chat Desktop
Octo Chat Plugins
```

## Permission model

Octo Chat separates several kinds of authority. They are **not interchangeable security boundaries**:

- Approved folders constrain the app's direct filesystem tools.
- `exec_command` runs with your normal OS-user privileges and is **not confined to approved folders**.
- Windows Desktop control can operate applications across your logged-in desktop session when enabled.
- External MCP plugins keep the operating-system, application, network, or service permissions of those integrations.
- Read-only mode disables effective file writes, command execution, Desktop control, and clipboard writes.

See [SECURITY.md](SECURITY.md) for the complete current security model and limitations.

## Build from source

Requirements: Node.js 22+ and npm.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

The full repository gate is:

```sh
npm run verify
```

Native packaging is platform/architecture specific. Current public release targets are Windows and Linux.

## Repository layout

```text
src/main/        Electron main process, MCP servers, sessions, agents, Goal, plugins
src/renderer/    Desktop application UI
src/shared/      Shared contracts and types
extension/       Chrome/Edge/Brave companion extension
scripts/         Build, packaging, release and verification tooling
test/            Vitest regression and integration suites
docs/            Setup, plugins, release notes and engineering documentation
```

## Data and privacy

Octo Chat stores session history locally when recording is enabled. API keys and bridge credentials use Electron secure storage where a suitable backend is available. Activity/session data is separate from those encrypted credential slots; read [SECURITY.md](SECURITY.md) before using sensitive repositories or conversations.

## Contributing

Focused bug reports and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and use GitHub's private vulnerability reporting for security issues.

Earlier community work incorporated before the clean Octo Chat public-history reset is credited in [CONTRIBUTORS.md](CONTRIBUTORS.md).

The current engineering hardening program is tracked in the [2026-09-14 remediation plan](docs/remediation-program-2026-09-14.md), based on the [authoritative full audit](docs/octo-chat-full-audit-2026-09-14.md). Earlier audits and worklogs are retained under [`docs/old docs-report/`](<docs/old docs-report/>) for historical context.

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and the `docs/licenses/` tree.
