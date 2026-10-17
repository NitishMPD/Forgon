# Forgon Engine implementation plan
Author: Nitish

**Goal:** Deliver the file-first game studio described in project.md through dependent, independently verifiable deliverables. A passing schema test is not a completed editor, runtime, provider integration, exporter, or production service.

**Architecture:** Validated portable project files are authoritative. A platform-independent command store projects those files into an editor; a confined host owns optimistic persistence and watch events. PlayCanvas owns rendering/runtime; provider adapters and a separate agent service own coding sessions. A generated game cannot import studio, editor UI, agents or Tauri.

**Stack:** pnpm workspace, TypeScript strict ESM, Zod 3, Node test runner through tsx; React/PlayCanvas/Tauri/provider tooling versions must be pinned by their owning implementers after actual API checks. No new branches, commits, pushes, deployments or nested subagents in this session. Parent owns task/project/design docs. Implementation proceeds inline against docs/handoff/contracts.md.

## Current verification boundary

Only D1 schema/core is implemented in this worker's paths. Its exact check commands are below. Other deliverables remain unchecked until integration evidence exists; this document does not assert other workers' completion. Initial scope is the full roadmap; later milestones are explicit dependent work rather than silently dropped features. Existing project.md estimates are planning assumptions, not delivery promises.

Verified on Node 24.2.0 / pnpm 12.5.1: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (24 tests: 9 schema, 15 command/store). Root checks currently cover these two packages only. Pinned core dependencies: Zod 3.25.76, TypeScript 5.9.3, tsx 4.20.6, @types/node 24.10.1. pnpm 12 stores toolchain and workspace resolutions as separate YAML documents in the single pnpm-lock.yaml; retain both. Only esbuild dependency build scripts are allowed by workspace config.

## Ownership and dependencies

| Deliverable | Paths / responsible owner | Depends on |
| --- | --- | --- |
| D1 portable documents and editor transactions | root config, packages/project-schema, packages/editor-core (this worker) | none |
| D2 local host and file persistence | packages/project-io, apps/studio-desktop (desktop worker) | D1 |
| D3 edit-mode viewport and editor panels | apps/studio, packages/editor-ui, packages/game-runtime (UI/runtime owners) | D1, D2; runtime reuse audit |
| D4 architecture/reuse decisions and tooling baseline | docs/research, notices, CI (parent/audit owners) | D2/D3 spikes; agent upstream audit |
| D5 real agent sessions and scoped operations | packages/agent-bridge, apps/agent-service, composer UI (agent/UI owners) | D1, D2, D4 |
| D6 CLI, project authoring and hotel proof | packages/cli, packages/test-fixtures, examples/hotel-vertical-slice, templates (parent assigns) | D3, D5 |
| D7 game runtime and isolated play | packages/game-runtime, apps/game-preview (runtime owner) | D3, D6 |
| D8 generator bake and prefab regeneration | packages/procedural-authoring, project-schema/editor-core extensions | D6, D7 |
| D9 standalone web and Windows export | packages/cli, desktop game template, CI (parent assigns) | D4, D6, D7 |
| D10 asset/animation/VFX/audio production | packages/asset-pipeline, packages/vfx-audio, editor tools | D7, D8 |
| D11 levels, campaigns, economy and progression | packages/level-tools, packages/economy-tools, editor tools | D8, D10 |
| D12 mobile and native service bridges | packages/platform-api, native wrappers, CI | D9, D10 |
| D13 transactions, analytics and LiveOps | services, platform-api, operations UI | D11, D12 |
| D14 distribution, security, accessibility and release | desktop shell, docs, CI, notices, all owners | D1–D13 at relevant release scope |

The schema/core owner coordinates the single root dependency installation and pnpm-lock.yaml. Other owners add their own manifests; run `pnpm install` again after manifests land. Do not create npm/yarn lockfiles. Root `pnpm typecheck` and `pnpm test` discover only packages with those scripts; a missing script is not proof that a subsystem passed.

## D1: Shared file model and command core (A05, B01/B02/B05 and B06 state policy)

**Files:** package.json, pnpm-workspace.yaml, tsconfig.json, .gitignore; packages/project-schema/{src,test}; packages/editor-core/{src,test}; docs/handoff/contracts.md.
**Consumes:** platform structuredClone/crypto, installed Zod. **Produces:** exact signatures in contracts.md and public source exports.

