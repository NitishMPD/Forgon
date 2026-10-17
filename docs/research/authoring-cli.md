# Authoring and CLI integration
Author: Nitish

## Runtime component conventions (v1 fixture contract)

These are authored data conventions for the runtime worker, not claims of engine support. Transforms are local, metres, Euler degrees, Y up. Primitive dimensions use entity scale; colliders use local half-extents before entity scale. Components use their schema-v1 `enabled` flag. Stable component IDs are independent from entity IDs.

| Type | Exact properties | References / intent |
| --- | --- | --- |
| `render` | `primitive: 'box' \| 'sphere' \| 'cylinder'`, `color: [r,g,b]` (0–1), `castShadows: boolean` | Original colored primitives; no model loading required |
| `collision` | `shape: 'box'`, `halfExtents: [0.5,0.5,0.5]`, `isTrigger: boolean` | Static collider unless another runtime component says otherwise |
| `camera` | `fov: 50`, `nearClip: 0.1`, `farClip: 100`, `clearColor: [r,g,b]`, optional `mode: 'static' \| 'follow'`, `distance`, `height`, `lag`, `intro`, `speedFov`, `lookAhead` | Authored scene camera; the editor camera remains separate. `mode: 'follow'` drives the cinematic chase rig (behind-and-above the player, easing over `intro` seconds off the authored pose, widening fov by `speedFov` deg per unit of speed, aiming `lookAhead` seconds down the run) |
| `light` | `kind: 'directional' \| 'omni'`, `color: [r,g,b]`, `intensity: number`, `castShadows: boolean`, `range: number` | Range used by omni lights |
| `guestQueue` | `waypoints: string[]`, `speed: 1.2`, `arrivalRadius: 0.15`, `loop: true`, `visualComponentId: string` | Ordered entity IDs in `waypoints`, also listed in `entityRefs`; move in world space towards waypoint world positions during play only. `visualComponentId` is a remapped render-component reference for authoring; runtime may ignore it |
| `player` | `runSpeed`, `sprintSpeed`, `gravity`, `jumpVelocity`, `doubleJumpVelocity`, `maxJumps`, `coyoteTime`, `jumpBuffer`, `wallRun`, `wallRunTime`, `wallRunSpeed`, `wallJumpUp`, `wallJumpOut`, `slide`, `slideTime`, `slideHeight`, `radius`, `height`, `fallLimit`, `invulnerable` (all optional over documented defaults) | The parked runner the play session drives; exactly one enabled `player` per playable scene. The character rig and spawn markers are its descendants/authored refs |
| `movingPlatform` | `waypoints: string[]`, `speed: 2`, `mode: 'pingpong' \| 'loop'`, `wait: 0` | Ordered entity IDs in `waypoints` (index 0 is the authored position); the same entity must also carry a trigger `collision` giving the deck size. Carries a rider standing on it |
| `checkpoint` | `index: number`, `radius: 2`, `offsetY: number`, optional `spawn: true` | Ordered relay gate; the enabled `spawn` checkpoint owns the level spawn point and is armed from the start. Respawn occurs at the gate's `groundY` |
| `collectible` | `value: 1`, `radius: 1.1`, `offsetY: 0` | Data shard; collected once, contributes to the goal tally |
| `goal` | `radius: 2.4`, `offsetY: 0` | Uplink volume; reaching it finishes the run |
| `hazard` | `kind: string`, `halfExtents: [0.5,0.5,0.5]` | Local half-extents scaled by entity scale (like `collision`). Overlapping the body is fatal |
| `audio` | `assetId: string`, `autoplay: false`, `loop: false`, `volume: 0.25` | `assetId` also in `assetRefs`; original WAV reception cue, requires user gesture/runtime event integration |
| `vfx` | `kind: 'arrivalPulse'`, `color: [r,g,b]`, `duration: 0.5`, `autoplay: false` | Declarative arrival cue; runtime event/VFX integration remains required |

Prefab property references are never inferred from arbitrary strings. Separate `PrefabBindings` declare exact property paths and reference kinds (`entity` or `component`). Entity-reference arrays are always remapped; asset references remain shared. The hotel guest prefab includes an internal `entityRefs` link and declared property binding. Nested prefab instantiation is explicitly rejected for now.

