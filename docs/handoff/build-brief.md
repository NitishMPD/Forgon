# Forgon Engine build coordination
Author: Nitish

## User-approved execution
Build the project.md roadmap in one sustained coordinated session, with internal correctness gates. Parent orchestrates and integrates. At most five concurrent delegated workers; replacements allowed. Use pnpm only and one pnpm-lock.yaml. Branding: Forgon Engine. Visual reference: T3 Code. Initial app providers: Codex, OpenCode, Claude Code. Audit and reuse T3 orchestration where suitable. Builds, local servers, app launches and tests are authorized for this session. Do not push, deploy, commit, or create branches. Do not expose credentials or silently execute imported project scripts. No production purchases, publishing or LiveOps mutations.

## Shared working rules
You are not alone in this checkout. Own only assigned paths, preserve other edits, and never revert others. No nested subagents. Read project.md and this brief. Parent owns project.md, design.md, tasks/task_17_oct.md and coordination docs. Report changes, tests, interface decisions and actual limitations. Do not claim placeholders, mocks or unavailable integrations work. Do not reduce roadmap scope silently: record remaining requirements and gates. Use existing platform/engine capabilities, avoid speculative scaffolding. Tests must cover data-loss/security boundaries.

## Initial ownership
- GPT-6.1 Sol: root pnpm workspace/config and packages/project-schema, packages/editor-core, shared contract document docs/handoff/contracts.md; implementation plan docs/handoff/implementation-plan.md.
- Haiku 5.5 medium via OpenCode Anthropic: apps/studio and packages/editor-ui; first return UI design/reuse findings before implementation against frozen contracts.
- MiMo V2.6 Pro via OpenCode DeepInfra: apps/studio-desktop and packages/project-io; first desktop feasibility and IO contract findings.
- DeepSeek V4.1 Flash Free via OpenCode: docs/research/t3-reuse.md and later apps/agent-service, packages/agent-bridge; upstream audit first.
- GLM 5.3 Flash via OpenCode Constellation: docs/research/playcanvas-reuse.md; engine/editor reuse and export audit first. Runtime ownership assigned after contracts.
- TokenHarbor DeepSeek: replacement pool.

## Acceptance order
1. Stable-ID validated files -> live selectable PlayCanvas objects -> human edit -> conflict-safe persistence -> reopen. Invalid external edits retain last valid scene; play uses snapshot; imported code cannot execute on open.
2. Real provider sessions, streaming, cancellation, scoped permissions, diffs and safe checkpoint rollback; no faux security toggles.
3. Hotel fixture: 30 entities, 5 prefab instances, NPC queue, colliders, light/camera, assets/audio/VFX; visual and file edits coexist.
4. Standalone web/Windows export, then additional authoring tools and mobile/production integrations according to project.md, respecting hardware/account/signing gates.
5. Honest verification matrix and user guide covering first-run, existing Forgon projects, imported assets, and limits for other engines' projects.

No agent may treat an audit as completion of the overall build. Audits return concrete reuse decisions so the parent can dispatch subsequent implementation waves.

Ownership update: GPT-6.1 Sol now owns packages/project-io after completing authoring/fixtures/CLI. MiMo retains desktop feasibility research and future apps/studio-desktop Rust shell. Parent owns root installs/lockfile/config.
`nDesktop implementation decision: Node project-io owns persistence/watchers/validation. Tauri owns native window/dialog, restricted IPC and managed-process lifecycle. Desktop host imports project-io/node; do not duplicate filesystem implementation in Rust. Agent-service owns managed T3 lifecycle behind desktop delegation.
Ownership update: Sol now owns studio/editor-ui integration and narrow editor-core enabled command addition. Haiku UI task is complete. Runtime, desktop and provider workers retain their paths.
Ownership update: GLM runtime stopped/confirmed interrupted. Sol now owns game-runtime, game-preview and CLI export completion; preserve existing partial runtime and exporter tests.