- [x] Publish contract before downstream implementation: materialized entities, component properties and explicit refs, prefab/source identity, registries, opaque revision IO, agent events.
- [x] Implement strict unknown-input validation, finite transforms/JSON, unique IDs, hierarchy cycles, missing refs, prefab roots/sources, manifest/catalog agreement, safe relative path syntax.
- [x] Implement create/delete/rename/reparent/transform/component/batch commands; snapshot undo/redo; validation failures leave state/history intact.
- [x] Implement clean external replacement, invalid-edit retention, explicit ours/theirs conflicts, detached snapshots and stale-save protection, including own-write watcher-before-ack race.
- [x] Run `pnpm --filter @forgon/project-schema --filter @forgon/editor-core test` and the same filters with `typecheck`; require zero failures. Tests include a 100-edit undo/redo loop and save/reconcile interleavings.

**Gate:** Shared packages have no React, filesystem, PlayCanvas, Tauri or provider dependency. Full validation requires complete catalogs; structural parsing alone cannot certify missing project assets. No existing version migration is needed for the first schema version. Add migrations only when a real next version exists, with old fixture round-trip tests.

## D2: Confined filesystem and desktop feasibility (B03/B04/B06, A02)

**Files:** packages/project-io/src, its integration tests, apps/studio-desktop host/config and desktop feasibility report.
**Consumes:** `SceneIO`, `SaveSceneRequest`, `SaveSceneResult`, `SceneWatchEvent`, parser exports. **Produces:** actual `SceneIO` implementation plus project create/open/catalog reads and host IPC adapter.

- [ ] Write temporary-directory tests: create-only null revision cannot replace a file; stale byte revision returns current; valid save returns hash of exact committed bytes; missing/deleted/invalid files emit distinct states.
- [ ] Reject absolute paths, traversal, symlink/junction escapes, unsupported files and unsafe output locations after canonical containment checks. Test Windows case/drive/junction behavior. Never execute imported scripts on open.
- [ ] Serialize app writers; compare revision and atomically replace via a sibling temporary file. Inject interruption before rename and verify original bytes remain valid; clean abandoned temporary files without deleting source files.
- [ ] Drive debounced watcher notifications through parser/catalog validation. Invalid events retain the editor's last valid scene; deletion prompts recovery and does not authorize recreation over a new file.
- [ ] Run host tests, `cargo check` against installed Tauri 2 APIs, and an authorized local desktop launch. Record WebView2/GPU behavior, sidecar health/restart, packaged size and an Electron comparison with actual measurements.

**Gate:** Two app writers cannot silently overwrite. Cross-process noncooperating writer race guarantees are documented honestly; atomic rename alone is insufficient. New/open/reopen on real Windows passes without account or executable project hooks. If Rust/Tauri tooling is absent, report that gate blocked with exact prerequisite and command; web development does not substitute for desktop proof.

## D3: Live editable PlayCanvas viewport (C01–C06, Phase 1)

**Files:** apps/studio/src, packages/editor-ui/src, packages/game-runtime scene projection adapter and tests.
**Consumes:** `SceneDocument`, `EditorStore`, `SceneIO`; pinned PlayCanvas APIs and reuse findings. **Produces:** stable-ID object map, selectable edit-mode scene, hierarchy/inspector/gizmos, project UI.

- [ ] Render a scene without pressing Play. Diff entities by stable ID; preserve surviving selection, editor camera, hierarchy expansion and unaffected runtime objects across valid reloads.
- [ ] Wire hierarchy and inspector edits only through typed commands. Save using prepareSave -> saveScene -> acknowledgeSave; route watcher changes to reconcile; show invalid diagnostics and source/ours/theirs choices.
- [ ] Add source/actor/time transaction audit metadata and semantic/property/file patch output at the editor/history integration boundary. The present command core provides atomic scene results and in-memory snapshots; it does not yet persist an audit log or emit minimal textual file patches. Test a single-property edit diff and source ordering before claiming predictable minimal file changes.
- [ ] Add keyboard selection, focus and undo/redo; gizmo snapping; rename, reparent, hide/lock and accessible inspector numeric controls. Handle missing assets without losing authored data.
- [ ] Import GLB/image assets through host-safe paths and stable registry metadata; show thumbnails independent of Play. Surface unsupported component renderers explicitly.
- [ ] Run component/unit checks; perform one focused UI verification for this change using a real scene. Measure external-file-to-viewport p95 for small scenes instead of asserting the proposed <1-second target without timing data.

