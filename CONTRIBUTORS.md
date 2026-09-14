# Contributors

Octo Chat is maintained in the [Shattermoon](https://github.com/Shattermoon) organization by [@nkcbuilds](https://github.com/nkcbuilds) and built with contributions from the community.

On 2026-09-14 the project was republished with a clean Octo Chat root commit. The previous repository/history is intentionally not the public source of truth anymore. This file preserves explicit credit for community work incorporated before that reset, including work that had originally arrived through pull requests, issues, reviews, testing, and design discussions.

## Incorporated code and designs

Listed alphabetically by GitHub handle. “Adapted” means the implementation changed during integration; it does not mean the contributor authored the entire surrounding subsystem.

| Contributor | Incorporated work |
| --- | --- |
| [@becoolmin](https://github.com/becoolmin) | Preserving window size on reopen; adapted during later window-lifecycle work. |
| [@Bemirror99](https://github.com/Bemirror99) | Resume-shadow recovery and stale Fiber attribution fixes. |
| [@devrajmahar](https://github.com/devrajmahar) | Conversation-scoped generation reset and its independent SPA recovery regression. |
| [@Firefulcar](https://github.com/Firefulcar) | Claimed Compact & Resume leases and selected-browser startup routing. |
| [@frytufrytu](https://github.com/frytufrytu) | Diagnosis and repair of blocked-handoff compaction recovery loops. |
| [@gnustella-lab](https://github.com/gnustella-lab) | Brave Browser support. |
| [@hhh2210](https://github.com/hhh2210) | Native macOS Desktop work from the earlier cross-platform generation; Desktop reply provenance, activity details, editable folder access, bounded bridge design, and companion mismatch guidance. |
| [@Inmerson](https://github.com/Inmerson) | Fresh worker placement through the Prime's extension context, background-tab placement, and independent screenshot-coordinate assertions. |
| [@JeshuaCastro](https://github.com/JeshuaCastro) | Per-worker model and reasoning selection design. |
| [@lookvincent](https://github.com/lookvincent) | Native ChatGPT artifact downloads and custom OpenAI-compatible Goal/Loop providers. |
| [@Maximapple](https://github.com/Maximapple) | Public-history scope, Project routes, swapped mouse buttons, tunnel readiness, access limits, RTL text, Linux packaging, complete session enumeration, continuation relays, handoff lifetime, Project successors, worker schemas, custom instructions, and caller-evidence waits. |
| [@PatrickSys](https://github.com/PatrickSys) | Windows installer sandbox-folder permissions. |
| [@pop15106](https://github.com/pop15106) | Correction of the unconditional Codex-quota claim in public documentation. |
| [@TaeyanG4](https://github.com/TaeyanG4) | Plugin-schema handling when a provider Refresh control is unavailable. |
| [@ventianima-lab](https://github.com/ventianima-lab) | Request-attribution, delivery, controller, stream-observation and tab-reuse investigations; exact message/conversation/page-epoch ownership fixes and receipt-promotion reproductions. |
| [@yahiaal](https://github.com/yahiaal) | Larger Plugins catalogs within the schema byte budget, including optional local code-mode exposure. |

The final pre-reset repair work also adapted community reports and patches around destination loading, expired automatic-resume claims, nested user-message extraction, disabled-permission guidance, unknown-model recovery, plan-collapse behavior, request attribution, browser placement, regional artifact delivery, and Linux validation.

## Additional reports, review and testing

Thank you to the contributors above and to:

- [@nofihq](https://github.com/nofihq) for independent Linux validation and recovery investigations.
- [@piotrczukwinski](https://github.com/piotrczukwinski) for the localized model-picker investigation and structural discovery proposal.
- [@L4XB](https://github.com/L4XB) for pinned-tab protection work and the distinction between pinned-tab and active-conversation closure.
- [@ahrorbeksoft](https://github.com/ahrorbeksoft) for macOS tray/window lifecycle review during the earlier supported-macOS generation.
- [@Akilaydin](https://github.com/Akilaydin) for reviewing fallback races and clarifying browser placement.
- [@lavalava45](https://github.com/lavalava45) for regional artifact-host reproductions.
- [@rcnir](https://github.com/rcnir) for reporting the unknown-model recovery gap.
- [@Gauthammaster2012Code](https://github.com/Gauthammaster2012Code) for reporting the plan-collapse affordance issue.

This remains a growing attribution record, not a claim that every contribution listed above was merged unchanged.

## Preserving credit going forward

Keep original authorship when merging a contribution. When adapting or consolidating contributed work, name the original author and preserve appropriate `Co-authored-by` trailers using that contributor's public GitHub noreply identity. Reports, testing, design and review deserve explicit acknowledgment without inventing code authorship.

New contributions should be referenced from the current public repository, [Shattermoon/octo-chat](https://github.com/Shattermoon/octo-chat).
