# Runtime implementation
Author: Nitish

## Public boundaries

`@forgon/game-runtime/editor-viewport` exports synchronous `mountEditorViewport(container, callbacks, options?)`. The returned handle has `update`, `setTool`, `frameSelection`, `play`, `stop`, and idempotent `dispose`. Options are `context:{assets,prefabs}`, `loadAssetBytes(assetId)`, and `onRuntimeEvent(event)`. Catalog getters remain live; the session reads them when validating each play snapshot. Scene updates validate before touching the engine and retain the last valid graph on structural failure.

`@forgon/game-runtime/runtime` exports `validatePlayableScene(input, {assets,prefabs}?)` and **asynchronous** `mountGame(container, {scene,assets?,prefabs?,loadAssetBytes?,onRuntimeEvent?}): Promise<{dispose()}>`. Await the mount before claiming play succeeded. Invoke it directly from a Start button gesture so audio can resume before WASM loading. The public runtime import and validator require no DOM globals; mounts require browser DOM, ResizeObserver and WebGL2. Rendering failure rejects; there is no null-renderer success fallback. The root package entry reexports both mounts and their types; standalone consumers must use `/runtime` to avoid editor tooling.

## Projection and editor ownership

Stable entity IDs map to retained PlayCanvas Entity objects. Reconciliation creates all missing entities before parenting; changed parents detach first, permitting reversed ancestor relationships without intermediate cycles. Surviving children move before removed ancestors are destroyed. Component removal, type replacement, enabled-only edits and local transforms reconcile without recreating surviving entities. Engine constructors receive their owning application explicitly, so a later-created application cannot steal subsequent reconciled components.

The editor camera, grid, picker and gizmos remain outside the authoring graph. Edit changes retain camera state; the first nonempty scene frames once. Mouse orbit/pan/wheel and keyboard arrows/Shift+arrows/plus/minus/Home navigate; canvas focus remains visible. Framing uses actual BoundingBox center/halfExtents. Picking uses PlayCanvas's exported `Picker.prepare/getSelection`, World layer and stable-ID ancestor lookup. Grid/gizmo meshes do not become authored objects.

Gizmos use `TransformGizmo.EVENT_TRANSFORMSTART/MOVE/END` static constants. They modify engine nodes during a gesture and emit only changed final local transforms. Camera navigation and reconcile transform patches suspend during gestures. Optional callback `onTransforms(changes: readonly {entityId,transform}[])` lets the host issue one atomic batch/undo entry for a multi-selection gesture. The existing per-entity `onTransform` callback cannot do that: when only it is supplied, gizmos operate on the primary selection, producing one command per changed gesture. Parent UI may add the batch callback without changing existing callers. No-op gestures emit no transform command.

Editor physics loads in the background. A Play attempt before initialization completes throws a retryable loading error instead of marking a nonexistent play session successful. Unsupported authored components can remain inert in edit mode; Play/export validate their semantics strictly. Stop restores the retained authoring graph and applies any authoring updates received during play. Disposal removes input listeners, observer, picker targets, gizmos, materials, play resources, application and canvas.

## Play semantics and physics

Playback owns a parsed detached snapshot, engine graph, materials, movers, audio sources/context and pulse state. Exactly one enabled camera in the effective hierarchy is required. Supported conventions are the primitive render/camera/directional-or-omni-light/box-collision/guestQueue/audio/arrivalPulse fields in authoring-cli.md. Optional fields use documented defaults. Unknown types, unknown properties, duplicate same-type components, script, authored rigidbody/model/UI semantics and unsupported asset-backed rendering fail explicitly, including disabled unknown components. Audio requires a declared catalogued audio asset; waypoint properties must be declared entity references. Scene/prefab/asset references also pass the shared schema boundary.

Real Ammo payloads are vendored unmodified from PlayCanvas Engine `v2.23.3`; source URLs, exact SHA-256 values and zlib/Bullet notices are retained in `packages/game-runtime/vendor`. The npm package contains AmmoPhysicsWorld but not its JS/WASM payloads. A single browser initialization loads local bundled payloads; each application owns its own real AmmoPhysicsWorld. No physics wrapper or alternative backend is introduced. Export retains Ammo notices/provenance alongside PlayCanvas/Zod licenses, with hashes in the artifact manifest. Vite library builds inline the JS/WASM payload URLs; app builds emit local asset files. No CDN is needed.

Authored box half-extents are local pre-scale dimensions; PlayCanvas's primitive collider API expects world dimensions. Projection attaches the full hierarchy before computing scaled half-extents and constructing physics components. Ordinary colliders get static rigid bodies; an enabled guestQueue makes its collider kinematic, and motion teleports/synchronizes the body. Trigger-only boxes use engine triggers. Positive collider/ancestor scales and uniform ancestor scaling are required to avoid unsupported reflected/sheared shapes. Queue-driven triggers are rejected. There is no authored dynamic-body support or claim that queue path following is collision avoidance. The fixture's guests follow their authored paths while retaining real colliders.

Guest movement resolves waypoint world positions at play start, consumes distance budget, emits arrival/path completion, and terminates even for overlapping looping points. Audio decodes supplied bytes through Web Audio, supports volume/loop/autoplay and arrival cues, reports missing/failed/suspended audio, and suppresses stale decode completion after stop. A looping source is not duplicated at each arrival. Arrival pulses use instance materials/emissive color and scale from a fixed baseline, avoiding shared-material mutation and accumulated scale drift. Pulses affect visuals; static collider dimensions remain authored. Runtime events include play-started/stopped, arrival, audio, vfx and fault.

## Standalone preview and proof

`apps/game-preview` is a Vite fixture player importing only `/runtime`, schema parsers and checked-in hotel data. Play/Stop controls are keyboard accessible. It does not import the editor or agent. Its local WAV URL is packaged by Vite.

Focused checks on 17 October 2026:

- Runtime: five Node tests pass. They exercise actual engine reconciliation and material/components, reversed hierarchies/deleted ancestors, separate application ownership, camera math/retention, invalid playable states, detached snapshots, bounded queue behavior and the actual vendored Ammo WASM. A world-space ray at x=3 hits the scaled hotel floor, guest bodies are kinematic, movement emits arrivals/VFX, and Stop restores authoring state. NullGraphicsDevice is confined to headless tests; it does not prove pixels.
- Runtime/preview/CLI/connected Studio typechecks pass. Studio and preview production builds pass. The preview's normal Vite chunk-size warning reflects the bundled engine.
- CLI's 22 tests pass, including real hotel web packaging twice with identical manifests, exact assets/provenance/hashes, inert script asset handling, untrusted config nonexecution, no editor/agent/IO/Tauri bundle graph and create-only publication safety.

Parent owns browser/GPU picking and gizmo interaction, actual audible playback, native-shell/CSP loading and root docs/task/install changes. No browser automation, app launch, commit, branch, push or deployment was performed by this lane. Passing Node/compile/export checks is not a claim of completed visual/native QA.