**Gate:** Visual transform -> file -> close/reopen preserves IDs and values. External edit -> viewport/inspector updates with selection intact. A cycle, malformed transform or deleted asset produces diagnostics and retains last valid render. Conflict resolution preserves either chosen version, and undo cannot resurrect the pre-reload file.

## D4: Reuse decisions, provenance and build baseline (A01–A05, Phase 0)

**Files:** docs/research/{playcanvas-reuse,t3-reuse}.md, architecture decision docs, THIRD_PARTY_NOTICES.md, LICENSES, CI and package manifests.
**Consumes:** measured D2/D3 spikes and exact upstream source. **Produces:** pinned dependency/commit inventory, verified reuse boundaries, license notices and runnable CI commands.

- [ ] Pin PlayCanvas/PCUI/Tauri/tooling versions and exact T3 Code commit; inspect actual public APIs, transitive licenses and hosted-service coupling.
- [ ] Decide standalone engine plus selected editor modules vs independent controls using extraction evidence. Decide T3 reusable module vs sidecar fork with update/maintenance implications. Preserve MIT notices for redistributed source.
- [ ] Record Tauri vs Electron decision from startup/GPU/footprint/debugging observations. Do not infer native renderer performance from desktop-web packaging.
- [ ] Add CI installing the single frozen pnpm lockfile, type-checking and running unit/integration checks; inventory SBOM/license/security results and clean-Windows setup instructions.

**Gate:** A fresh checkout reproduces verified checks using pinned versions. No proprietary backend/account is required for the local editor. Every adapted source has provenance and retained notices.

## D5: Real providers, sessions and scoped operations (D01–D07, Phase 2)

**Files:** apps/agent-service, packages/agent-bridge, apps/studio composer/thread/diff panels, provider tests.
**Consumes:** `AgentService`, `AgentRunRequest`, `AgentEvent`, validated project context and D4 T3 audit. **Produces:** Codex/OpenCode/Claude Code adapters and persistent provider-neutral sessions.

- [ ] Test each installed provider protocol and auth discovery using its supported mechanism; map real streaming/tool/error/exit/cancel states into monotonically sequenced events. Missing CLI/auth/quota are visible unavailable/failure states.
- [ ] Persist threads/session references and drafts; test crash/restart/reconnect, cancellation and queued/follow-up prompts. Advertise effort/models/context/cost only when the provider reports/supports them.
- [ ] Build multiline keyboard-first composer, context chips (file/scene/entity/component/prefab/asset/level/selected/errors/build/log/screenshot), attachments, slash commands and capabilities-driven controls.
- [ ] Enforce inspect/supervised/auto-edits/full-local at the host/provider boundary. Test traversal, symlink, out-of-project write, unsafe execution, secret redaction, denied/expired approval and sidecar restart. UI labels are never the security mechanism.
- [ ] Implement checkpoint/diff/approve/revert preserving unrelated dirty work. Include semantic scene differences and screenshot attachment. Test provider failure halfway through edits, conflicting restore, untracked files and checkpoint loss.

**Gate:** Real local authenticated sessions stream and cancel for each supported provider. Failed/unavailable integrations cannot emit fake success. Human approval is bound to a specific pending action and cannot be replayed. Scoped restoration never reverts others' unrelated edits.

## D6: CLI and hotel authoring proof (D08, E04/E05, alpha gate)

**Files:** packages/cli, packages/test-fixtures, templates/empty-3d, examples/hotel-vertical-slice, documentation.
**Consumes:** shared validators, host IO, runtime projection, real agent service. **Produces:** headless inspect/validate/snapshot/test/build implementations reused by editor where possible.

