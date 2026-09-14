# CodeRabbit repository review policy

**Owner:** Maintainer A

**Branch:** `chore/coderabbit-review-policy`

## Task

Add a repository-owned CodeRabbit configuration so every ordinary and stacked pull request is
automatically re-reviewed after pushes, with review attention aligned to Octo Chat's security,
durability, Desktop, plugin and release-oracle invariants rather than generic style/docstring churn.

## Invariants

- CodeRabbit is an additional reviewer, not a substitute for the remediation program's required
  counterpart review on high-risk security/durability PRs.
- Review configuration must not grant CodeRabbit authority to merge or change application code.
- Reviews prioritize preserving existing working features while finding correctness, security,
  lifecycle, concurrency and compatibility regressions.
- The repository's actual release gates (`verify:ci`, platform CI and applicable live/package
  evidence) remain authoritative; CodeRabbit findings supplement those gates.

## Configuration

- Assertive review profile for substantive findings.
- Automatic review of non-draft PRs, including stacked PRs targeting non-default branches.
- Incremental review on every push with no commit-count auto-pause.
- Repository-specific path guidance for MCP/policy, Desktop/native, durable session state, plugins,
  filesystem traversal, legal/source integrity, tests and worklogs.
- Disable the generic docstring coverage check/finishing touch because percentage coverage is not a
  release-quality signal in this repository.
- Enable `request_changes_workflow` so unresolved CodeRabbit findings/latest-commit review state can
  participate in approval; this does not merge a PR and does not replace explicit maintainer merge
  judgment or the required counterpart approval on high-risk work.

## Evidence

- Current CodeRabbit configuration documentation checked on 2026-09-14 for root
  `.coderabbit.yaml`, `reviews.profile`, `reviews.path_instructions`, automatic/incremental review,
  `auto_pause_after_reviewed_commits`, and docstring pre-merge settings.
- Parsed `.coderabbit.yaml` with PyYAML and asserted the intended critical controls.
- `git diff --check` passed.

No application runtime, package, installed-payload or live-provider behavior is changed by this PR.
