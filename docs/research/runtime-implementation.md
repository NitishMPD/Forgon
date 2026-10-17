# Runtime implementation
Author: Nitish

## Public boundaries

`@forgon/game-runtime/editor-viewport` exports synchronous `mountEditorViewport(container, callbacks, options?)`. The handle retains `update`, `setTool`, `frameSelection`, `play`, `stop`, and idempotent `dispose`, and adds optional `setSpace('local' | 'world')` for the tool pill. Callbacks remain `onPick`, `onFault`, `onTransform`, and atomic `onTransforms`. Options remain `context`, `loadAssetBytes`, and `onRuntimeEvent`. Scene updates validate before touching the retained graph; authoring updates received during play are replayed on stop.

`@forgon/game-runtime/runtime` exports Node-safe `validatePlayableScene` and asynchronous `mountGame(container, options): Promise<GameHandle>`. `GameOptions`, `GameHandle`, runtime events, HUD, input and gameplay type exports remain compatible. Await mounting before claiming success. The browser mount resumes audio in the Start gesture before asynchronous Ammo loading. DOM mounts require a real WebGL renderer; scene projection, play sessions and simulation do not create a renderer or require DOM globals. Standalone consumers use `/runtime` to exclude editor controls from their dependency graph.

Three.js is pinned to `0.186.1`, with development types `@types/three@0.186.0`. Three.js supplies rendering, scene objects, geometry, math, raycasting and TransformControls. Forgon owns document projection, reconciliation, gameplay, physics integration, input, audio, HUD and export.

## Scene projection and resource ownership

Stable entity IDs map to retained `SceneNode` objects, which extend Three.js `Group`. Render meshes, authored cameras and lights are children of those nodes. Owner resolution walks Object3D parents. Entity enabled state becomes `visible`; component enabled state controls its projected child. Effective hierarchy visibility governs camera selection, picking and play behaviors. Unsupported edit components retain deduplicated diagnostics; playable validation rejects unsupported semantics, including disabled unknown components.

Primitives keep the authored unit convention: box 1?1?1; sphere radius 0.5; cylinder radius 0.5 and height 1; plane 1?1 on XZ facing +Y; cone radius 0.5 and height 1; capsule radius 0.5 and total height 2; torus ring radius 0.3 and tube radius 0.2 on XZ. Scene rotations remain degrees. PlayCanvas applied X, then Y, then Z; the matching Three.js intrinsic Euler convention is `ZYX`. A compound-angle quaternion regression covers this distinction.

Each projected graph owns its primitive geometry and MeshStandardMaterial caches. Meshes share these resources and never dispose them individually. Pulse effects clone and own their materials. Removing/replacing components detaches their child objects and releases light shadow targets. Disposing the graph and cache releases retained geometry and materials once.

Reconciliation creates missing nodes before parenting. Changed parents detach to the world root before the second parenting pass, permitting reversed ancestor relationships without temporary cycles. Surviving descendants move before removed ancestors are disposed. Existing node identity survives reordering, parenting, component changes and enabled edits. Active gesture IDs skip document transform patches. Initial projection also records previous components, so subsequent component removals reconcile correctly.

## Editor viewport

Both browser mounts use the same WebGLRenderer setup: antialiasing, sRGB output and soft shadow maps. Edit and Play project identical render materials, lights and shadows. Lights support directional, omni/PointLight and spot, with color, intensity, range and cast-shadow fields. Authored perspective cameras retain fov, near/far clips and clear color; they are inert in Edit and active in Play. The editor owns a separate navigation camera.

The canvas fills its container, is keyboard focusable and has an accessible navigation label. ResizeObserver updates drawing-buffer size and camera aspect and immediately renders, avoiding a cleared frame during floating-panel resizes. Animation uses `setAnimationLoop`; disposal stops it, disconnects the observer, releases renderer resources and its WebGL context, and removes the canvas.

The navigation camera retains mouse orbit, Shift-left/middle pan, wheel zoom, arrow-key orbit, Shift-arrow pan, plus/minus zoom, Home reset, framing, navigation state and gesture locking. Scene updates retain its view; the first nonempty scene frames once. Bounds use projected world-space geometry, with a position fallback for empty entities. A GridHelper sits outside the authored world root.

Raycaster picking intersects only the authored world root, filters hidden hierarchies and resolves stable IDs through mesh parents. Grid, selection edges and gizmo helpers live outside this root. Clicks exceeding five pixels or 350 ms are ignored; gizmo gestures suppress clicks for 80 ms after completion.

