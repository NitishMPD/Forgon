# Forgon Engine
Author: Nitish

Scene-store equality compares JSON object fields independent of key order (including nested component properties), while preserving array order and actual value differences. Native JSON map reordering must not mark a saved revision invalid; different content under the same revision still fails.

Workspace shortcuts operate from the viewport as well as panels: Delete/Backspace deletes selected topmost subtrees in one undo step; Ctrl+C/X/V copy/cut/paste scene objects using an internal clipboard for this workspace session, fresh IDs and remapped internal references. Partial prefab copies are rejected before cutting; absent paste parents fall back to the root. Ctrl+A selects all, Escape deselects after closing expanded cards, F2 focuses Inspector rename, Ctrl+Shift+N creates an empty object under the selection (or at the root), X toggles Local/World when supported, and Ctrl+P toggles Play/Stop alongside F5. Existing Q/W/E/R, F, Ctrl+D, save and history shortcuts remain. Object actions leave text editing alone and mutation guards remain in force. Unity features without Forgon equivalents (Rect/combined tools, pause/step, pivot modes and scene-file creation) do not receive inert shortcuts.

Generated-scene saves capture entity additions, deletions, hierarchy/component structural edits and entity order alongside field overrides, preserving the generator base. Entity snapshots use checked before/value pairs; competing generator edits produce conflicts. Existing authoring artifacts remain readable; artifacts with structural overrides require the updated tools. Scene/authoring pair commits and revision guards remain mandatory.

Ctrl+Shift+click on an editable viewport opens placement search at the clicked surface, with primitives, project prefabs and registered GLB models. Ctrl+Shift+A while the viewport is focused opens the same search at the centre. Placement reuses the existing surface/alignment and one-step undo flow; no scripts run. Play, invalid-file and conflict guards apply.

The desktop Studio window disables Tauri's native drag/drop interception (`dragDropEnabled: false`) so WebView2 delivers HTML drag events for asset placement, hierarchy reparenting and composer references on Windows. File imports continue through the native picker; no Tauri file-drop event integration is used. Changing this window configuration requires a desktop restart (and a rebuild for packaged installations); native drag behavior requires Windows verification.

The workspace logo returns to the project launcher through the same guarded close flow as Close project. Unsaved edits require the explicit Discard changes and close action; repeated logo or close presses cannot bypass confirmation. Both entry points are unavailable during an active save.

**Project plan / technical PRD / implementation roadmap**  
**Product name:** Forgon Engine  
**Version:** 1.0 planning draft  
**Date:** 16 October 2026  
**Primary development platform:** Windows desktop  
**Game targets:** Web, Windows, Android, iOS  
**Primary engine:** Three.js (r186), with Forgon's own engine layer on top (switched from PlayCanvas on 17 October 2026; see 0.1)  
**Desktop stack:** Tauri 2 + Rust + React/TypeScript  
**AI foundation:** Adapted components and concepts from T3 Code  
**Project model:** Local-first, agent-readable, file-based; no mandatory MCP protocol  
**Status:** Implementation in progress; subsystem checks pass, integrated desktop acceptance remains pending

**Brand assets:** The shared Forgon SVG in `packages/editor-ui/src/brand/forgon.svg` supplies launcher/rail identity and Studio's favicon. Regenerate the Windows window/installer icon from that source with `powershell -ExecutionPolicy Bypass -File apps/studio-desktop/scripts/brand-icon.ps1` after changing it. Native icon appearance requires a subsequent desktop build and Windows verification.

---

## 0. Executive summary

Build a **Windows-first, local-first game development studio** in which people and AI coding agents edit the **same on-disk game project**. It should combine the structured scene authoring of Godot, the visual level-editing experience of Unity/Godot, and the multi-provider, multi-thread coding experience of T3 Code.

The platform must do considerably more than prompt-to-prototype. Its long-term goal is **end-to-end hypercasual/hybrid-casual game production**, including asset generation/import, visual scene and level editing, physics, animations, VFX, audio, UI, progression, economy simulation, automated tests, build/export, mobile monetization integration, analytics, LiveOps, and post-launch operations.

**Critical product promise:** An agent can create or edit a model, scene, level, or component directly in files; the open editor notices the change and displays it in the 3D viewport immediately, with stable, individually selectable objects. A person can visually edit those objects and have changes persist back to the project. No need to press Play simply to inspect generated content.

**Recommended implementation:** Use PlayCanvas Engine directly and reuse selected PlayCanvas editor frontend components and PCUI where practical. Do **not** make the proprietary PlayCanvas hosted editor backend a dependency. Build our own local project document model, file watcher, importer, asset registry, editor state, and serializer. Adapt T3 Code's orchestration, provider adapters, composer patterns, diff/checkpoint flow, and thread management as a distinct local agent service. Ship the studio in Tauri 2; keep agents and JavaScript tooling in a Node/Bun-based sidecar rather than rewriting their ecosystem in Rust.

**Core principle:** **Files are the source of truth; the editor is a visual projection of those files; agents are first-class project contributors.**

### 0.1 Engine decision: Three.js (17 October 2026)

This supersedes the PlayCanvas choice above and wherever later sections name PlayCanvas as the runtime. Later references to PlayCanvas Engine, its Editor frontend, PCUI and the PlayCanvas extraction spike are historical planning context, not the current direction.

- **Runtime:** `packages/game-runtime` is built on Three.js, pinned with the rest of the toolchain. Three.js is a renderer, not an engine, so Forgon owns the engine layer: scene projection with stable IDs, editor camera/gizmos/picking, play sessions, scripting, physics integration (vendored Ammo), input, audio, UI and export.
- **Why:** the owner's existing games (for example Kenzi) are Three.js, coding agents write Three.js far more reliably than PlayCanvas, the web is the primary target, and the PlayCanvas dependency was confined to the runtime package. Three.js is MIT, so exported games record its license instead of PlayCanvas's.
- **Scope target:** "everything a Kenzi-class game needs", grown in the order real games need it (scripting, animation/skinning, physics, audio, UI, build/export), not parity with Unity's full feature list.
- **Scripting:** games ship their own TypeScript scripts in `scripts/`, attached to entities through a `script` component. Scripts declare typed properties that the Inspector edits without code. Scripts run only in Play, inside the preview/runtime context; opening a project never executes them.
- **Designer-first priority:** the biggest pain when building games on Zibpo was that level and game designers could not visualize or handcraft levels. Visual, hand-crafted level design is therefore the top editor priority after the runtime swap: what-you-see-is-what-plays rendering in the viewport, snapping, fast place/duplicate/align, prefabs placed from the asset panel, material and lighting preview, and tuning script properties live.

### Non-negotiable acceptance demo

1. Create a fresh project in the Windows app without a cloud account.
2. Have an agent create a small hotel lobby with 30 entities, 5 prefab instances, lights, camera, colliders, one NPC behavior, and original placeholder art.
3. View the generated scene in edit mode immediately. Select individual objects and modify their transforms/materials.
4. Save; verify that ordinary project files change predictably and survive editor restart.
5. Ask the agent to modify the guest queue, add a model and audio/VFX event; review the diff and see the scene hot-reload.
6. Run the game, observe NPC behavior, and produce a playtest report with screenshot and runtime logs.
7. Export the **same game project** as a web build and a Windows build.
8. Later gates: Android/iOS test builds, rewarded ad transaction flow, remote-config event, reliable save/restore.

If steps 2–5 fail, **do not** proceed to broad AI generation or LiveOps. Fix the core project/editor architecture first.

---

## 1. Vision, users and success criteria

### 1.1 Primary users

- **Solo AI-assisted developer:** creates, modifies, and tests games through natural language and direct TypeScript.
- **Game designer:** visually edits levels, obstacles, camera, materials, progression and balance without coding.
- **Technical artist:** imports/generates GLB models, sets up materials, animations and VFX with visual previews.
- **Producer/operator:** monitors builds, game events, economy versions, performance and release gates.
- **Small game studio:** maintains several games on a shared runtime and production toolchain.

### 1.2 Product values

1. **Agent-native, not chatbot-on-top:** scene/level/property changes appear as normal project changes, reviewable and reversible.
2. **Visual feedback is immediate:** no build or play requirement for inspecting authored content.
3. **Real game-engine foundation:** production runtime, reliable transforms, assets, physics, scripts, UI and profiling.
4. **Local-first and portable:** work offline for editor/core tools; project remains a readable folder in Git.
5. **Useful without AI:** the human editor and CLI must be viable by themselves.
6. **Safe autonomous work:** permission gates, diffs, checkpoints, versioning, and production approvals.
7. **Cross-platform game output:** studio starts on Windows; games can ultimately target web/Windows/Android/iOS.
8. **Reuse across titles:** shared components and pipelines, with game-specific rules/content in project files.

### 1.3 Product metrics / suggested acceptance targets

These are proposed internal targets, **not performance claims** about any existing engine.