- [ ] Implement documented CLI subcommands with structured diagnostics/nonzero failure exits, project-root confinement and no implicit script execution during inspect/validate. CLI workers add actual package test commands before root checks count them.
- [ ] Author a deterministic original hotel fixture: at least 30 entities and 5 distinct prefab instances, lights/camera/colliders, queue/NPC behavior, original placeholder art and registered assets.
- [ ] Execute project.md acceptance demo steps 1–5: new project offline; real agent changes files; select objects in edit mode; visual edits save/reopen; ask agent to change queue/add model/audio/VFX; review diff and hot-reload.
- [ ] Attach fixture validity, screenshot, semantic/file diff, runtime log and before/after/reopen evidence. Test invalid external edit and same-property human/agent collision during this demo.

**Gate:** Every structured hotel object is individually selectable with stable identity. Audio/VFX/NPC behavior count only when runtime-supported and observed. If file/viewport/edit round-trip fails, stop broad generation and fix D1–D3 before proceeding.

## D7: Runtime lifecycle and isolated play (E03/E05, section 9)

**Files:** packages/game-runtime, apps/game-preview, runtime tests and fixture gameplay scripts.
**Consumes:** validated scene/catalog and explicit user run action. **Produces:** standalone runtime lifecycle, components/input/events/UI/save APIs, isolated snapshot preview.

- [ ] Play from a detached scene snapshot; test that edit-mode file reload does not mutate a running simulation and that stopping play never persists simulation transforms.
- [ ] Use PlayCanvas-owned camera/light/render/animation/audio capabilities; add missing conventions only. Benchmark/select physics backend and validate colliders/triggers without unsupported determinism claims.
- [ ] Implement fixed-step logic where required, mouse/touch/keyboard/gamepad actions, spawn/pooling, HUD/UI, scene events, audio and save/load/version checks.
- [ ] Run project scripts only in an explicitly launched isolated preview with scoped host bridge and no unrestricted desktop filesystem/process access. Test script exceptions, infinite-loop recovery, bridge denial, preview teardown and asset failure.
- [ ] Add screenshot/playtest replay and profiling output: draw calls, triangles, textures/memory, frame timings/GC/physics step and console failures.

**Gate:** Same fixture runs without editor imports; simulation state is disposable; untrusted script cannot gain host privileges by import/open. Hotel supports actual queue/service/reward progression, input, audio/VFX, save/restore and gameplay tests.

## D8: Deterministic authoring, bake, prefabs and overrides (E01/E02)

**Files:** packages/procedural-authoring; schema/core extensions with tests; prefab/generator editor controls.
**Consumes:** D1 stable identity and D7 runtime components. **Produces:** structured authoring SDK, deterministic seed/version/hash/provenance and generated-base plus user-override records.

- [ ] Define concrete SDK calls only for supported authored objects; generation emits ordinary validated files, not runtime-only opaque object graphs. Raw runtime code remains explicitly outside guaranteed editability unless registered.
- [ ] Run generators in controlled workers/processes without silent execution on project open. Capture errors/output and confine writes; test cancellation and resource exhaustion recovery.
- [ ] Test same seed/version/input yields same IDs/content; seed changes are reviewable. Bake into editable instances; add prefab variants and safe nested instantiation.
- [ ] Recompute generated base, replay overrides by stable ID, and expose conflicts for deleted targets or changed incompatible properties. Test moved/deleted objects, edited materials/transforms, conflicting source changes and detach-to-authored conversion.

**Gate:** Regeneration cannot erase manual edits silently. Original source, generator metadata and override diff survive save/reopen. Upgrade schema version with migration fixtures if these records change persisted format.

## D9: Independent web and Windows exports (F04, section 13 P0)

**Files:** CLI exporter, standalone runtime packaging template, Windows game wrapper, build tests/CI.
**Consumes:** D6 project/asset manifest, D7 runtime, D4 packaging decision. **Produces:** static runtime artifact and locally packaged Windows game, each with deterministic manifest/provenance.

- [ ] Bundle runtime/scripts/assets with pinned tooling; verify no editor/agent/localhost-development endpoint is bundled. Validate references, target paths and dependency/licenses before output.
- [ ] Test static output in Chromium/Firefox/Safari target matrix; record load, input/audio/save behavior, failures and performance on named devices.
- [ ] Package game assets locally for Windows; test installer/portable output on a clean VM without studio, controller/fullscreen/saves and missing-prerequisite diagnostics.
- [ ] Compare repeat build manifests; document unavoidable nondeterministic metadata. Signing and publishing remain explicit human-controlled steps, with keys outside project.

