# PlayCanvas upstream reuse — research audit

Author: GLM 5.3 Flash (research sub-agent, Forgon Engine wave 1)
Date: 17 October 2026
Task: pin versions, determine reusable standalone editor modules, plan scene reconciliation / glTF / play snapshot / physics / screenshots / exports.
Sources: shallow clones of the actual upstream repos under `.research/` (network reads + `git ls-remote` verification, commits matched to GitHub API state as of 17 Oct 2026).

**Status legend used throughout this document:**

- **Evidence** — verified by reading actual source at a pinned commit or a git/npm API response.
- **Untested claim** — reasonable inference from the source but not yet executed by us.

---

## 1. Pinned upstream versions

| Upstream | Pin | Kind | License (Evidence) | Notes |
|---|---|---|---|---|
| `playcanvas/engine` | `v2.23.3` (npm `dist-tag: latest`, released 2026-10-15) | stable release tag | MIT (`LICENSE`, GitHub API) | `.research/engine` HEAD is `eddd61ea3fae` on `main` (2.24.0-beta.14); recommend our first build pins **npm `playcanvas@2.23.3`** (a real published artifact), not a `main` SHA, for API stability. |
| `playcanvas/engine` (secondary pin for reference) | `main` @ `eddd61ea3faefec746907e4f4cf749aaa8a140d5` | branch tip | MIT | Useful to preview 2.24 changes; **do not depend on it** for the first build. |
| `playcanvas/editor` (frontend) | `main` @ `50da536f25745eb7e66101a8bf4088d12f4a271e` (`@playcanvas/editor` 2.35.0-beta.0) | branch tip | MIT (`LICENSE`, GitHub API) | Not an npm-published library — this is a source-only frontend repo. Fork/refactor, not dependency. |
| `playcanvas/pcui` | `6.1.4` (npm `dist-tag: latest`) | stable release | MIT (`LICENSE` in repo + npm metadata) | Exports `.`, `./react`, `./styles` — `@playcanvas/pcui-react` and `@playcanvas/pcui-styles` are the **legacy pre-v6 packages**; in v6+ they are merged into subpath exports. |
| `@playcanvas/observer` | `1.7.1` (npm latest) | stable release | MIT | Dependency of PCUI (`peerDependencies` of pcui's module); this is the actual observer/sync state lib the hosted editor's UI is built on. |
| `@playcanvas/react` | `0.11.7` (npm latest) | stable release | MIT | **Not recommended** for our editor; peerDeps include `sync-ammo` and are 0.x (immature API surface). Evidence: `package.json` `peerDependencies: { "sync-ammo": "^0.1.2", "playcanvas": "^2.11.8" }`. |
| `playcanvas/editor-api` (hosted REST/realtime client) | `main` (archived upstream, 2025-12-18) | archived repo | MIT | **Do not depend.** API is designed for the hosted backend. Archived upstream, so no further maintenance. |
| `playcanvas/model-viewer` | `main` @ `2c3e5e5b5e74` | branch tip | MIT | Standalone viewer; useful as a code reference for asset thumbnails / preview, but not a library. |

**pnpm only rule**: all future `playcanvas`/`@playcanvas/pcui`/`@playcanvas/observer` dependencies must be added through the root `pnpm-workspace.yaml` + `pnpm add`, with exact versions (no `^` ranges) until the engine major is stabilized for our studio.

---

## 2. Engine: which pieces are reusable standalone

### 2.1 Confirmed engine structure (Evidence — actual file layout at `eddd61ea3fae`)

```
src/
├── core/          # math, shape, curve, etc. (pure data, no framework deps)
├── platform/      # graphics abstraction (WebGL2/WebGPU), audio, input
├── scene/         # scene graph, lights, materials, shaders, gsplat
├── framework/     # Application, Entity, Component systems
│   ├── parsers/   # glb-parser, texture parsers (incl. ktx2, basis), audio, json
│   ├── components/# collision, rigid-body, camera, light, render, sound, etc.
│   └── physics/   # PhysicsWorld abstraction + ammo + null backends
├── deprecated/    # side-effect-free aliases (kept for one major version)
├── extras/        # optional helpers, published separately as 'playcanvas' extras
│   ├── gizmo/     # Gizmo, TransformGizmo, TranslateGizmo, RotateGizmo, ScaleGizmo, ViewCube, MeshLine, TriData
│   ├── renderers/ # OutlineRenderer, WireRenderer, TextureRenderer, WideLine
│   ├── exporters/ # CoreExporter, GLTFExporter, USDZExporter
│   ├── effects/   # SSAO, Bloom, TAA, DOF, SMAA, Vignette, Grading, etc.
│   ├── input/     # controllers (camera-controls, first-person-controller, third-person-controller)
│   ├── mini-stats/# performance overlay
│   └── render-passes/
└── index.js       # 326 lines of export statements
```

The `core → platform → scene → framework` dependency order is **enforced** (per `.research/engine/AGENTS.md`). Everything under `extras/` can be imported independently of the editor.

### 2.2 Gizmos — reusable out-of-the-box (Evidence)

- Source: `src/extras/gizmo/`
- Exports the class hierarchy `Gizmo` (base, extends `EventHandler`) → `TransformGizmo` → `{TranslateGizmo, RotateGizmo, ScaleGizmo}` and a separate `ViewCube`.
- Constructor signature is `new <GizmoType>(camera, layer, name='gizmo')`; the gizmo **creates its own root Entity and adds it to `app.root` internally** (`this._app.root.addChild(this.root)` at `gizmo.js:309`). It auto-destroys on `app destroy` event (`gizmo.js:324`).
- Axes/space constants (`GIZMOAXIS_X/Y/Z`, `GIZMOSPACE_LOCAL/WORLD`) are exported from `src/extras/gizmo/constants.js`.
- **Standalone: yes.** No hosted editor coupling, no backend, no PCUI dependency. Can be driven purely from our own selection state.
- Underlying geometry lines are drawn via `MeshLine` (`src/extras/gizmo/mesh-line.js`) with unlit shaders from `src/extras/gizmo/shaders.js` — no scene material authoring needed on our side.

### 2.3 Picking — engine-level + extras (Evidence)

- Engine `src/scene/camera.js` and `src/scene/gsplat-unified/*` have dedicated picking passes (`pickMode`, `pcId` per placement), including GPU picking for Gaussian splats — this means click-to-select works even for splats without extra work.
- Installed 2.23.3 correction: `Picker` is exported directly from playcanvas (`src/framework/graphics/picker.js`), with `prepare(camera, scene, layers)`, `getSelection` and `destroy`. Forgon uses that class directly; no Camera#pick API or custom picker renderer is needed.
- Extra evidence of good picking machinery: `Picker` render-target usage is referenced in `src/platform/graphics/render-target.js` docs ("picking and custom multi-pass pipelines").

### 2.4 Renderers useful for editor visuals (Evidence)

- `src/extras/renderers/outline-renderer.js` — can draw a selection outline around entities (typical editor "selected object highlight").
- `src/extras/renderers/wire-renderer.js` / `wide-line.js` — draw wireframes / debug lines in world space.
- `src/extras/renderers/texture-renderer.js` — render a texture to screen; usable for thumbnail generation of assets.

All are plain engine modules with no hosted-editor coupling.

### 2.5 glTF / GLB import (Evidence)

- Parsers live in `src/framework/parsers/`:
  - `glb-parser.js` — primary GLB/glTF mesh importer.
  - `glb/` subdirectory with `gltf-accessor.js` and a rich set of **KHR extension** handlers (`khr-draco-mesh-compression.js`, `khr-lights-punctual.js`, `khr-materials-*` (unlit/sheen/clearcoat/iridescence/transmission/volume/specular/ior/dispersion/…), `khr-texture-transform.js`, `khr-gaussian-splatting.js`, `ext-mesh-gpu-instancing.js`, `texture-source.js`, and `index.js` to register them).
  - `texture/ktx2.js`, `texture/basis.js` — KTX2 / Basis Universal compressed texture import.
  - `audio.js`, `anim-clip.js`, `anim-state-graph.js` — asset parsers for the runtime.
  - `json-model.js`, `template.js`, `scene.js` — JSON scene serialization parsers.
  - `draco-decoder.js` / `draco-worker.js` — Draco decoding machinery.
- `src/extras/exporters/gltf-exporter.js` + `usdz-exporter.js` — programmatic export of engine scene graphs back out to glTF/USDZ (useful for our "export scene" or "thumbnail pipeline" later; **not** a path for the Windows/Windows-native build target itself).
- **Standalone: yes.** Parsers are part of the published `playcanvas` npm bundle; no external hosting required.

### 2.6 Physics — pluggable backend architecture (Evidence)

The engine has been restructured around a `PhysicsWorld` abstraction:

- `src/framework/physics/physics-world.js` — abstract base class with `step(dt, maxSubSteps, fixedTimeStep)`, `createShape(desc)`, `raycastFirst(start, end, options)`, `raycastAll(...)`, `createJoint(...)` and a `PhysicsWorldListener` for contact reporting.
- `src/framework/physics/ammo/ammo-physics-world.js` — **Ammo.js backend shipped in-tree**, with `ammo-physics-body.js`, `ammo-physics-shape.js`, `ammo-physics-joint.js`, `constants.js`.
- `src/framework/physics/null/null-physics-world.js` — null backend (no-op stepping, so physics components are safe to instantiate even in edit mode / headless tests).
- `src/framework/physics/physics-body.js`, `physics-joint.js` — backend-agnostic body/joint wrappers.
- Injection point: **`AppOptions#physicsWorld`** (documented in `system.js` and `physics-world.js:163`) or auto-detection of a globally loaded `Ammo` (see `system.js:260`).
- Supporting components: `src/framework/components/collision/{component,system,trigger}.js`, `src/framework/components/rigid-body/{component,system}.js` plus `raycast-result.js`, `contact-*.js`.
- **Implication for Forgon:** we can (a) run edit mode with `NullPhysicsWorld` so colliders are inert but selectable/inspectable, and (b) ship the Ammo backend for play mode as the default, while keeping our own thin `IForgonPhysics` abstraction on top of `PhysicsWorld` to leave room for a Rapier backend later. (Untested claim: an in-tree Rapier backend does not exist at this commit — no `rapier*` file under `src/framework/physics/`; adding one is straightforward but is *our* code, not upstream's.)
- Examples exist at `examples/src/examples/physics/` (`falling-shapes`, `raycast`, `compound-collision`, `joints`, `vehicle`, `ragdoll`, …) showing the intended usage pattern.

### 2.7 Miscellaneous engine facilities we plan to reuse (Evidence)

- `src/extras/input/controllers/` — camera-controls, first/third-person controllers (good starting points for preview navigation).
- `src/extras/mini-stats/` — performance overlay (useful for a "Profiler" pane).
- `src/extras/effects/*` — post-processing (SSAO, Bloom, TAA, DOF, …) as engine-level render passes.
- `src/extras/exporters/core-exporter.js` — base for export plumbing.
- Scripts under `scripts/esm/` (in the published `playcanvas/scripts/*` subpath export) include procedural-sky, grid, camera-controls, water, VAT-characters, gsplat-* — all side-effect-free, importable individually.

---

## 3. Editor frontend (`playcanvas/editor`) — coupling audit

The PlayCanvas Editor frontend is **MIT-licensed** and the source is fully available, but it is a **server-coupled application**, not a library:

**Evidence (from `.research/editor/AGENTS.md` + reading `src/`):**

- Backend server renders the HTML shell (Mustache templates) and injects a `var config = {...}` blob; `window.config` drives all runtime behavior.
- Class hierarchy: `Caller` → `Editor<T>` (`src/common/editor.ts`) → `MainEditor` (`src/editor/editor.ts`).
- Cross-module communication uses the `Caller` pattern (`this.call('method:name', ...args)`).
- All modules register themselves via **side-effect imports** in `src/editor/index.ts`.
- The editor uses `@playcanvas/editor-api` (archived upstream) which in turn assumes a hosted REST + sharedb realtime backend (`sharedb` in `package.json` devDependencies, `ot-text` from `github:playcanvas/ot-text`).
- Uses `@playcanvas/pcui` and `@playcanvas/pcui-graph` as the UI layer, `@playcanvas/inspector` as a standalone component inspector.
- Build tooling: Rollup + SWC, SASS, ESLint 9 + Stylelint 16, tests in Mocha.

**Server-coupled subsystems (not directly reusable):** `src/editor/realtime/`, `src/editor/relay/`, `src/editor-api/rest/`, `src/editor-api/realtime/`, `src/code-editor/realtime/`, `src/editor/whoisonline/`, `src/editor/permissions/` (server-driven roles), `src/editor/storage/` (project storage).

**Server-decoupled, reference-worthy subsystems** (can be refactored against our own document model):

| Upstream path | What it does | Coupling level |
|---|---|---|
| `src/editor/viewport/` | 3D viewport (canvas, scene, camera, picking) | Medium — depends on editor `entities`/`selection` state, but picking/camera logic is engine-only. |
| `src/editor/viewport/gizmo/` | Gizmo wiring to editor selection | Medium — the engine gizmos are already standalone; only the glue to selection state is editor-specific. |
| `src/editor/viewport-controls/` | Mouse/keyboard viewport controls (fly/orbit) | Low — mostly pure input handling. |
| `src/editor/viewport/camera/` | Camera manipulation | Low. |
| `src/editor/entities/` | Entity hierarchy panel, entity registry | **High** — built on editor-api's realtime entity model. Refactor against our `EditorStore`. |
| `src/editor/inspector/` | Attribute/inspector panels | **High** — driven by the editor-api schema. Refactor against PCUI + our own component schema. |
| `src/editor/history/` | Undo/redo | Medium — couples to editor-api `history` global. |
| `src/editor/pickers/` | Asset/entity picker dialogs | Medium. |
| `src/editor/schema/` | Editor attribute schema definitions | Low — pure data, useful as a reference for our `component` property schema design. |
| `src/editor/console/`, `src/editor/alerts/`, `src/editor/notify/` | Log/console UI | Low. |
| `src/editor/layout/`, `src/editor/toolbar/` | UI layout | Low. |
| `src/editor/hotkey/` | Keyboard shortcuts | Low. |
| `src/editor/pickers/sprite-editor/`, `src/editor/pickers/conflict-manager/` | Conflict manager for realtime editing | Medium — the conflict-manager UI is relevant to our 6.5 conflict policy, but it assumes sharedb. |
| `src/common/pcui/` | Shared PCUI element wrappers | Low. |
| `src/common/thumbnail-renderers/` | Thumbnail generation for assets | Low — uses the engine's TextureRenderer. |

**Decision (aligned with `project.md` §3 "Fork decision"):** do **not** fork wholesale. Extract only the low-coupling viewport / camera / gizmo-glue / hotkey / layout patterns into our `packages/editor-ui`, and implement hierarchy + inspector against our own `EditorStore` from `packages/editor-core` (using PCUI components as the widget layer). Treat the editor frontend as an **implementation reference**, not a build-time dependency.

### 3.1 PCUI (the only editor-frontend dependency we recommend taking directly)

- npm package `@playcanvas/pcui@6.1.4` (MIT), with `exports` for `.`, `./react`, and `./styles`.
- It depends on `@playcanvas/observer@^1.5.1` for two-way binding (`BindingTwoWay`, `BindingObserversToElement`, `BindingElementToObservers` in `src/binding/`).
- Components inventory (Evidence, `src/components/`): `ArrayInput`, `BooleanInput`, `Button`, `Canvas`, `Code`, `ColorPicker`, `Container`, `Divider`, `Element`, `GradientPicker`, `GridView`, `GridViewItem`, `InfoBox`, `InputElement`, `Label`, `LabelGroup`, `Menu`, `MenuItem`, `NumericInput`, `Overlay`, `Panel`, `Progress`, `RadioButton`, `SelectInput`, `SliderInput`, `Spinner`, `TextAreaInput`, `TextInput`, `TreeView`, `TreeViewItem`, `VectorInput`.
- Themes: `src/scss/pcui-theme-green.scss`, `pcui-theme-grey.scss`, `_variables-*.scss`.
- **Recommendation:** use `@playcanvas/pcui`'s `./react` subpath in `packages/editor-ui` for the inspector/hierarchy widgets, keeping the observer model **internal to PCUI** and translating to/from our own `EditorStore` snapshots at the boundary. (Untested claim: this translation step needs a prototype spike; we have not run PCUI against `EditorStore` yet.)

### 3.2 `@playcanvas/inspector` (reference for our inspector panels)

- Listed in editor `package.json` devDependencies as `@playcanvas/inspector: 0.3.0`.
- Evidence of purpose (from editor source usage): standalone inspector for engine entities/assets. Not a published library on npm (`@playcanvas/inspector` has no dist-tags returned by npm metadata at time of writing) — we will need to inspect it via `pnpm add @playcanvas/inspector` before relying on it as a dependency. (Untested claim until then.)

---

## 4. Architectural plan (aligned with `project.md` §6 and the shared contract)

### 4.1 Stable-ID scene reconciliation

The shared contract (docs/handoff/contracts.md) requires `SceneDocument` with stable entity IDs and `EditorStore.reconcile(input, revision)` semantics. On top of this, the PlayCanvas runtime layer must:

1. **Maintain a `RuntimeRegistry`** in `packages/game-runtime` that maps `SceneDocument.entity.id` (a stable string) to the live PlayCanvas `Entity` instance (which has a numeric engine `entity.getGuid()` but is not stable across reloads).
   - Concretely: one ES module `runtime-registry.js` per runtime package, with `Map<entityId, pc.Entity>` and a one-way `syncFromDocument(scene: SceneDocument)` step.
   - **Reconciliation algorithm** (per scene change event from the watcher):
     a. Compute `added`, `removed`, `unchanged` sets of entity IDs by diffing the old and new `SceneDocument.entities` by `id`.
     b. For `unchanged` entities, compare component-level hashes; patch in-place (`entity.findComponent('render').material = ...`) without destroying/recreating the entity, so gizmo/selection handles stay valid.
     c. For `added` entities, create via `new pc.Entity()` + `app.root.addChild(...)` using `RuntimeRegistry` for hierarchy.
     d. For `removed` entities, `RuntimeRegistry.get(id).destroy()` then `RuntimeRegistry.delete(id)`.
     e. For prefab instances, materialize per-contract `PrefabInstance` semantics; keep the `instanceId` mapping in the registry so selection of a child maps back to its `entity.id`.
   - **Critical invariant:** entity `id` must survive `pc.Entity.destroy()` / re-create cycles. This is why the registry exists. **Selection preservation** (per `project.md` §6.5) is enforced by our `EditorStore`, which keeps the `selection: string[]` independent of the runtime registry.
   - **Snapshot behavior for play mode:** `packages/game-runtime` exposes `createPlaySnapshot(scene: SceneDocument): PlaySnapshot` which serializes the *current* scene document into a frozen structure, and `spawnPlayScene(app, snapshot)` which instantiates a **separate scene graph** from the snapshot, not from the editor's live registry. This is how play mode gets true isolation: edit-mode registry and play-mode registry are distinct maps. (Evidence: the engine itself has no native snapshot API — `pc.Scene#registry` is the live engine scene; the snapshot has to be ours.)

2. **Scene file serialization** — engine's `src/framework/parsers/scene.js` and `template.js` show PlayCanvas's own JSON serialization conventions (not our schema). We will **not** use them for our on-disk format (our format is the `SceneDocument` contract). We *can* reuse their ideas for `_entity`/`_component` field naming but the schema stays ours. (Evidence of upstream format: `parsers/scene.js` exists, but it is the PlayCanvas hosted-editor format, not a stable public API for our purposes.)

### 4.2 glTF imports

- Use the published `playcanvas@2.23.3` parsers directly:
  - For files: `new pc.Asset(name, 'container', { url, filename }, data)` with `'container'` type routes to `parsers/glb-container-parser.js` — this returns a hierarchy of `pc.Entity` with `render` components, animations, and materials ready to be added to a scene.
  - For raw buffers: `pc.GlbParser` can be driven directly if we already have the ArrayBuffer (for example, when we are importing from a design-time generator).
  - Compressed textures: `parsers/texture/ktx2.js` and `basis.js` are wired into the parser chain automatically when a `.ktx2` / `.basis` file is referenced by a glTF; the engine ships the necessary WASM loader URLs in `parsers/texture/basis.js` (Evidence: file exists with loader config; we must ensure the `.wasm` / `.js` transcoder files are bundled locally with our web builds, **no CDN**).
- Draco decoding: `parsers/draco-decoder.js` + `draco-worker.js` require the Draco WASM bundle. Same local-bundling rule applies.
- **Untested claim (P0 gate):** confirm that all required transcoder/decoder WASM assets ship in `playcanvas@2.23.3`'s `files` field (per `package.json`, only `build/playcanvas*`, `scripts`, and `README` are published — the WASM decoders are **not** in the npm package and must be fetched separately at build time from the engine repo or from our own vendored copy). We need a `packages/asset-pipeline` task to vendor `draco` and `basis` transcoder binaries into `packages/game-runtime/assets/` and verify local loading. **This is a P0 gate before claiming glTF/KTX2 import works offline.**

### 4.3 Physics choice

- **Decision:** adopt the engine's `PhysicsWorld` abstraction as our abstraction.
- **Edit mode:** instantiate `app` with `NullPhysicsWorld` so colliders are inert, selectable and inspectable (Evidence: `null-physics-world.js` exists exactly for this).
- **Play mode / web build:** default to the shipped `AmmoPhysicsWorld`. The `playcanvas` npm package ships this code in-tree; the Ammo.js WASM module itself is loaded externally (see `system.js:260` `typeof Ammo !== 'undefined'`), so we must vendor an Ammo WASM build for our builds. (Untested claim: verify which Ammo.js version upstream test/examples use and vendor that exact version.)
- **Windows desktop target:** the same Ammo WASM works inside Tauri 2's WebView2 as long as the WASM file is served locally by the app; no native physics binary is required for the first pass. (Untested claim — needs a Tauri spike.)
- **Determinism:** `project.md` §9.2 requires "do not assume exact deterministic floating-point reproduction across browsers/devices unless demonstrated by test." We will not make that claim; we will add a determinism test harness in Phase 3 but expect non-determinism across backends.

### 4.4 Screenshots, tests and playtest reporting

- **Viewport screenshot (edit mode):** reuse `src/extras/renderers/texture-renderer.js` pattern, or simpler: read pixels from the WebGL/WebGPU canvas after `app.renderNextFrame = true` (Evidence: the engine's `App#renderNextFrame` exists as a standard API; exact name confirmed once we pin `playcanvas@2.23.3`'s typings).
- **Headless screenshot for the CLI / CI:** the engine ships `NullGraphicsDevice` (per upstream `AGENTS.md`) — it can run the framework without a real GPU backend, but it **cannot produce a screenshot** (no pixels to read). A headless visual capture therefore needs a software GL path (e.g. `swiftshader` inside Chromium headless via Playwright) or a `canvas`-backed context. **Decision:** use **Playwright headless Chromium with WebGL via SwiftShader** for `forge scene snapshot --out .forge/previews/lobby.png`. This is a P0 CLI gate. (Untested claim — needs a `forge scene snapshot` spike.)
- **Runtime logs + playtest report:** the engine does not ship a reporting tool; we build a small `packages/game-runtime` `RuntimeTelemetry` hook that the CLI wraps in a Playwright page, capturing console errors, `Debug` log output, and performance counters (frame time, draw calls via `pc.Stats` / `App#stats`). (Evidence: `App#stats` is an engine-standard API; `mini-stats` extras exist for visual profiling.)

### 4.5 Standalone web and Windows exports

- **Web (P0):** bundle `playcanvas@2.23.3` ESM build (`build/playcanvas/src/index.js`) with the project's own code using **Vite** (per `project.md` §13.1). Runtime code is a pure ES module with no build-time engine coupling — bundler-friendly. **No CDN, no external script tags.**
- **Windows (P0):** the generated game is packaged with Tauri 2 as a desktop web-runtime shell (per `project.md` §13.2). The exact same Vite bundle is served from Tauri's asset protocol; no separate PlayCanvas build target is required. (Untested claim — requires the Tauri shell spike, owned by another worker.)
- **Engine size:** the `playcanvas` ESM build tree-shakes (`"sideEffects": false` per upstream `package.json`), so a minimal game should bundle only the modules it actually uses. (Evidence from upstream `package.json` + upstream AGENTS.md; **untested claim** for our actual bundle until we measure.)

---

## 5. Reuse decision summary

| Capability | Decision | Source | Own-code share |
|---|---|---|---|
| 3D engine runtime | **Use upstream** `playcanvas@2.23.3` | npm | 0% |
| Transform gizmos | **Use upstream** `src/extras/gizmo` | npm (bundled in `playcanvas`) | 0% for gizmo internals; small glue for selection |
| Selection outline | **Use upstream** `src/extras/renderers/outline-renderer.js` | npm | 0% |
| Picking | **Use upstream** `Picker.prepare/getSelection` | npm | stable-ID ancestor lookup only |
| Hierarchy panel | **Rebuild** against PCUI `TreeView` | our `packages/editor-ui` | 100% |
| Inspector panel | **Rebuild** against PCUI inputs | our `packages/editor-ui` | 100% |
| PCUI widgets / theme | **Use upstream** `@playcanvas/pcui@6.1.4` | npm | 0% |
| Scene document / reconciliation | **Ours** (`packages/editor-core` + `packages/game-runtime` per shared contract) | ours | 100% |
| glTF/GLB import | **Use upstream** parsers; **vendor** Draco/Basis WASM | npm + vendored binaries | ~10% (import wiring) |
| Physics | **Use upstream** `PhysicsWorld` + `AmmoPhysicsWorld`/`NullPhysicsWorld`; vendor Ammo WASM | npm + vendored | ~10% (AppOptions wiring + our `IForgonPhysics` shim) |
| glTF/USDZ export | **Use upstream** `src/extras/exporters/gltf-exporter.js` (later, P1) | npm | 0% |
| Post effects / mini-stats | **Use upstream** `src/extras/effects/*`, `src/extras/mini-stats` | npm | 0% |
| Play snapshot / isolation | **Ours** (`packages/game-runtime`) | ours | 100% |
| Screenshot / playtest reporting | **Ours** (Playwright wrapper in CLI) | ours | 100% |
| Editor frontend reference | **Reference only** (`.research/editor/src/editor/*`) | ours | 100% |
| Hosted editor backend | **Do not use** | — | — |
| `@playcanvas/editor-api` | **Do not use** (archived upstream) | — | — |
| `@playcanvas/react` | **Do not use** (0.x, requires `sync-ammo`) | — | — |
| T3 Code | Out of scope of this document (see `docs/research/t3-reuse.md`) | — | — |

---

## 6. Work packages for the next waves (runtime + CLI)

These are proposed tasks for the parent to dispatch. Each is scoped so it can be verified against the pinned upstream.

### WP-R1 — `packages/game-runtime`: runtime registry + document→entity sync (P0)

- **Goal:** implement `RuntimeRegistry` and `syncFromDocument(scene)` per the reconciliation algorithm in §4.1 of this document.
- **Inputs:** `SceneDocument` from `@forgon/project-schema` (already frozen contract).
- **Deliverables:**
  - `packages/game-runtime/src/runtime-registry.ts` with `Map<entityId, pc.Entity>` + `syncFromDocument()` diff-based sync.
  - Unit tests using `NullGraphicsDevice` + `NullPhysicsWorld` (no GPU needed) that prove: added/removed/unchanged entities produce the correct engine operations; entity id survives destroy/recreate; component patches do not recreate entities.
  - Dependency: `playcanvas@2.23.3` (exact pin) added via pnpm to the workspace.
- **Out of scope:** play mode, physics, assets.

### WP-R2 — `packages/game-runtime`: play snapshot + edit/play isolation (P0)

- **Goal:** `createPlaySnapshot(scene)` and `spawnPlayScene(app, snapshot)` per §4.1.
- **Deliverables:** runtime module + test proving that (a) editing the editor registry during play does not mutate the play scene graph, (b) play-mode mutations (physics-driven) do not leak back into the editor scene, (c) reload/reset works from a fresh snapshot.
- **Gate:** this is required by the acceptance order step 1 ("play uses snapshot").

### WP-R3 — `packages/game-runtime`: edit-mode physics (Null) + play-mode physics (Ammo) wiring (P0)

- **Goal:** wire `AppOptions#physicsWorld` with `NullPhysicsWorld` in edit mode and `AmmoPhysicsWorld` in play mode; expose our thin `IForgonPhysics` shim.
- **Deliverables:** `packages/game-runtime/src/physics/` module; vendored Ammo WASM under `packages/game-runtime/assets/physics/` (source + license + hash recorded); a test proving colliders exist but are inert in edit mode and simulate in play mode.
- **Untested-claim gate:** Ammo.js WASM file must be vendored and locally loadable; upstream does not publish it in npm.

### WP-R4 — `packages/asset-pipeline`: glTF/GLB/KTX2 import + WASM vendoring (P0)

- **Goal:** import `.glb`/`.gltf` via the engine's container parser; vendor Draco + Basis/KTX2 transcoders; produce asset thumbnails.
- **Deliverables:** `packages/asset-pipeline/src/import-gltf.ts`; vendored `draco_*.wasm`, `basis_transcoder.js/wasm`, `ktx2 transcoder` under `packages/asset-pipeline/assets/`; license + provenance entry in `THIRD_PARTY_NOTICES.md`; a test that imports a small GLB fixture and produces a PlayCanvas `Entity` hierarchy.
- **Untested-claim gate:** confirm the exact transcoder asset names and that they load offline; this blocks the "imported assets" acceptance gate.

### WP-R5 — `packages/editor-ui`: viewport host + gizmo + selection outline (P0)

- **Goal:** a React component that owns the PlayCanvas `Application` lifecycle for the viewport, wires the engine gizmos (`TranslateGizmo`, `RotateGizmo`, `ScaleGizmo`, `ViewCube`) and the outline renderer to our `EditorStore` selection state.
- **Deliverables:** `packages/editor-ui/src/viewport/` module; works in a plain browser page for the initial spike (no Tauri dependency); hotkeys for W/E/R gizmo mode switching.
- **Depends on:** WP-R1 (registry), WP-R2 (not required for edit mode), WP-R3 (only the `NullPhysicsWorld` wiring).

### WP-R6 — `packages/editor-ui`: hierarchy + inspector panels (P0)

- **Goal:** PCUI-based `TreeView` hierarchy and inspector panels that read/write through the shared contract's `EditorStore` (never touching PlayCanvas state directly).
- **Deliverables:** `packages/editor-ui/src/hierarchy/`, `packages/editor-ui/src/inspector/`; component property schemas derived from a new `packages/project-schema` component registry (schema definitions are ours, **not** the upstream editor's `src/editor/schema/`).
- **Untested claim:** PCUI ↔ `EditorStore` binding spike (per §3.1 note) is required before this is signed off.

### WP-R7 — `packages/cli`: `forge scene snapshot` (headless screenshot) (P0)

- **Goal:** CLI command that boots a headless browser (Playwright Chromium with SwiftShader), loads a scene file, renders one frame, captures PNG, writes to `--out`.
- **Deliverables:** `packages/cli/src/commands/scene-snapshot.ts`; verified by producing a non-blank PNG for a trivial scene on CI-like hardware.
- **Untested-claim gate:** SwiftShader/Playwright feasibility is unproven for our engine version; spike before committing.

### WP-R8 — `apps/game-preview` (later, P1): standalone web export bundle

- **Goal:** produce a static web build of a Forgon project using Vite + the pinned `playcanvas` ESM build; verify offline operation (no CDN); measure bundle size with tree shaking.
- **Deliverables:** `apps/game-preview/` Vite config + build script + a minimal test project.
- **Depends on:** WP-R4 (WASM vendoring), WP-R7 (to verify headless output).

### WP-R9 — Windows game shell (later, P1, cross-coordination with the desktop worker)

- **Goal:** Tauri 2 shell serving the WP-R8 web bundle locally; verify WASM/asset loading through Tauri's asset protocol; verify controller input and fullscreen.
- **Owns:** `apps/studio-desktop` worker. This document only notes the interface: the web bundle must be self-contained (no absolute file paths, no CDN fetches) for the shell to work.

---

## 7. Risks and open questions

1. **WASM asset vendoring (P0 blocker).** `playcanvas@2.23.3` npm package does **not** ship the Draco/Basis/KTX2/Ammo WASM files. We must vendor them and record provenance. *(Untested claim: exact file list and whether any transcoder requires an external license. Basis/KTX2 and Draco are permissive/Apache-2.0 typically — verify per file.)*
2. **Picking API surface.** Resolved against installed 2.23.3: exported framework `Picker` is turnkey. GPU pixel behavior remains parent browser QA.
3. **PCUI version churn.** PCUI 6.x merged the old `@playcanvas/pcui-react` and `@playcanvas/pcui-styles` packages; our import surface must use the new subpath exports (`@playcanvas/pcui/react`, `@playcanvas/pcui/styles`) and we must not pin to pre-6 docs/examples. *(Evidence: npm `exports` field.)*
4. **`@playcanvas/inspector` availability.** Listed in the editor's devDependencies but may not be a published npm package; must be verified before adding it as a dependency. *(Untested claim.)*
5. **Engine 2.x API drift.** We pinned `2.23.3` (a stable release) to protect against `main` moving to `2.24.0-beta.14`. The engine does not guarantee API stability across majors (only "one major version deprecation cycle" per upstream AGENTS.md), so future engine upgrades must be planned as deliberate waves.
6. **Editor frontend as a reference only.** The `Caller`-pattern architecture and `window.config` bootstrap means the upstream editor code cannot be copied into our `editor-ui` package without a deep refactor; we use it only for design/UX reference and small low-coupling snippets (e.g. viewport-controls math).
7. **Physics determinism.** Per project.md §9.2, do not claim cross-device determinism. The Ammo backend's determinism on the same binary is *expected but not verified by us*; do not promise it in the verification matrix until we test it.
8. **Engine vs our scene schema.** PlayCanvas's own `parsers/scene.js` JSON format is *not* our `SceneDocument` format; we must not conflate them. Our serializer is ours (frozen contract).
9. **`@playcanvas/react`** is explicitly rejected for now (0.x, requires `sync-ammo`, immature). Re-evaluate only if we later decide to build editor UI in React with engine components directly.

---

## 8. Verification status

Evidence in this document was gathered by:

- Reading actual source files at pinned commits under `.research/engine/` (`eddd61ea3fae`) and `.research/editor/` (`50da536f2574`).
- Checking npm registry metadata for `playcanvas`, `@playcanvas/pcui`, `@playcanvas/observer`, `@playcanvas/react`.
- Checking GitHub repo metadata (license, default branch, last push) for `playcanvas/engine`, `playcanvas/editor`, `playcanvas/pcui`, `playcanvas/observer`, `playcanvas/react`, `playcanvas/editor-api`, `playcanvas/model-viewer`.
- `git ls-remote` verification of each pinned `main` SHA.

Not yet executed (untested claims, called out above): installing the pinned packages in our workspace, running a viewport, vendoring WASM assets, a PCUI↔EditorStore binding spike, a Playwright/SwiftShader screenshot spike, a Tauri WASM-loading spike.

## Installed-runtime corrections (17 October 2026)

The original source study above includes proposals and unexecuted assumptions. Actual implementation uses pinned npm PlayCanvas 2.23.3: transform event names are static `TransformGizmo.EVENT_TRANSFORMSTART/MOVE/END`, BoundingBox exposes `.center/.halfExtents`, and GraphNode getLocalPosition/getLocalScale/getLocalEulerAngles return vectors without output arguments. Ambient declarations cover the shipped untyped Grid script subpath.

AmmoPhysicsWorld is used directly, without an IForgonPhysics shim or speculative alternate backend. Unmodified JS/WASM payloads are now vendored from the matching engine tag under packages/game-runtime/vendor with exact hashes/license/source provenance. Real WASM raycasts and kinematic motion pass Node regression tests. Primitive collision half-extents must be explicitly multiplied by world scale after hierarchy construction; unlike render primitives they do not automatically inherit entity scale. Editor graphics failure is reported rather than replaced by a null-renderer success. NullGraphicsDevice is used only for headless verification. Runtime/export APIs and remaining browser/native proof boundaries are documented in runtime-implementation.md and export-implementation.md.