| Metric | V1 target | Measurement |
|---|---:|---|
| Open small local project | < 5 sec warm start | Windows reference device |
| External file edit to viewport update | < 1 sec p95 for small scene/property changes | Instrumented watcher tests |
| Agent-generated scene round-trip | 100% valid references and stable IDs in fixture | Golden project test |
| Edit-mode scene objects selectable | 100% registered editable entities | E2E selection test |
| Undo/redo for inspector actions | No data loss across 100-step test | Property/scene mutation test |
| Incremental change safety | Invalid edit keeps last valid scene displayed | Recovery test |
| Core agent workflow | Prompt → diff → validate → preview → accept/revert | End-to-end test |
| Project portability | Opens after checkout on clean Windows machine | CI smoke test |
| Web build | Clean static deploy; deterministic manifest | Build verification |
| Windows game export | Runs without studio installed | Fresh-VM test |
| Crash/data-loss regression | 0 known P0s at alpha release | QA release gate |

Performance budgets must later be defined per target phone/device and genre rather than one blanket FPS claim.

---

## 2. Scope and release boundaries

### P0: Foundation (must exist before alpha)

- Windows Tauri shell and file-system project management.
- Three.js runtime embedded in live editor viewport (originally planned as PlayCanvas; see 0.1).
- Local scene/prefab/entity representation; stable IDs; schema validation.
- Hierarchy, inspector, transform gizmos, material/light/camera editing.
- Bidirectional on-disk synchronization, import/reload, undo/redo.
- Script runner, edit mode vs play mode, sandboxed runtime preview.
- T3 Code-class basic agent pane: local provider connections, threads, composer, terminal/logs, diffs, approvals, checkpoints.
- CLI: create, validate, preview, test, bake, build.
- Web/Windows export and baseline automated tests.

### P1: Complete casual-game production

- Prefab variants, instantiation and safe overrides.
- Design-time procedural generation and editable bake outputs.
- Model/texture/audio asset pipeline; animation and VFX editors.
- Physics, navigation, state machines, reusable casual templates.
- UI/HUD authoring, audio mixer/event mapping, save system.
- Level editor, campaign editor, gameplay validation and batch generation.
- Economy/progression tools, telemetry schema and simulation.
- Android/iOS export and native service bridge tests.

### P2: Commercial operations

- Ad mediation, IAP, receipt validation, attribution, consent adapters.
- Analytics and funnel/cohort tools; experiment management.
- LiveOps dashboard, safe remote config, content catalogs, rollback.
- Cloud save, accounts, server-authoritative rewards/economy.
- Release automation, monitoring, crash aggregation, localization.
- Agent-driven game evaluation, creative generation and recommendations.

### Explicit non-goals for V1

- Reimplementing Unity, Unreal, or all of PlayCanvas's hosted backend.
- Building a full native C++ renderer or promising native graphics parity.
- Publishing exact copies of existing commercial games or using unlicensed assets.
- Fully autonomous production updates without human approval.
- Multiplayer MMO infrastructure, advanced CAD/DCC, general-purpose ECS for every genre.
- Mandatory cloud projects, subscriptions, or MCP dependency.
- Perfect TypeScript-to-editable-scene conversion for arbitrary procedural code. Use an explicit design-time authoring contract (section 6).

---

## 3. Open-source reuse and licensing strategy