**Gate:** The same hotel project exports to web and Windows and runs offline independently. Build command success alone does not pass clean-VM/browser playback gates. No deployment in this authorized session.

## D10: Production asset, animation, VFX and audio pipeline (F03, sections 9–11)

**Files:** packages/asset-pipeline, packages/vfx-audio, editor animation/timeline/material/audio panels and fixtures.
**Consumes:** stable registry/provenance, D7 runtime and D8 overrides. **Produces:** non-destructive import settings/dependency graph, optimized target outputs and editable effect/audio/animation authoring.

- [ ] Import GLB hierarchy/materials/animation/bounds and texture/audio sources; validate corruption, size, missing dependencies and licensing. Keep originals and stable metadata through rename/reimport/deletion.
- [ ] Add thumbnails, duplicate/missing-reference reporting, material/lighting/post-effect/LOD/instancing budgets and target compression with verified redistribution rights for native tools.
- [ ] Implement animation states/blends/keyframes, particles/material/lifetime budgets and replayable VFX; cue variations/mix groups/loop/positional sound/ducking and haptics mapping.
- [ ] Test reimport preserves manual overrides, cancellation retains original assets, audio focus/mute/background behavior and per-effect runtime budgets.

**Gate:** Import/generate/preview/reimport is reproducible and reversible. Unsupported mesh quality/rig/UV/physics/optimization cases have diagnostics, not claims of production readiness.

## D11: Levels, campaigns, economy, progression and templates (F01/F02, Phase 4)

**Files:** packages/level-tools, packages/economy-tools; templates/{runner,tower-control,idle-management}; editor level/economy/campaign/UI tooling.
**Consumes:** D8 generated authoring and D10 production assets. **Produces:** editable packs, validators, seeded simulations and designer-facing reports.

- [ ] Implement grid/snapping/spawn/goal placement, duplicate/move/batch navigation, undo/version/import/export; versioned tile/hex/rule schemas where templates require them.
- [ ] Generate reproducible seeded levels with reachable/solvable/collision/budget/duplicate checks, screenshots and difficulty features. Run deterministic replay tests and multi-level validation before designer sequencing.
- [ ] Implement currency/source/sink/reward/cost/upgrade tables, inventory limits, XP/unlock/chapter graphs and checks for negative/infinite loops, unreachable nodes/dead ends and impossible requirements.
- [ ] Run seeded synthetic-player Monte Carlo with explicit assumptions; report cadence/gaps and mark results as simulation, not demonstrated retention or LTV. Retain versioned data suitable for later remote config approval.
- [ ] Add responsive anchored HUD/widget authoring, safe areas, localization keys/missing translations/font coverage/long text and keyboard/control remapping/motion preferences.

**Gate:** Designer generates, validates, edits and sequences a complete pack without losing overrides. A playable original vertical slice provides 20–30 minutes of reviewed progression; automated solvability is not a substitute for human game design review.

## D12: Android/iOS and native services (F05/F06, Phase 5)

**Files:** packages/platform-api, native wrapper projects/plugins, target CI and device reports.
**Consumes:** independent D9 runtime/export, D10 assets, mobile budgets. **Produces:** platform-neutral adapters with explicit supported capabilities and signed test artifacts when credentials/hardware exist.

- [ ] Benchmark Capacitor/WebView vs Tauri Mobile using actual shipped APIs; test graphics/memory/input/back button/safe areas/splash/orientation/pause/resume/audio/storage on named real phones.
- [ ] Implement storage/haptics/ads/purchases/analytics/remote-config/notification adapters without SDK types leaking into generic game code. Unavailable web functionality reports unavailable.
- [ ] Test rewarded ads success/cancel/timeout/duplicate callback/process death; IAP sandbox purchase/restore/refund/idempotency/receipt validation; consent/attribution behavior by platform.
- [ ] Produce test APK/AAB through Android SDK/JDK and IPA/TestFlight through macOS/Xcode with authorized signing/accounts. Keep keystores/certificates out of repository, preserve CI provenance/logs and privacy manifest requirements.

**Gate:** Real-device lifecycle, midrange performance and sandbox service evidence for each target. Missing Mac/device/account/SDK partnership is an explicit blocked gate with prerequisites; mocks or TypeScript interfaces do not establish integration. No real purchases/store publishing without separate authorization.