## Implementation sequence and ownership

Using the writing-plans skill within the assigned documentation path; execute inline, no commits or delegated work.

1. Add pure `packages/procedural-authoring/src` stable keyed IDs/randomness, prefab instantiation with explicit bindings, strict separate authoring artifacts, conflict-aware override replay and detach. Verify with `pnpm --filter @forgon/procedural-authoring test` and `typecheck`.
2. Add `packages/test-fixtures/src` original hotel and empty generators; materialize catalogs under `examples/hotel-vertical-slice` and `templates/empty-3d`. Verify full shared-schema validation and reproducibility, including asset bytes.
3. Add `packages/cli/src` bounded canonical-contained reads, inspect/validate and allowlisted deterministic bake to stdout. Reject unavailable commands and conflicting replay with nonzero status. Verify temporary-directory traversal/symlink/oversize failures and command statuses.

No schema/core, root config, lockfile, project/design/task documentation changes belong to this worker. Root owner installs the new workspace manifests.

## Public authoring API and invariants

- `new SceneAuthor(namespace, seed)`: `id(semanticKey)`, `random(sampleKey)`, `entity(key, name, parentId?)`. IDs exclude seed/version; random samples include seed and are keyed independently of call order. A 64-bit FNV identity hash is deterministic, not a security token; shared scene/project validation rejects duplicate IDs. Keep semantic keys stable when editing a generator.
- `instantiatePrefab(prefab, instanceId, bindings?, parentId?)`: returns `{entities, entityIds, componentIds}`; all IDs/parent IDs/internal `entityRefs` and explicitly bound entity/component properties are remapped. Assets stay shared. Plain strings stay unchanged. Nested prefab instances are rejected explicitly. Bindings must target an existing internal object; entity-property bindings must also be in `entityRefs`.
- `parseAuthoringArtifact(unknown)`: strict format-v1 artifact, `generator:{id,version,seed}`, generated `base:SceneDocument`, ordered `overrides`, `detached:Entity[]`, optional `prefabBindings:[{prefabId,path}]`. Core schema v1 is unchanged. Overrides have stable IDs, target entity ID, `before` and `value`; fields are name/enabled/transform or a declared component property path. Paths reject prototype mutation keys.
- `captureOverrides(artifact, editedScene)`: records existing entity name/enabled/transform and existing component-property edits against the generated base. Detached snapshots absorb their own edits. Entity additions/deletions/reordering, hierarchy/prefab changes, component additions/removals/reordering/type/reference changes, property additions/removals and scene renaming are rejected explicitly rather than discarded. These structural edit flows need editor integration, not silent merge guesses.
- `replayOverrides(artifact, generatedBase?)`: detached copies plus overrides applied to a new validated base. Missing entities/components/properties yield `deleted-target`; competing generator/manual field edits yield `generated-change`; invalid final graphs/values yield `invalid-result` and null scene. Nonconflicting changes produce a preview; **any conflicts block persistence**. Inputs are never mutated.
- `bakeAuthoring(artifact, generatedBase, generatorMetadata?)`: returns `{scene,authoring,conflicts}`. Conflicts return null authoring; success advances base/seed/version and rebases override preconditions without losing manual intent. Persist both documents together. Generator identity cannot change in this operation.
- `detach(artifact, entityId)`: preserves current replayed entity data, includes descendants and all members of any touched prefab instance, removes prefab ownership and generated overrides for those entities, and stores independent snapshots with the same stable IDs. Future generation cannot overwrite those snapshots. A removed external parent/reference still produces a validation conflict; detach does not silently reparent or repair references.

## CLI behavior and read boundary

Use `pnpm --filter @forgon/cli forge <command> <project-root>`. Filter scripts run in `packages/cli`, so repository fixtures use `../../examples/hotel-vertical-slice` or `../../templates/empty-3d`.

`inspect` emits JSON catalog counts, manifest and optional generator identity. `validate` validates complete registered catalogs, asset-file existence and canonical containment, plus present authoring artifacts and their declared prefab bindings. It does not execute/import a script, launch an engine or validate unsupported runtime semantics.