| Upstream | Proposed reuse | License/status assumption | What must be verified |
|---|---|---|---|
| [PlayCanvas Engine](https://github.com/playcanvas/engine) | Production rendering/game runtime | MIT | Pin release; API compatibility; attribution |
| [PlayCanvas Editor frontend](https://github.com/playcanvas/editor) | Viewport/editor features and UX reference | MIT frontend; hosted backend separate | Which submodules can run without server services |
| [PCUI](https://github.com/playcanvas/pcui) | Inspector widgets, tree/asset controls | MIT | Framework compatibility |
| [T3 Code](https://github.com/pingdotgg/t3code) | Agent providers, orchestration, composer, threads, diff/checkpoint ideas/code | MIT repository | Package boundary, dependencies, third-party licenses, trademarks |
| [Tauri](https://github.com/tauri-apps/tauri) | Windows desktop shell, Rust commands, security | Check pinned version | WebView2, sidecar, signing and update requirements |
| Rapier / Ammo | Game physics abstraction | Verify per package | WASM bundles, physics determinism, shape cooking |
| glTF/KTX2 tooling | Asset import/optimization | Verify per package | Compression binaries and distribution rights |

**License policy:** Keep upstream LICENSE and copyright notices in redistributed code. Build `THIRD_PARTY_NOTICES.md`, SBOM and automated dependency-license checks. MIT permits reuse but **does not** supply proprietary hosted services, company trademarks, artwork, or credentials. Perform formal license/security review before shipping.

**Fork decision:** Don't begin with a wholesale PlayCanvas Editor fork. Start with PlayCanvas Engine + PCUI in an independent editor shell. Run a 2-week spike to measure whether pulling in selected Editor frontend viewport/gizmo/hierarchy modules saves time. If server coupling is high, implement smaller equivalents against the local scene model. Do not spend months cloning hidden server protocols.

**T3 Code decision:** Audit and pin a specific upstream commit first. Extract reusable provider and orchestration modules where dependency boundaries allow it; otherwise run its server-like functionality as a maintained fork/sidecar and communicate through a small versioned adapter. Reuse UI patterns or components only after checking their coupling to T3 Code's state/contracts. Avoid maintaining an undifferentiated fork of the entire application.

---

## 4. Top-level architecture

```text
+-----------------------------------------------------------------------+
|                         WINDOWS STUDIO (TAURI 2)                      |
| React/TypeScript shell                                                 |
|                                                                       |
|  Project Browser | 3D Viewport | Hierarchy | Inspector | Agent Composer |
|  Assets          | Timeline    | Console   | Profiler  | Diff/History  |
+----------------------------+-----------------------+------------------+
                             | typed IPC/events      |
                   +---------v----------+   +--------v----------------+
                   | RUST HOST SERVICES |   | AGENT SIDECAR (TS/JS)   |
                   | filesystem watcher |   | T3-derived orchestration |
                   | file transactions  |   | provider adapters        |
                   | spawn/security     |   | threads/context/composer |
                   | SQLite/cache       |   | git worktrees/checkpoints|
                   | updates/build      |   | CLI/testing/terminal     |
                   +----------+---------+   +-----------+-------------+
                              |                         |
                              +-----------+-------------+
                                          |
                              +-----------v-----------+
                              | LOCAL GAME PROJECT     |
                              | scenes, prefabs, TS    |
                              | assets, levels, rules  |
                              | config, manifests, Git|
                              +-----------+-----------+
                                          |
                        +-----------------+------------------+
                        |                                    |
                +-------v--------+                  +--------v---------+
                | EDITOR RUNTIME |                  | BUILD/TEST CLI    |
                | PlayCanvas     |                  | pack, validate,  |
                | edit/play      |                  | simulate, export |
                +----------------+                  +------------------+
                                                               |
                                                  Web / Windows / Android / iOS
```

### 4.1 Runtime boundaries

- **Tauri/Rust host:** filesystem permissions, file watchers, SQLite metadata, safe process launch, installers/updater. Keep Rust small and stable.
- **React editor frontend:** document-driven UI, PlayCanvas canvas, selections, gizmos, panels, timeline, diff views.
- **Project model package:** shared schemas, commands, validation, deterministic serialization, migrations.
- **Agent sidecar:** T3-derived orchestration and provider adapters; runs only with project-level scoped permissions.
- **Game runtime:** Three.js plus Forgon's engine layer and reusable game components; independent of editor and agents.
- **CLI:** headless project validation/import/bake/scene capture/tests/build; same implementation as editor where feasible.
- **Production backend (later):** analytics ingestion, remote config, account/save, purchases, LiveOps, experiments.

### 4.2 Why Rust, and where not to use it

Rust is appropriate for desktop shell, file transactions, spawn control, watch services, fast indexing and native packaging. It is **not** a reason to rewrite PlayCanvas or the AI provider adapters in Rust. Most agent CLIs, web asset processors and TypeScript workflows are easiest to maintain in JS/TS.

**Size caveat:** Tauri uses installed WebView2 where available; fixed WebView2 bundling and a Node-based sidecar can materially increase packaged size. Define installer-size goals only after a measured spike. Never compromise renderer stability and debugger quality solely to save installer megabytes.

---

## 5. Repository layout

Proposed monorepo (pnpm workspaces + Rust Cargo workspace where useful):

```text
forge-studio/
├── apps/
│   ├── studio/                # React UI / viewport / editor panels
│   ├── studio-desktop/        # Tauri config + Rust host
│   ├── agent-service/         # T3-derived local orchestration sidecar
│   ├── game-preview/          # Isolated local play/preview page
│   └── docs/                  # Product and developer documentation
├── packages/
│   ├── game-runtime/          # Three.js game framework, engine layer and components
│   ├── editor-core/           # Scene graph, selection, undo, commands
│   ├── editor-ui/             # Panels, PCUI adapters, shortcuts
│   ├── project-schema/        # Scene/prefab/material/economy schemas
│   ├── project-io/            # Readers, writers, migrations, asset refs
│   ├── asset-pipeline/        # GLB import, texture/audio conversion
│   ├── procedural-authoring/  # Design-time generators + bake API
│   ├── level-tools/           # Validators, templates, batch generation
│   ├── economy-tools/         # Config schemas, solvers/simulators
│   ├── vfx-audio/             # Reusable events, emitters, cue assets
│   ├── platform-api/          # Ads, IAP, saves, analytics abstractions
│   ├── agent-bridge/          # Agent context and run/event contract
│   ├── cli/                   # forge command implementations
│   └── test-fixtures/         # Golden project templates
├── services/                  # Later cloud services and dashboards
├── templates/
│   ├── empty-3d/
│   ├── runner/
│   ├── tower-control/
│   └── idle-management/
├── examples/
│   └── hotel-vertical-slice/
├── scripts/
├── .github/workflows/
├── LICENSES/
├── THIRD_PARTY_NOTICES.md
└── project.md
```

**Dependency rule:** `game-runtime` must never import `editor-ui`, `agent-service`, or Tauri modules. A generated game must build without the development studio installed.

---

## 6. Local-first game project format

### 6.1 Source-of-truth rules

1. Editable scenes, prefabs, levels, materials and gameplay configuration live in **human-readable, versioned text**.
2. Game scripts live in `.ts` and import documented engine APIs.
3. Source binaries like `.glb`, `.png`, `.wav`, etc. remain normal project assets with tracked metadata; do not claim arbitrary model bytes are human-readable.
4. Every object, component, prefab instance and asset reference has a **stable ID**.
5. Editor and agent changes go through schema validation and atomic save/reload.
6. Generated assets/levels are explicitly marked with provenance, generator version and output hashes.
7. No hidden hosted scene state is required to reconstruct a game.
8. Temporary build outputs, derived files and previews are kept out of the human-authored source tree and may be regenerated.

### 6.2 Example game project

```text
hotel-game/
├── game.project.json
├── AGENTS.md
├── scenes/
│   ├── lobby.scene.json
│   └── floor-02.scene.json
├── prefabs/
│   ├── guest.prefab.json
│   ├── reception.prefab.json
│   └── room.prefab.json
├── scripts/
│   ├── GuestBrain.ts
│   ├── QueueSystem.ts
│   └── RoomService.ts
├── authoring/
│   └── generateHotel.ts
├── generated/
│   └── hotel-lobby.generated.scene.json
├── assets/
│   ├── models/guest.glb
│   ├── materials/lobby.material.json
│   ├── textures/
│   └── audio/coin.wav
├── levels/
│   ├── level-001.level.json
│   └── level-002.level.json
├── economy/
│   ├── currencies.json
│   ├── upgrades.json
│   └── reward-curves.json
├── progression/
│   └── campaign.json
├── liveops/
│   └── event-definitions.json
├── platform/
│   └── integrations.json
├── tests/
│   └── lobby.spec.ts
└── .forge/             # ignored generated cache/index/history metadata
```

### 6.3 Scene schema (illustrative; to be formally specified)

```json
{
  "$schema": "https://schema.example/forge/scene-v1.json",
  "schemaVersion": 1,
  "sceneId": "scene_lobby",
  "name": "Hotel Lobby",
  "entities": [
    {
      "id": "entity_reception_01",
      "name": "Reception",
      "parentId": null,
      "prefab": "prefab_reception",
      "transform": {
        "position": [2, 0, 4],
        "rotationEuler": [0, 90, 0],
        "scale": [1, 1, 1]
      },
      "components": [
        { "type": "queue", "capacity": 5, "serviceSeconds": 3 },
        { "type": "reward", "coinsOnService": 10 }
      ]
    }
  ]
}
```

`schema.example` above is only a placeholder demonstrating schema attachment. The actual schema will ship locally in `packages/project-schema` and optionally at the project's documented public domain.

### 6.4 Editor command model

All editor mutations must be represented as typed transactions:

```text
CreateEntity(parentId, entityDefinition)
SetTransform(entityId, transform)
SetComponent(entityId, componentName, patch)
AttachAsset(entityId, assetId)
InstantiatePrefab(prefabId, parentId, overrides)
DeleteEntity(entityId)
BakeGeneration(generationId, options)
```

Each command has validation, inverse/undo behavior, audit metadata and file patch output. Agent edits may occur directly on disk without commands; the file synchronizer must still validate and compute a safe external-change patch.

### 6.5 File synchronization and conflict policy

- Rust watcher emits debounced file-system events to document manager.
- File changes are parsed and validated off the renderer UI thread.
- Valid updates apply incrementally by stable ID; unrelated selections and editor camera are preserved.
- Invalid updates leave the **last good state** visible and show per-file/per-field diagnostics.
- Editor saves use atomic temporary-file rename and optimistic version/hash checks.
- If agent and human change the same entity/property concurrently, do not silently overwrite either. Surface a conflict with source/ours/theirs diff and recovery choices.
- Reloads should not reset play-mode simulations; play mode uses a snapshot of project state unless explicitly refreshed.
- Keep source ordering stable and avoid reformatting huge files for one property change.

### 6.6 The critical procedural authoring contract

Not every arbitrary TypeScript function can be automatically converted into a visual editor scene. Instead provide **two supported modes**:

- **Structured authoring mode (preferred):** agent writes scene/prefab JSON or calls a design-time SDK that emits typed, stable-ID entities; all output is selectable and editable.
- **Raw runtime code mode:** agent writes unrestricted Three.js TypeScript for special mechanics; it can run/preview, but only entities explicitly registered through the authoring SDK are guaranteed to be editable in the scene hierarchy.

Design-time generators operate under a controlled environment and output a generated scene artifact. Supported operations include `authoring.entity()`, `authoring.mesh()`, `authoring.material()`, `authoring.prefabInstance()`, and `authoring.emitScene()`; implementation and final naming to be defined. Deterministic seed inputs, generator version, stable IDs, diffable bake results, and supported overrides are mandatory.

**Human-edit preservation:** Generated base plus user override layer. On regeneration, recompute the generated base and attempt to replay the overrides against stable IDs. Show conflicts when objects or properties no longer exist. A user may “detach from generator” to convert output to fully authored content.

---

## 7. Visual editor requirements

### 7.1 Main UI layout

The workspace uses a full-bleed viewport that remains mounted through layout changes. Hierarchy floats top-left and Inspector top-right as independently hideable, searchable cards with internal scrolling and bounded heights. Hierarchy retains object count, selection, keyboard tree navigation and drag-reparenting; Inspector retains validated editing, undo, conflicts and component controls.

A top-centre tool pill provides Select, Move, Rotate, Scale, Local/World space (only when the runtime exposes `setSpace`) and Frame selection. The minimal top strip retains project/scene, Edit/Play, undo/redo, save and visibility toggles. Play runs a detached snapshot in the viewport; there is no separate Game tab. The existing rail keeps Editor, Settings and Close project. The status bar retains real save/watch/error/selection/agent state.

The centred bottom command bar opens Assets, Console, Review, Agents, Stats or Conversation in one card above the bar. Only one secondary card opens at a time; choosing it again or Escape collapses it. The persistent prompt beneath the bar is the AI composer: growing single-line input, removable context chips, compact provider/model/permission disclosure, context JSON disclosure and Send/Stop/Queue. Transcript, thread controls, provider readiness, approvals, permission explanations and existing diff/review capability limits are preserved. New agent activity opens Conversation; users can collapse it. Stats reports entity count, selection count and logged errors/warnings, with no estimated fps/GPU values.

Floating visibility/expanded-card state persists per project as a version 3 payload in the existing `forgon.layout.v2:<project>` storage key; old dock layouts or invalid storage reset safely to floating defaults. Studio persists the recovered default. Viewport and hidden panel state stay mounted. The dock tab groups, splitters, tab moving and add-panel menus are replaced by the floating layout. Layout reset remains in Settings. Keyboard bindings and visual details are recorded in design.md.

### 7.2 Must-have panels

- **Viewport:** orbit/pan/fly navigation, gizmos, snapping, isolation, axes, grid, overlays, debug drawing, camera bookmarks.
- **Scene hierarchy:** parent/child, multi-select, rename, lock/hide, drag reorder, prefab nesting, search.
- **Inspector:** schema-generated forms, transform, render, material, physics, scripts, events, asset refs and component enable/disable.
- **Asset browser:** folder tree, thumbnail grid, drag/drop imports, references, duplicates/missing assets, dependency graph.
- **Code/behavior:** embedded editor or external IDE integration, file-open links, TypeScript diagnostics, safe hot reload.
- **Playtest:** edit/play toggle, pause/step, adjustable time scale, scene reload, runtime hierarchy, inspect entity state.
- **Console/profiler:** exceptions, validation, asset import issues, frame timing, draw calls, memory, simulation timing.
- **Diff/history:** agent file diff, scene semantic diff, review, approve/revert, checkpoints.
- **Timeline:** keyframe editing and animation preview (P1).
- **Level design:** grids, reusable placements, level preview, batch navigation, validation overlay (P1).
- **Economy/LiveOps:** specialized production workspaces (P1/P2).

### 7.3 Edit mode behavior

- Scene draws in the viewport even if there is no active game loop.
- Design-time preview may optionally animate effects/characters without modifying project data.
- Colliders, navigation paths, triggers, spawn points and camera bounds have gizmo overlays.
- Changes via inspector update files; external changes update inspector/hierarchy/viewport.
- **Selection is linkable to the agent composer** (`@entity`, `@scene`, `@asset`, `@level`, `@errors`).

### 7.4 Reuse feasibility spike

Prototype with PlayCanvas Engine + PCUI first. Attempt extraction or adaptation of PlayCanvas Editor frontend's gizmo/hierarchy/inspector work. Timebox to 10 business days. Evaluate:

- Bootstrap without hosted project/account services.
- Dependencies and maintenance burden.
- Rendering/selection behavior with a local scene document.
- Serialization round trips.
- Vite/Tauri bundling.

Decision gate: reuse only modules that cut development time without locking us into PlayCanvas hosted APIs.

---

## 8. T3 Code-level AI experience

The AI experience must be a **primary development environment**, not a generic chatbot. Use the original [pingdotgg/t3code](https://github.com/pingdotgg/t3code) as the upstream reference; pin and audit the actual code revision before extraction.

### 8.1 Provider support

**Initial target:** Codex and Claude Code with local authentication, plus one additional open provider such as OpenCode. Preserve T3-style provider-driver architecture so others can be added without rewriting the editor.

**Next:** Cursor CLI, ACP-compatible agents, additional available providers, optional direct API models, additional local inference engines. Do not assume every provider supports every control or session operation. Capability flags determine UX.

- Discover installed agent CLIs and check versions.
- Use each provider's supported authentication; don't copy private tokens from unrelated apps.
- Support multiple provider accounts/instances with isolated state.
- Per-thread model selection, thinking/effort controls when supported, permission mode and working directory.
- Provider switching/context handoff with explicit warnings for nonportable tools/state.
- Graceful handling of no CLI, invalid auth, quota, rate limits, restarts, crash and network errors.
- Keep provider-specific protocols inside adapters; app state uses provider-neutral run/thread IDs.

### 8.2 Composer specification

The composer is dockable (right/bottom/fullscreen), keyboard-first and aware of the current game context. It must support:

- Multi-line messages, drafts, history, command palette, slash commands and agent skills.
- Context chips for `@file`, `@scene`, `@entity`, `@component`, `@prefab`, `@asset`, `@level`, `@selected`, `@errors`, `@build`, `@runtime-log`, `@screenshot`.
- Drag/drop files, screenshots, references, images, video paths and audio files (actual multimodal interpretation depends on provider).
- One-click “Ask AI to change selected object”, “Fix this error”, “Generate similar levels”, and “Explain this component”.
- Per-thread provider/model and permission selector; run/stop/resume buttons.
- In-context file diffs, semantic scene diffs, terminal output and screenshots.
- Plan mode and implementation mode, when supported by the provider.
- In-progress status, queued prompts, clear run outcomes and context usage/cost where reported.
- Follow-up steering, checkpoint restore and branch comparison where supported.

### 8.3 Core agent features

| Feature | Priority | Design |
|---|---|---|
| Streaming responses/tool events | P0 | T3-style event stream in composer |
| Persistent threads and sessions | P0 | SQLite metadata, provider state references |
| CLI-backed providers | P0 | Adapter processes run with project cwd |
| Permission modes | P0 | Read-only/supervised/auto-accept edits/full access; enforced at adapter and host |
| Terminal and task logs | P0 | Structured command output + exit code |
| Code diffs and acceptance | P0 | Git-aware staged change review |
| Git checkpoints | P0 | Hidden refs or isolated worktrees; rollback coordinated with provider |
| Context chips: selected scene/entities | P0 | Map UI selection to stable IDs and file paths |
| Screenshot/visual feedback | P0 | Editor viewport capture + optional annotation |
| Build and validation reports | P0 | Automatically attach failing diagnostics |
| Multiple simultaneous agents | P1 | Worktrees + branch per task, explicit merge |
| Background queued tasks | P1 | Persistent local agent-service task queue |
| Provider switching/context handoff | P1 | Portable summary + project state references |
| Visual change inspection | P1 | Before/after scene screenshots and semantic diff |
| Team collaboration | P2 | Git-based first, hosted sync optional |
| Remote agent control | P2 | Authenticated secure device sessions |

### 8.4 Agent architecture (no MCP required)

```text
Editor Composer -> Agent Bridge -> Provider Adapter -> Installed agent CLI
       |                  |                                 |
       |                  +-- thread/permission/checkpoint -+
       +-- selected scene/files, screenshot, tests, runtime logs
                                     |
                                Local Project
```

Agents **read/write ordinary files and run `forge` CLI commands**. An MCP-compatible adapter could be offered as an optional integration later; it is not the core authoring or persistence model.

Game-aware context is offered as files and CLI output, not exclusively through editor-only operations. Example:

```bash
forge project inspect
forge scene inspect scenes/lobby.scene.json
forge scene validate scenes/lobby.scene.json
forge scene snapshot scenes/lobby.scene.json --out .forge/previews/lobby.png
forge level generate --template queue-puzzle --count 20 --seed 42
forge level verify levels/level-001.level.json
forge economy simulate --profile casual --sessions 10000
forge test --scene lobby
forge build --target web
```

These are **planned commands** to implement. They are not claims about existing PlayCanvas or T3 Code CLI features.

### 8.5 Agent lifecycle and review

1. User provides prompt and game context (selected entity/scene, references, target devices).
2. Orchestrator records a task, captures a Git checkpoint, optionally allocates an isolated worktree.
3. Provider agent reads project rules in `AGENTS.md` and existing project files.
4. Agent changes files, imports/generates assets, runs validation/build/playtests.
5. Watcher shows accepted valid draft changes in preview (with a “agent draft” state before final acceptance).
6. Changes appear as code diff **and semantic scene/asset diff**.
7. User approves, requests revision, discards or cherry-picks changes.
8. Checkpoints and test outputs remain attached to thread history.

### 8.6 Permissions and security

Permission modes must be enforced by the host/sidecar rather than only displayed in UI. Distinguish:

- **Inspect:** read project/screenshot/logs; no writes.
- **Supervised:** approval for file changes and risky commands.
- **Auto edits:** project-scoped file edits allowed; process execution/network/publishing gated.
- **Full local development:** commands and edits allowed within workspace according to provider security; still **no automatic production publish, billing changes or secret exfiltration**.

Use filesystem allowlists, deny traversal/symlink escapes, visible process audit logs, secret redaction, Git-based recovery and least privilege. Treat imported assets, scripts, prompt files, network responses and LLM output as untrusted. Generated game scripts must run in an isolated preview process or context; a project opening must not silently execute arbitrary code with unrestricted desktop access.

**Important:** A provider's “full access” mode may bypass limitations that our UI cannot enforce once an unrestricted external CLI is launched. Document this, use OS/process isolation where possible, and never overclaim security from a UI toggle.

---

## 9. Engine and runtime foundation

### 9.1 Runtime framework

Build a thin but consistent game framework on top of Three.js:

- Application lifecycle: preload → loading → initialize → play/pause → dispose.
- Components: transforms/render/camera/light, collider, physics body, animation, script, audio, interaction, tags, game state.
- Fixed-step gameplay simulation decoupled from rendering where needed.
- Input actions for mouse, touch, keyboard, gamepad, virtual joystick.
- Scene state/events/signals, UI/HUD system, serialization and save/load.
- Prefab spawning/pooling, object reuse, effects/audio events.
- Runtime profiling/telemetry hooks, error boundary and reload.
- Platform bridge for ads, IAP, vibration, notifications, accounts, safe-area, files.

Three.js supplies rendering, scene graph, math, loaders and animation mixing only. Forgon owns the engine-level systems above; reuse Three.js addons (loaders, controls, post-processing) wherever they fit rather than reimplementing them.

### 9.2 Physics

Implement a pluggable interface. Select and benchmark an engine suited to games and build targets; allow Rapier/Ammo support as appropriate. Expose stable collision components and triggers in scene data. Physics debug meshes must appear in edit mode. Do not assume exact deterministic floating-point reproduction across browsers/devices unless demonstrated by test.

### 9.3 Assets and rendering

- glTF/GLB primary 3D interchange; textures PNG/JPEG/WebP, compressed output KTX2 where supported.
- Auto-generated asset metadata with stable UUID/hash, importer settings and dependency graph.
- Import pipeline: source → validated/intermediate → target-optimized runtime asset.
- Materials, lighting, shadows, post effects, camera presets, LOD/instancing/batching budget guidance.
- Asset preview thumbnails are produced independently of game Play mode.
- Keep source assets and non-destructive import settings to allow reimport.

---

## 10. Asset generation, level generation and visual observability

### 10.1 Model generation

An agent can:

- Generate TypeScript scene-construction code, procedural geometry or model-generation input.
- Request approved third-party image/3D generation services via optional adapters; track license and provenance.
- Import GLB, inspect hierarchy/materials/bounds, normalize orientation/scale and create collision proxy.
- Produce an asset thumbnail and a scene placement preview.
- Convert generated objects into editable scene entities when using structured authoring/bake.

Don't promise that arbitrary image-to-3D generations are instantly game-ready. Mesh quality, skeleton/UVs, collision, animation and optimization require a validation pipeline.

### 10.2 Level authoring

P1 level editor must provide visual placement, snapping, grids, templates, spawn/goal markers, obstacles, tile/hex support where required, move/edit/duplicate, batch navigation and preview. Level generators must support:

- Seeded deterministic outputs; schema-compliant entity data.
- Constraint checks (reachable, solvable, valid collisions, budget, uniqueness).
- Difficulty features and tags, not ungrounded “fun score” claims.
- Preview screenshots and metadata for batch inspection.
- Bake + non-destructive user overrides.
- Versioned level packs and compatibility rules.

### 10.3 Agent visual feedback

- Capture scene screenshot from fixed camera(s), game camera and selected object camera.
- Report object hierarchy, component state, bounds, draw calls, frame timings, asset failures and console errors.
- Compare reference screenshot vs rendered output using image-aware evaluation if provider supports it.
- Produce change overlays, object-property diff, before/after images and performance deltas.
- Repeat tests automatically until acceptance checks pass, but surface uncertainty and do not assert subjective equivalence.

### 10.4 Validation example

Scenario: agent generates 50 levels for a tower-capture mechanic. Pipeline checks scene/schema validity, path/connections, spawn state, simulated win/lose conditions, duplicate layouts, visual readability and representative runtime performance. Designer reviews thumbnails and final sequences in the editor. Actual player data later drives pacing changes.

---

## 11. Game design and production tools

### 11.1 Level and campaign editor (P1)

- Level list/grid + playable/visual previews, hierarchy of chapters/worlds.
- JSON schemas for obstacle types, rules, target constraints, reward budget and difficulty metadata.
- Generation templates for runner, tower-control, sorting/puzzle and idle/management genres.
- Validator plugin system; seeded reproducible simulations.
- Undo, batch operations, version compare, import/export packs.

### 11.2 Economy editor (P1)

- Currency types, sources/sinks, reward tables, cost curves, inventory, upgrades and limits.
- Spreadsheet-style editable tables with version history.
- Monte Carlo/agent-based simulation for synthetic player profiles (skill, play duration, ads, spending assumptions).
- Forecast expected upgrade cadence and currency gaps; warn about negative or infinite loops.
- Import actual telemetry later to calibrate; synthetic player behavior is **not** proof of retention or LTV.
- Remote config-compatible published balance packages; require explicit approval.

### 11.3 Progression editor (P1)

- Level order, unlock dependencies, chapter/world gating, achievement/state triggers.
- Progression graph, XP/currency curves, unlock pacing and reward cadence.
- Rule checkers for unreachable nodes, progression dead ends and impossible dependencies.
- Level sequence experiments with versioned cohorts (P2).

### 11.4 Animation, VFX and audio (P1)

- Animation clips/states, blend transitions, triggerable timeline/keyframe clips.
- Particle/VFX presets with editable emitters, material parameters, lifetime and particle budgets.
- Sound cue registry, randomized variations, mix groups, looping, positional sound, ducking.
- Haptics event mapping, mobile mute/background/audio-focus behavior.
- Per-effect performance budgets and replayable event preview.
- Reusable “game feel” presets such as coin collect, unlock, impact, upgrade, completion and failure.

### 11.5 UI and localization (P1/P2)

- Anchor/layout system, responsive/mobile safe areas, HUD widgets, popup/dialog/menu navigation.
- Inspectable visual UI hierarchy and agent-editable widget JSON/TS.
- Responsive targets for portrait/landscape tablets/mobile/desktop.
- Localization keys, missing translation checks, font coverage, long-text previews.
- Accessibility baseline: scaling, contrast, control remapping, motion preferences where feasible.

---

## 12. Production backend and LiveOps architecture (P2)

Do not put LiveOps logic only in the client. Build modular services and use proven providers where appropriate.

### 12.1 Service model

```text
Game Client -> Platform API -> Auth/Player State -> Economy/Entitlements
                         |-> Event/Remote Config/Content Delivery
                         |-> Analytics Ingestion -> Warehouse/Dashboards
                         |-> Ads/Attribution SDKs (native where required)
                         |-> IAP Validation + Idempotent Reward Fulfillment
```

### 12.2 LiveOps dashboard

- Event authoring, schedules, audience targeting, preview/staging/approval/publish/rollback.
- Versioned JSON event/config packages with schema validation and min client version.
- Controlled rollout, feature flags, regional eligibility, maintenance/kill switches.
- Offer/reward definitions and player eligibility checks.
- Audit logs, approvals, read-only vs publish permissions.
- Real-time dashboards, event health, broken economy alerts, live incident runbook.

### 12.3 Analytics/experiments

- Versioned event taxonomy: install/session/level_start/level_fail/level_complete/upgrade/ad_opportunity/ad_show/ad_reward/purchase/error.
- Event payload schemas, offline buffering, retry/idempotency, consent-aware collection.
- Retention cohorts, funnels, progression drop-off, ad metrics, ARPDAU, estimated LTV (clearly labeled estimates).
- A/B setup with stable randomization unit, control group, guardrails, minimum sample plans and rollback.
- Separate dashboards for user behavior, performance, monetization and game balance.

### 12.4 Secure transactions and player data

- Server-validate purchases; handle restore, refunds, duplicate notifications and fraud appropriately.
- Enforce server-authoritative entitlements and valuable rewards.
- Rate limiting, idempotency keys, receipt storage/retention limits, privacy and deletion workflows.
- Versioned save migration and offline conflict handling.
- Remote config can change data and pre-existing mechanics; new executable functionality on mobile may require store review/build updates.

---

## 13. Build and export strategy

The **studio** is Windows-first. The **generated game** is multi-platform. Treat these as separate products and release pipelines.

### 13.1 Web (P0)

- Bundle the Three.js runtime + project code/assets with Vite or equivalent.
- Code splitting/preload manifest, compressed textures/models, service worker optional.
- Generate versioned static build with HTML/JS/WASM/assets.
- Validate performance/compatibility in Chromium, Firefox and Safari target matrix.
- Deploy to static hosting/CDN without requiring Forge Studio services.

### 13.2 Windows game (P0)

- Start with desktop web-runtime shell (Tauri 2 or Electron per benchmark).
- Package assets locally; installer/signing, window settings, fullscreen, controller input, saves.
- Test on clean Windows VM without the editor installed.
- Note: this is a desktop-packaged web game, **not** automatically a native C++ game renderer.

### 13.3 Android (P1)

- Start with Capacitor/native Android wrapper using Android System WebView, or evaluate Tauri Mobile in a later spike.
- Handle lifecycle, back button, input/safe area, vibration, audio focus, local storage, splash, permissions.
- Provide native plugins for ads, purchases, analytics/attribution and notifications where required.
- CI produces signed AAB for Play and APK for test, with proper keystore management.
- Test WebGL2, memory pressure, GPU driver behavior and app resume on real devices.

### 13.4 iOS (P1)

- Start with Capacitor/WKWebView/native Swift bridge where practical.
- Mac/Xcode signing environment required for final iOS builds and App Store distribution.
- Handle safe area, audio sessions, privacy manifests/consent, purchases/restore, backgrounding, memory, graphics fallbacks.
- CI produces signed IPA/TestFlight build and stores logs/diagnostics.
- Respect Apple policy on downloadable executable code and store review.

### 13.5 Build matrix / quality gates

| Target | Minimum check | Production check |
|---|---|---|
| Web | Loads and plays locally | Browser matrix, offline/cache, performance |
| Windows | Installer runs on clean VM | Signing, updates, controller, saves, GPU |
| Android | Test APK on midrange phone | Ad SDKs, IAP, consent, ANR/crashes, device matrix |
| iOS | TestFlight build on real iPhone | IAP/restore, consent, memory, App Store compliance |

### 13.6 Publishing adapters

A game uses platform-neutral APIs:

```ts
interface GamePlatform {
  ads: RewardedAds;
  purchases: Purchases;
  storage: PlayerStorage;
  analytics: Telemetry;
  haptics: Haptics;
  remoteConfig: RemoteConfig;
}
```

Adapters implement web/no-op/mock/native behavior. All ad and payment callbacks must be verified for success, cancellation, timeout and process death. No SDK should leak into generic game components.

---

## 14. Test architecture and continuous integration

### 14.1 Unit/contract tests

- Schemas, ID stability, file migrations, serialization, undo/redo, override merge.
- Agent adapters, permission decisions, thread/session state, checkpoint safety.
- Game logic, economy math, progression validators, native bridge mocks.

### 14.2 Integration tests

- External file change -> editor updates -> inspector edit -> project file writes -> reopen.
- Missing/renamed/deleted model import; scene fallback; dependency reference errors.
- Generator rerun with human overrides; conflict detection and resolution.
- Sidecar crash/restart; provider auth expiry, command cancellation, long-running tasks.
- Play mode snapshot and reset behavior; save migrations; build reproducibility.

### 14.3 Visual regression

- Golden scenes with camera, lighting, materials, post effects, gizmo visibility.
- Compare reference screenshots with tolerance; track browser/GPU renderer differences.
- Headless capture via Playwright for web preview; real-device screenshot checks later.
- Agent-produced before/after screenshots attached to diff review.

### 14.4 Game simulation tests

- Deterministic seeds for supported logic.
- Automated level solvability/goal checks.
- Gameplay replay/input traces and property invariants.
- Economy simulations with fixed random seeds and stress scenarios.
- Performance budget: draw calls, triangles, texture memory, frame timing, GC spikes, physics step time.

### 14.5 Release gates

No beta/release if there are known P0 data-loss bugs, silently corrupted scenes, broken checkpoint restores, unapproved production config deployments, unverified ad reward paths, or unattended unsafe command execution. Distinguish automated passed checks from human sign-off.

---

## 15. Desktop app distribution, security and operations

- Windows x64 first; ARM64 later based on demand.
- Tauri updater, release channels (nightly/beta/stable), signed releases and checksums.
- Store agent/provider credentials in provider-approved local auth mechanisms; do not log tokens.
- Sidecar must be signed/pinned, spawned with exact paths, and checked for version compatibility.
- Installer includes prerequisite detection for WebView2 and any required VC/runtime dependencies.
- Project backups/checkpoints; crash recovery for interrupted atomic save; opt-in diagnostics.
- Explicit telemetry consent and local-only option for game projects.
- Native build credentials and signing keys remain outside project repositories.

**Risk to test early:** Tauri WebView2 GPU behavior with many 3D draw calls and asset imports, multi-window editor/preview, file drag/drop and DevTools quality. Electron remains a fallback if these impair iteration speed. Smaller installer size is a preference, not a reason to accept a worse editor.

---

## 16. Delivery roadmap and milestones

The durations below assume a focused team and partial overlap. These are **estimates**, not guaranteed delivery dates. The initial architecture spikes can start with 2–3 senior developers, but shipping all areas requires a broader team.

### Phase 0: Technical discovery and architecture spikes (Weeks 1–3)

**Objective:** Prove critical dependencies before a large rewrite.

- Pin baseline PlayCanvas, T3 Code, Tauri and tooling versions.
- Run the current PlayCanvas standalone TypeScript scene-editor starter.
- Run T3 Code locally, identify portable provider/orchestrator/composer modules.
- Build Tauri shell with live PlayCanvas viewport and one Node/Bun sidecar.
- Prototype local scene JSON -> PlayCanvas entities -> editor manipulation -> file save.
- Measure WebView2 GPU performance and installer footprint against Electron.
- Test PlayCanvas Editor frontend component extraction and server coupling.

**Exit:** Architecture decision record (ADR) for Tauri/Electron, editor reuse strategy, agent-service extraction strategy, exact pinned upstream commits and confirmed licenses.

### Phase 1: File-first editor MVP (Weeks 4–9)

**Objective:** Human-useable local game editor.

- New/open project wizard; document model and JSON schemas.
- Hierarchy, inspector, viewport, transform gizmos and asset browser basics.
- File watcher, atomic writes, validation, external-change reload.
- Undo/redo, scene/prefab serialization, missing-asset errors.
- Edit/play separation, basic run/build.

**Exit:** Human creates/selects/edits objects; external script edits update scene; changes survive close/reopen and Git checkout.

### Phase 2: T3-class agent foundation (Weeks 7–13; overlaps Phase 1)

**Objective:** Reliable coding agents work through ordinary project files.

- Agent sidecar and 2 providers; per-thread sessions and permissions.
- Composer, context chips, streaming, terminal logs, screenshots.
- Git checkpoints and diff/approve/revert; crash/restart handling.
- CLI validate, inspect, snapshot, playtest and build.
- Agent-generated scene/prefab proof, with selectable objects.

**Exit:** Agent creates/modifies hotel lobby; visual preview and semantic diff; approval/rollback works.

### Phase 3: Engine authoring and casual-game vertical slice (Weeks 12–20)

**Objective:** First actually playable mini-game with a sustainable authoring model.

- Runtime components, scripting, physics, input, cameras, events, UI.
- GLB/material/audio asset imports and previews.
- Procedural design-time SDK, bake, stable IDs, override preservation.
- Gameplay tests, performance overlays, animation/VFX starter presets.
- One original vertical slice, e.g. hotel management or tower-control.

**Exit:** Playable game with 20–30 minutes of meaningful progression, editable levels, audio and VFX; agent can change mechanics safely.

### Phase 4: Production editors and templates (Weeks 19–29)

**Objective:** Turn one-off scene editing into repeatable casual-game production.

- Level editor, validators, batch generator, difficulty metrics.
- Economy and progression editors/simulation.
- Template system and prefab variants.
- UI/HUD improvements, asset optimization, sound/VFX tooling.
- Automated multi-level testing and visual change reports.

**Exit:** Designer generates, validates, edits and sequences a complete level set using the editor and agents.

### Phase 5: Cross-platform exports (Weeks 25–36)

**Objective:** Tested exports of the same game across all target platforms.

- Web/Windows packaging hardened.
- Android and iOS wrapper integration, native SDK interfaces.
- Real-device performance and lifecycle checks.
- Rewarded ad mock/real SDK flow; IAP sandbox, purchase restore.
- CI signing and staged release process.

**Exit:** Game is playable on web/Windows/Android/iOS with working platform-specific smoke tests and documented limitations.

### Phase 6: LiveOps and studio release (Weeks 34–48+)

**Objective:** Operate one game and begin managing multiple titles.

- Remote config, event publishing, staged rollout and rollback.
- Analytics events/cohorts/funnels and economy calibration.
- Reliable player saves/entitlements and transaction verification.
- LiveOps editor, permissions/audit, experiment configuration.
- Pilot second game template and regression suite.

**Exit:** Studio can release a game, ship approved content/economy updates, observe outcomes, and reuse pipelines for a second game.

### Suggested releases

| Release | Expected capabilities | Working target |
|---|---|---|
| **Prototype 0.1** | Scene file ↔ viewport ↔ file round trip | Weeks 3–6 |
| **Private alpha 0.3** | Local editor + provider agent + checkpoints | Weeks 12–16 |
| **Developer beta 0.5** | Complete vertical slice + levels/assets/testing | Weeks 20–28 |
| **Studio beta 0.8** | Multi-platform exports + production tools | Weeks 32–40 |
| **1.0 candidate** | Stability, workflows, analytics/LiveOps foundations | Weeks 40–52+ |

If staffed by one or two engineers, expect substantial extensions; do not interpret these as solo-development commitments.

---

## 17. Team and ownership

### Suggested team for sustained development

| Role | Ownership |
|---|---|
| Technical lead / architect | Core schema, PlayCanvas adaptation, architectural gates |
| Engine/editor engineer (1–2) | Runtime, viewport, inspectors, procedural authoring |
| AI/platform engineer (1–2) | T3 reuse, sidecar, providers, composer, tool integration |
| Desktop/build engineer | Rust/Tauri, file watcher, OS security, exporters, CI |
| Game designer/technical artist | Game templates, VFX, levels, economy feedback |
| QA/automation engineer | Regression, device matrix, tests, crash/performance |
| Backend/LiveOps engineer (from P2) | Analytics, entitlements, events, server systems |
| Product/design lead (shared) | UX, scope and release decisions |

Minimum credible start: 2 strong engineers plus part-time game/design/QA support for the first architecture proof. A production-oriented beta is better staffed with 5–8 engineering/technical contributors across workstreams, plus design/QA.

### Decision responsibility

- Engine/schema changes: tech lead approval.
- Agent permissions/security: platform/security review.
- Game balance: game design owner sign-off.
- Monetization, production LiveOps, store releases: designated human approver.
- Dependency/OSS licensing: repository maintainer and legal review.

---

## 18. Risk register and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| PlayCanvas Editor frontend depends on hosted backend | High | Reuse selectively; independent local document layer; 2-week extraction spike |
| T3 Code monorepo difficult to extract | High | Adapter boundary + sidecar, pin commit, upstream merge strategy |
| Arbitrary generated code not visually editable | Critical | Structured authoring SDK, explicit entity registration, bake + overrides |
| File-watcher conflicts and silent overwrites | Critical | Stable IDs, hashes, atomic writes, semantic diff and conflict UI |
| AI changes break good levels or balances | High | Checkpoints, schema validation, replay tests, approval flow |
| Tauri/WebView2 performance/debugging issues | High | Early GPU benchmark, Electron fallback, separate preview process |
| Sidecar packaging inflates desktop installer | Medium | Measure; on-demand tool install, selective bundling, compression |
| Cross-platform ads/IAP are not plug-and-play | High | Native bridge abstraction; sandbox integration and real-device testing |
| Mobile WebView performance below target | High | Genre/device budgets, optimized assets/instancing, honest capability limits |
| Cloud data/ads privacy and platform compliance | High | Consent, server validation, retention/deletion policies, audit |
| Dependence on one AI provider | Medium | T3-style provider-neutral drivers, capability flags |
| Third-party generated assets have rights issues | High | Provenance, source/license metadata, publishing review |
| Scope spreads before core editor works | Critical | Milestone gates and strict P0/P1/P2 prioritization |
| Keeping forked OSS code secure/current | Medium | Upstream sync cadence, SBOM, pinned versions, integration tests |

---

## 19. Initial implementation backlog (ordered)

### Epic A: Architecture and source foundations

- [ ] A01. Pin upstream versions, record licenses, lockfiles, toolchains.
- [ ] A02. ADR: Tauri vs Electron renderer and sidecar architecture.
- [ ] A03. ADR: PlayCanvas frontend reuse versus independent editor UI.
- [ ] A04. ADR: T3 Code extraction/fork boundaries and update strategy.
- [ ] A05. Create monorepo, CI lint/typecheck/tests, sample projects.

### Epic B: Local file project engine

- [ ] B01. Define `game.project.json` and schema versioning.
- [ ] B02. Define scene/prefab/entity/component formats with stable IDs.
- [ ] B03. Implement read/validate/migrate/write/atomic transaction services.
- [ ] B04. Implement file watcher and incremental scene reconciliation.
- [ ] B05. Implement editor command stack and undo/redo.
- [ ] B06. Implement conflict detection and preserve invalid draft without applying it.

### Epic C: Visual PlayCanvas editor

- [ ] C01. Embed standalone PlayCanvas viewport in desktop shell.
- [ ] C02. Hierarchy selection/edit; inspector and transform gizmos.
- [ ] C03. Drag/import/place GLB and image assets with thumbnails.
- [ ] C04. Edit vs play state, game camera and diagnostic overlays.
- [ ] C05. Show TypeScript errors, missing assets and other validation issues.
- [ ] C06. Round-trip sample scene and reopen after clean checkout.

### Epic D: T3-class AI controls

- [ ] D01. Sidecar process manager and health/restart protocol.
- [ ] D02. Provider adapter for Codex; authenticate via supported mechanism.
- [ ] D03. Provider adapter for Claude Code; third provider adapter.
- [ ] D04. Streaming composer, thread view, tool/terminal/event output.
- [ ] D05. Context chips for files/scenes/entities/screenshot/logs.
- [ ] D06. Permission modes and scoped command/file access.
- [ ] D07. Checkpoint/diff/revert + scene semantic diff.
- [ ] D08. Agent task runs a `forge` CLI playtest and fixes a validation error.

### Epic E: Design-time generators and runtime

- [ ] E01. Implement design-time authoring SDK with stable IDs and seeds.
- [ ] E02. Bake and overrides; generator rerun without loss of manual edits.
- [ ] E03. Physics/collision/input/audio/UI event runtime components.
- [ ] E04. Hotel vertical slice with original assets and 5 prefabs.
- [ ] E05. Screenshot/playtest CLI, tests and performance report.

### Epic F: Production and publishing

- [ ] F01. Level editor + batch generation/validator.
- [ ] F02. Economy/progression schema and simulation.
- [ ] F03. VFX/audio tools and preset library.
- [ ] F04. Web and Windows portable exports.
- [ ] F05. Android and iOS exporter proof; native bridge interfaces.
- [ ] F06. SDK sandbox tests for ads/IAP/consent/attribution.
- [ ] F07. LiveOps, analytics, remote config, rollback, telemetry.

---

## 20. Definition of done by subsystem

**Scene editor:** Can open/edit/save/reopen valid project data, select every structured entity, survive invalid external edits, and keep human changes across regeneration when IDs remain stable.

**Agent platform:** Agents can authenticate, stream, read/write according to approvals, execute CLI tasks, show diffs and screenshots, recover from failure, and revert project changes. Provider-neutral controls don't hide incompatible provider behavior.

**Level tools:** Generated levels are versioned, visual, editable, validated, reproducible and independently inspectable before Play mode.

**Game runtime:** Same project can run outside editor; input/physics/saves/audio behave consistently on supported devices; diagnostics exist for failing game states.

**Publishing:** Produces installable/testable builds, no hard-coded development server, native bridge error handling, signing/build provenance, device smoke-test artifacts.

**LiveOps:** Changes are schema-validated, permission-gated, auditable, staged and reversible; important monetary rewards and purchases verified server-side.

---

## 21. First three sprints (recommended exact execution)

### Sprint 1: Feasibility baseline (2 weeks)

**Deliver:** Tauri window with PlayCanvas viewport + Node sidecar + local scene file. A toy agent task changes a sphere material in file; scene updates without Play. Record Tauri installer size and GPU performance, compare against Electron.

**Demo:** `scene.json` change causes sphere in viewport to change, preserving selection and editor camera. Crash/restart/reopen works.

### Sprint 2: Real scene persistence (2 weeks)

**Deliver:** Hierarchy, inspector, gizmos, 10+ structured entities, local asset import, stable IDs, atomic writes, basic undo/redo and validation messages.

**Demo:** Create/move/select/rename objects visually, check deterministic JSON diff in Git, and restore by loading a clean checkout.

### Sprint 3: Agent-driven editable game scene (2 weeks)

**Deliver:** T3-derived agent composer + Codex/Claude adapters, context chip for selection, generated lobby scene, screenshot, diff/approval/checkpoint, and `forge validate`.

**Demo:** Prompt agent to create/change a lobby, observe live edit-mode changes, review diff and revert one task while other work remains unchanged.

**At end of Sprint 3:** Hold a go/no-go review based on scene round-trip reliability, T3 extraction effort, Tauri performance and whether generated output truly remains editable. If not, revisit architecture before adding production features.

---

## 22. Open questions to resolve through implementation spikes

These must not block the first spike, but decisions must be documented before scale-out.

1. Exactly which PlayCanvas Editor frontend components are practical to reuse without hosted backend services?
2. Which T3 Code components are reusable as libraries versus needing the separate server/sidecar runtime?
3. Does Tauri WebView2 meet viewport FPS, GPU stability, DevTools and process-isolation requirements on reference PCs?
4. Which physics backend has the best size/performance/authoring tradeoff for mobile builds?
5. Which asset importers can run locally with licenses suitable for redistributing in a desktop application?
6. What is the final scene schema and how do we represent custom scripts' exposed properties?
7. Can procedural generators use separate VM/worker or child processes safely without uncontrolled project execution?
8. What is the supported Windows build environment for Android builds and the macOS CI strategy for iOS?
9. Which ad mediation and attribution products require a paid SDK partnership or license?
10. Which data providers (if any) will be used for LiveOps versus building backend services ourselves?

---

## 23. Long-term differentiation

A useful benchmark is not “AI can build a spinning cube.” The platform wins if a small studio can repeatedly:

1. Describe original game mechanics and ask agents to implement them as structured, editable game systems.
2. Generate a batch of levels and inspect them visually before running the game.
3. Author and adjust scenes with drag/drop or code without losing either one's work.
4. Iterate on models, animation, VFX, sound and game feel using automated test feedback.
5. Model and tune progression, economy and difficulty with simulations and later real telemetry.
6. Ship to web, Windows, Android and iOS from one project with explicit native service bridges.
7. Operate content/events/experiments safely, with approvals, version control and rollback.
8. Reuse the engine, tooling and knowledge for the next original game.

**North-star:** *Agent writes files → editor shows editable scene → game runs → agent tests → human approves → build publishes → telemetry informs the next change.*

---

## 24. Research references (checked October 2026)

These links support technology and reuse assumptions; they do not prove the proposed studio already exists or that all integrations will work without custom development.

1. PlayCanvas Engine standalone, TypeScript/Vite: https://developer.playcanvas.com/user-manual/engine/standalone/
2. PlayCanvas official project starter: https://developer.playcanvas.com/user-manual/getting-started/start-with-create-playcanvas/
3. PlayCanvas Engine repository and MIT license: https://github.com/playcanvas/engine
4. PlayCanvas Editor frontend repo, MIT and hosted-backend local development workflow: https://github.com/playcanvas/editor
5. Editor frontend open-source announcement: https://blog.playcanvas.com/playcanvas-editor-frontend-is-now-open-source/
6. PCUI components: https://github.com/playcanvas/pcui
7. T3 Code original repository, provider coverage and license: https://github.com/pingdotgg/t3code
8. T3 Code internal architecture: https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md
9. T3 Code provider adapter architecture: https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md
10. T3 Code composer and context docs: https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
11. T3 Code permissions: https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md
12. T3 Code code-map/agent guidance: https://github.com/pingdotgg/t3code/blob/main/AGENTS.md
13. Tauri 2 Windows installer/WebView2 tradeoff: https://v2.tauri.app/distribute/windows-installer/
14. Tauri Node sidecar guide: https://v2.tauri.app/learn/sidecar-nodejs/
15. PlayCanvas scene loading API documentation: https://developer.playcanvas.com/user-manual/editor/scenes/loading-scenes/
16. PlayCanvas asset model: https://developer.playcanvas.com/user-manual/assets/

---

## 25. Immediate decision and recommended next action

**Approve Phase 0 only.** Establish the independent local scene model and run the three feasibility spikes in parallel:

- **Spike A, editor:** Prove agent-edited on-disk scene → PlayCanvas viewport → visual edit → valid file round trip.
- **Spike B, agents:** Prove reusable T3 Code provider/thread/composer/approval architecture communicating with a local project and a `forge` CLI.
- **Spike C, desktop:** Prove Tauri + sidecar + WebView2 graphics/debugging quality, packaged size and stability; keep Electron benchmark as fallback.

Then decide which frontend pieces to reuse and lock the architecture. The **first product milestone is an editable scene, not a polished AI chat panel**. If the scene graph, file model and hot reload are sound, the rest of the studio can grow in deliberate, testable layers.

## 26. Approved build-session decisions (17 October 2026)

- Build the roadmap in one sustained coordinated session with internal architecture and correctness gates; this supersedes the Phase-0-only approval recommendation in section 25. External account, signing, device and production approval requirements remain real gates, not simulated completions.
- Product branding is Forgon Engine. T3 Code is the visual and agent-workflow reference. Audit and reuse its orchestration where it fits the local game-project architecture.
- Initial provider integrations target Codex, OpenCode and Claude Code, with T3-like capabilities wherever genuinely supported. Build-worker models are independent of in-product provider support.
- Use pnpm workspaces and one pnpm-lock.yaml for all JavaScript/TypeScript dependencies.
- Parent agent orchestrates and monitors up to five concurrent delegated workers; worker replacement is authorized. The latest user AGENTS instructions supersede earlier launch authorization: do not run builds, development servers or app launches; typechecks and unit tests are allowed. Provide exact commands for user-run build/full-test verification. No commits, branches, pushes or deployments are authorized.
- Finish with an evidence-based capability report and user guide: first-run/new project flow, existing Forgon project flow, asset/import workflows, and explicit compatibility limits for projects from other engines.
- Preserve the complete roadmap; distinguish implemented, verified, unverified and externally blocked work in delivery reporting.

### Verified foundation status
The pnpm workspace, strict version-1 project schemas and editor command/store core are implemented. On 17 October 2026, 24 focused tests passed for validation, undo/redo, external conflicts and save/watcher interleavings. This establishes only the in-memory foundation; filesystem safety, desktop/runtime, providers and exports require separate integration proof.

### T3 reuse decision
Use a managed, isolated T3 sidecar behind a Forgon-owned versioned adapter, based on audited upstream commit 2520821d575fb769875f67fca1b9c62784817452 and protocol 2. Avoid extracting the app-coupled Codex/Claude adapters and orchestration core. The service owns sidecar lifecycle/authentication; capabilities and provider enforcement determine available controls. A shared-workspace restore refusal is not evidence of selective rollback, and project cwd is not a process sandbox. Runtime protocol compatibility and redistribution dependencies remain verification gates.

### PlayCanvas reuse direction
The integration uses playcanvas 2.23.3 with standalone engine rendering, native picking and gizmos against Forgon documents; the hosted editor is not a backend dependency. Runtime, real Ammo WASM and standalone web packaging pass headless checks described below. Browser/GPU, audible playback and native-shell verification remain pending.

### Authoring foundation status
Implemented deterministic authoring, explicit prefab reference remapping, override capture/replay/conflicts/detach, empty-3d and Lantern House Hotel fixtures, and bounded inspect/validate/bake CLI operations. The hotel has 47 entities, five prefab instances and three original assets; catalog validation passed. Worker verification reports 27 tests and three package type-checks passed. Bake supports explicit transactional writes through shared project IO. See the newer persistence and runtime/export evidence below for subsequent integration progress.

### Local persistence status
Project IO implements create-only projects, validated catalog/asset reads, revision-checked scene saves, debounced watchers and scene/authoring pair recovery. Worker verification: 13 real-filesystem tests passed and package type-check passed. Generated scene saves capture supported overrides; unsupported structural edits fail explicitly. Atomic replacement is not cross-process CAS, hostile concurrent ancestor replacement is not sandboxed, and power-loss durability is unverified. Desktop integration remains pending.

### CLI and editor interaction status
CLI now uses shared IO and supports create --template, explicit bake --write and validated local GLB/PNG/JPEG/WAV import with provenance. Worker checks: IO/assets/CLI 37 tests passed. Editor supports component value updates, reparent/duplicate, guarded scene switching and viewport transform callbacks; 69 UI/studio tests and studio build passed. These are subsystem checks: desktop/runtime/provider services are not yet connected. Asset reimport/transcoding and other import formats remain unimplemented.

### Runtime and export integration status
First native launch exposed a viewport startup error: PlayCanvas's scene root is null until scene loading, whereas the application root is initialized. The editor now attaches its graph to app.root. Runtime typecheck and five tests pass after the correction; native visual confirmation remains pending.

Studio forwards multi-object gizmo commits through one atomic batch command and undo step. Empty/unchanged gestures preserve history; invalid or stale edits reject the whole batch. Worker evidence: 74 editor-UI tests and UI/Studio typechecks pass. Actual browser gesture behavior remains unverified.

The real editor viewport is connected to Studio. Runtime validation and asynchronous standalone mounting are implemented, with detached play snapshots, guest paths, arrival audio/VFX and vendored Ammo static/kinematic box physics. Unsupported playable semantics fail explicitly; dynamic bodies and arbitrary scripts are not supported by this runtime yet. Registered GLB models now render in Edit and Play through asset references and byte resolution, with cached resources, loading/fault placeholders, owner picking, selection outlines and optional named animation clips in Play; web export rejects model components explicitly.

The runtime worker reports five runtime tests and 22 CLI tests passing, including actual Ammo WASM and real hotel web packaging with deterministic manifest/hashes, exact assets and bundled license/provenance. Studio/preview builds were verified before the latest no-build instruction. The hotel artifact is at packages/cli/.artifacts/hotel-web/index.html. Browser/GPU picking and gizmos, audible playback, native CSP/loading and Windows game export remain unverified or unfinished. See docs/research/runtime-implementation.md and docs/research/export-implementation.md for precise boundaries.

Parent verification on 17 October 2026: pnpm run typecheck passes across all current workspace packages, including the desktop adapters. Studio loads native project/agent services in Tauri and retains sample services in an ordinary browser. Agent bridge/service tests cover a stub T3 server; they do not establish live upstream/provider compatibility. The application is not yet ready for the end-to-end desktop acceptance demo.

### Desktop implementation status
Agent handoff includes strict artifact configuration parsing, runtime-version preflight, service-level session resume, diffs and controls. Worker results: 124 bridge tests pass; service tests report 104 passes and one skipped real-T3 integration test. Desktop now consumes the shared strict configuration loader; parent reran its typecheck and eight tests successfully. These results do not prove live provider execution or renderer conversation recovery. A checksum-verified portable Node 24.13.1 under .research/tools is available for a future authorized build; current host Node 24.2 is incompatible with the pinned T3 runtime.

Tauri shell, native pickers, Node IO bridge, browser-safe service proxies, persistent recent projects, create-only example copies and lifecycle cleanup are implemented. Worker verification: eight desktop tests and three Studio tests pass; parent workspace-wide typecheck passes after dependency reconciliation. Project persistence stays in Node project-io rather than a duplicate Rust implementation. Native compilation, dialogs, close guards, CSP/WASM loading, process-tree cleanup and installer behavior remain unverified. Desktop packaging is separate from Windows game export, which remains unfinished.

Agents require a trusted isolated T3 artifact configuration; absent configuration shows unavailable providers while project editing stays independent. The desktop bundle currently copies its build-time Node executable, which must satisfy the upstream version requirement for T3 integration. No live user T3 credentials are copied. Exact configuration, dependencies and user-run commands are in docs/research/desktop-implementation.md. The next native build command is pnpm --filter @forgon/studio-desktop build; it has not been run under the current no-build instruction.

### Agent startup isolation (17 October 2026)
The desktop bridge accepts project requests while its configured T3 agent service starts in the background. Provider rows report startup status until the service attaches; Check again discovers its resulting readiness. Closing the bridge stops an attached service and stops any service that finishes startup after closure. The renderer shows an accessible desktop connection status before rendering. A read-only request confirmed the user-started T3 server responds with protocol 2 and server version 0.1.0; authenticated handshake and provider execution remain unverified.

### First full game: Rooftop Relay (17 October 2026)
The engine now has a shipping shape for complete games, not only single-scene demos. `progression/campaign.json` (strict schema v1, referenced by `game.project.json`) sequences scenes into courses with medal targets and sequential unlocks. The runtime adds `mountCampaign`, a DOM game shell (title, course select, results, pause, settings, credits), a versioned local save with tolerant migration, per-run HUD labelling, play-session pause/master-volume, and audio cues routed to `arrival`/`checkpoint`/`goal`/`death`. `forge build --target web` ships the campaign document with all scenes, and the standalone player mounts the shell; `forge create --template rooftop-relay` creates a working game project.

Rooftop Relay ships five courses (303 entities, 5 scenes, 5 ferry/lift prefabs, 25 shards, 17 gates, 6 sentinels, 3 moving platforms, synthesized ambient and finish audio) in `examples/rooftop-relay`, with verified title/course/results/pause/settings screens in a real headless-Chrome run. Headless tests prove every gap, chasm, ferry, lift and slide gate, plus medals, unlocks, best times and save recovery. Limits: Studio Play still mounts one scene, `forge bake` tracks the generated base scene only, exported campaigns cannot use scripts, art is primitive-only, saves are device-local, and Windows game export is still unfinished.