TransformControls owns translate/rotate/scale axis interaction and local/world space. A world-space pivot applies its gesture delta to each selected object's captured world matrix, then converts each result back into the entity's parent space. Parent-and-child selections receive the delta once. One gesture end emits changed schema transforms in degrees; `onTransforms` commits them as one host batch. The legacy singular callback retains primary-selection-only editing. No-op gestures emit nothing. Warm EdgesGeometry outlines follow the selected mesh world transforms without replacing its material. These are geometry edges rather than a screen-space silhouette pass. Transform schema stores position/rotation/scale, so matrix decomposition cannot retain shear produced by nonuniform scaling across rotated parent spaces; TransformControls also uses local axes for scale.

Play locks editor navigation and gizmos, hides the authoring root, attaches browser input and the parkour HUD, and focuses the canvas. Stop destroys detached play state, restores authoring visibility and releases gameplay listeners/HUD. Mount disposal additionally releases editor listeners, controls, outline geometry/material, grid resources, scene caches and registries.

## Play semantics and Ammo

The supported component vocabulary remains render, camera, light, collision, guestQueue, audio, vfx, player, movingPlatform, checkpoint, collectible, goal and hazard. Play validates a detached snapshot, requires exactly one camera in an enabled hierarchy, validates references and known properties, and rejects unsupported required behavior. Authored dynamic rigidbodies, asset-backed rendering and script execution are outside this runtime lane. The reserved `src/scripting/` folder belongs to another implementation lane.

The parkour controller remains the engine-free swept-AABB simulation, with a fixed 1/120-second step and capped catch-up. Its movement, jumps, wall runs, slides, moving platforms, checkpoints, collection, hazards, respawns, finish state and deterministic schedules are unchanged. The session writes world transforms onto the Three.js rig and chase camera. Guest paths still resolve world-space waypoints at start and directly consume distance budgets, with bounded handling of overlapping looping points. Neither path following nor parkour movement delegates movement to Bullet.

Unmodified Ammo JS/WASM payloads remain vendored from PlayCanvas Engine tag `v2.23.3`; this is payload provenance, not a PlayCanvas runtime dependency. Exact upstream URLs, SHA-256 values and zlib/Bullet notices remain in `packages/game-runtime/vendor`. Browser initialization loads the local classic-script factory once. Each play session owns an independent Ammo collision world through a small typed adapter. Static and kinematic box bodies, no-response trigger boxes and closest-hit raycasts use real Bullet objects. There is no dynamics step because current gameplay owns movement. Guest and moving-platform bodies synchronize pose and broadphase bounds after movement. Box half-extents include complete world scale; pose uses world position and quaternion. Existing positive-scale and uniform-ancestor validation remains in place.

Audio retains asset-byte resolution, Web Audio decoding, volume/loop/autoplay, arrival cues, suspended/missing/error events and stale-decode cancellation. Instance pulse materials animate emissive color and baseline scale without shared-material mutation or scale drift. Stop releases audio sources/context, pulse materials, play graph, caches and all Ammo allocations.

## Web export and preview

`apps/game-preview` continues to mount checked-in hotel and Sector scenes through `/runtime`, using the same validated assets, prefabs and WAV URLs. It has a typecheck script and no test script.

CLI web export bundles Three.js through the standalone runtime, records `three: '0.186.1'` in its toolchain manifest and copies Three.js's MIT license to `licenses/three.txt`. Ammo's original provenance and license and Zod's license remain included. Existing export tests now expect the Three.js license/version. The real artifact test invokes Vite's build API and was excluded from this task's verification under the explicit no-build rule.

## Verification: 17 October 2026

- Runtime typecheck passes. All 31 Node tests pass: 11 parkour simulation, five Sector course and 15 runtime tests. These cover primitive dimensions, compound rotations, hierarchy reconciliation and cycle reversal, dragging IDs, shared-resource disposal, camera keyboard controls, ray picking, real Ammo raycasts and kinematic synchronization, atomic TransformControls gestures and space/lock state, hotel/Sector play-stop, late-attached input, and checked-in example/fixture equality.
- Preview and CLI typechecks pass. Preview has no test script.
- Editor UI tests pass 72/72. Workspace typechecking stops in concurrent editor UI work: `AgentDock.tsx` attaches an HTMLDivElement ref to an HTMLLIElement.
- Studio tests pass 2/3. The sample still uses script properties `{ script: 'GuestBrain' }`, which the concurrently changed schema rejects because it expects `src` and `params`.
- CLI tests excluding the real web artifact build pass 20/21. The remaining rejection test constructs a script with empty properties and now fails at schema validation before its expected unsupported-component message. That script-fixture change is outside the export/license migration scope. One artifact-build test was excluded.

No builds, browser automation, app launches, commits, branches, pushes or deployments were performed. Node tests prove scene and control math/event behavior, not WebGL pixels, shadow coverage, outline appearance, pointer hit accuracy, gizmo feel, audible playback, native CSP loading or packaged export execution. Those checks remain for the owning integration lane. Full CLI export proof, when builds are permitted: `pnpm --filter @forgon/cli test`.