`bake <root> [--seed <seed>]` only runs the bundled `hotel`/`empty-3d` generators at version `1.0.0`. It first validates the project and refuses unrecorded edits (saved scene must equal replay of stored base/overrides). It emits deterministic `{scene,authoring}` JSON to stdout; it makes no file changes. Conflict output goes to stderr and has no success payload. Persist that bundle through future shared project-io transactions. Do not overwrite a scene with the whole bundle. User-authored generator modules are never imported or executed.

Exit codes: 0 successful inspect/validate/bake/help; 1 invalid/missing files, unavailable generator/version, unrecorded edits or bake conflict; 2 bad command/usage or unavailable capability. `snapshot`, `build`, `test`, `preview`, `open` and `create` explicitly report unavailable. No fake screenshots, test reports, builds or create successes.

The temporary read-only CLI boundary canonicalizes the root and every catalog/asset path with realpath, rejects absolute/traversal/backslash/drive paths and junction/symlink escapes, requires regular files, bounds JSON to 2 MiB/file, 16 MiB total, 128 documents, depth 64 and 1024 assets, and uses bounded reads even if a file grows. Malformed UTF-8 is rejected. Asset payloads are checked for contained regular-file existence but never imported or executed. This is not an OS sandbox against a hostile concurrent process replacing directory ancestors between checks and reads. Replace these catalog reads with the shared project-io boundary when available; do not duplicate write/transaction infrastructure here.

## Integration and verification

Package dependencies: authoring → project-schema + existing Zod 3.25.76; fixtures → project-schema + authoring; CLI → project-schema + authoring + fixtures + existing tsx 4.20.6. Root config/install/lockfile are parent-owned. There are no new third-party libraries.

Hotel: 47 entities, five three-entity prefab instances, five queue waypoints and three registered original assets (SVG, palette JSON, PCM16 WAV). Empty 3D: camera/two lights, zero assets/prefabs. `packages/test-fixtures` exports pure `createHotelFixture`, `createEmpty3dFixture`, `createFixture` and `receptionWav`; fixture `files` contains reproducible portable bytes. Tests compare checked-in files byte for byte.

Parent integration needs: install workspace manifests; wire editor changes through capture/replay and persist scene+artifact transactionally; implement project creation through shared IO; render the documented primitives/camera/lights; run guest motion only in play; wire collider/audio/VFX events; provide real snapshot/playtest/export implementations before enabling those CLI commands. Script-generation sandboxing and arbitrary generator execution are outside this implementation.

Verified 17 October 2026 using actual workspace resolution (temporary source-alias verification files were removed):

```powershell
pnpm --filter @forgon/procedural-authoring --filter @forgon/test-fixtures --filter @forgon/cli typecheck
pnpm --filter @forgon/procedural-authoring --filter @forgon/test-fixtures --filter @forgon/cli test
pnpm --filter @forgon/cli forge inspect ../../examples/hotel-vertical-slice
pnpm --filter @forgon/cli forge validate ../../templates/empty-3d
```

All commands passed. Tests: 12 authoring + 5 fixtures + 10 CLI = **27 passes, 0 failures/skips**. Coverage includes keyed determinism, entity/component/property-reference remapping, ordinary-string preservation, override replay/capture/rebase, deleted targets, competing edits, detach/reference/order invariants, whole-project hotel catalogs, exact fixture bytes, WAV structure, real Windows junction escape rejection, malformed/bounded JSON, aggregate quotas, declared binding validation, nonexecution of project scripts, bake conflicts/unrecorded edits and actual CLI process exit status 2 for unavailable build. CLI smoke output reports hotel 47 entities/one prefab catalog/five instances/three assets and empty-3d three entities/zero prefabs/assets.

No explicit install command or manual root config/lockfile edit was performed by this worker. pnpm 12 automatically prepared/refreshed workspace dependencies when invoking verification commands; the parent should retain ownership of the resulting dependency/lockfile integration. No build, engine launch, browser verification, commit, branch, push or deployment was performed. Passing these checks establishes authoring/catalog/CLI behavior, not runtime/export behavior.