## D13: Trusted player data, telemetry, experiments and LiveOps (F07, Phase 6)

**Files:** services, packages/platform-api, operations/economy dashboards, data migration/rollback tests and runbooks.
**Consumes:** D11 versioned content/balance and D12 consent/transaction adapters. **Produces:** server-authoritative entitlement/reward services, reliable save/conflict migration, analytics and approved operations.

- [ ] Implement auth/player state, idempotent purchase/reward fulfillment, receipt verification, replay/rate-limit/fraud checks, refunds, save migrations and offline conflict policy. Test duplicate/out-of-order callbacks and server interruption.
- [ ] Version install/session/level/upgrade/ad/reward/purchase/error schemas; add consent-aware offline buffer/retry/deduplication, retention/deletion controls and privacy-safe observability.
- [ ] Build cohorts/funnels/performance/monetization/balance dashboards, label LTV estimates, calibrate synthetic models with actual consented telemetry and record uncertainty.
- [ ] Implement staged content/remote-config catalogs with client compatibility, audience/region/schedule/kill-switch controls, role-bound approvals/audit, canary rollout and tested rollback.
- [ ] Implement stable-unit experiment assignment, control groups, sample plan/guardrails and rollback; prohibit mobile downloadable executable changes outside platform policy.

**Gate:** Staging exercises demonstrate duplicate-safe valuable rewards, purchase restore/refund, data recovery, approval denial, rollback and privacy deletion. Production mutation, billing and publishing remain human controlled. Do not represent a local dashboard as a deployed production service.

## D14: Release and operational hardening (sections 14/15/20)

**Files:** all owned subsystem tests, release CI, Windows installer/updater, user/developer guides, notices and security/recovery runbooks.
**Consumes:** only verified capabilities from the appropriate release scope. **Produces:** explicit verification matrix and release artifacts for prototype/private alpha/developer beta/studio beta/1.0 gates.

- [ ] Test first-run/offline/new/open/reopen, imported source assets, malformed/untrusted projects, unsupported other-engine projects, backup/recovery and clean-machine portability. Document migration/import limits precisely.
- [ ] Exercise provider crash/auth expiry, preview infinite loop, lost checkpoint, interrupted save/import, deleted model and missing script diagnostics. No known P0 data loss, silent corruption or unsafe unattended execution at release.
- [ ] Verify editor accessibility/focus/keyboard/scaling/contrast/reduced motion, responsive panels and actionable error states. Parent maintains design.md and project.md with implemented behavior and limitations.
- [ ] Finish signed/pinned sidecar lifecycle, desktop prerequisite detection, update channels/checksums/rollback, credential isolation, opt-in diagnostics/telemetry and SBOM/license review.
- [ ] Publish a matrix distinguishing automated passes, manual evidence, hardware/account blockers, remaining work and human sign-off. Record exact commands and artifact paths; never infer runtime success from typechecks.

**Gate:** Prototype requires D1–D4 round-trip proof; private alpha adds verified D5/D6; developer beta adds D7–D11 and standalone web/Windows proof; studio beta adds D12 real-device evidence; 1.0 adds stable D13 operations plus all security/recovery/release gates. Durations and labels are not completion evidence.

## Integration checklist for the next workers

1. Import public package exports; do not redeclare document/store/IO/event types. `sceneSchema` checks structure; `parseScene` adds graph validation; `validateProject` certifies full catalogs.
2. UI should retain the original `SaveSnapshot` object returned by prepareSave and pass that exact object to acknowledgeSave; the host receives a serializable copy in SaveSceneRequest. This prevents forged/stale acknowledgements. Watcher-before-save-response is supported by matching a pending validated snapshot.
3. Never save through an unresolved conflict. Resolve ours/theirs locally, then compare-and-write against the external revision; choosing ours does not bypass revision checking.
4. Run `pnpm install` once all currently assigned manifests exist, then root `pnpm typecheck` and `pnpm test`. Inspect package script coverage. Add build/dev scripts only in the package that owns the runnable app; no root dummy launcher.
5. Parent records task completion only after its gate passes, and keeps incomplete roadmap items visible. Do not turn the existence of this plan into a completed roadmap claim.
