# Lantern House hotel fixture
Author: Nitish

Original, file-first authoring fixture: **47 entities, 5 materialized traveler prefab instances**, a floor and five wall sections around an entrance, reception/counter/sign, six seats, four planters, five queue waypoints, camera, two lights, render primitives, static collider data, guest queue behavior data and reception audio/VFX cues.

The files use the shared strict schema v1. `game.project.json` registers the scene, prefab and assets. `authoring/generated.json` stores the generated base, generator version/seed, manual overrides, detached snapshots and prefab-binding catalog separately. `authoring/guest.bindings.json` declares internal entity/component property references for instantiation. Stable IDs survive seed changes.

From the repository root, after the parent installs workspace dependencies:

```powershell
pnpm --filter @forgon/cli forge inspect ../../examples/hotel-vertical-slice
pnpm --filter @forgon/cli forge validate ../../examples/hotel-vertical-slice
pnpm --filter @forgon/cli forge bake ../../examples/hotel-vertical-slice --seed second-layout
```

Bake emits `{scene, authoring}` to stdout, changes no files, and fails on conflicts or unrecorded manual scene edits. Capture visual edits with `captureOverrides(artifact, editedScene)` before regeneration. Persist the scene and corresponding artifact together through the project-io integration; the CLI does not provide writes yet. Do not redirect the bundle over a `.scene.json` file.

Exact runtime conventions and integration needs are in `docs/research/authoring-cli.md` in the repository root. Guest `guestQueue.waypoints` are ordered world-position targets. The primitive-only queue is an authoring/engine-integration fixture, not a complete hotel simulation: reservations, avoidance, service transactions and interaction triggers are not implemented. Audio and VFX cues require runtime event wiring. Opening the fixture never executes a project script.

`assets/PROVENANCE.md` documents the original CC0 placeholders. Geometry uses authored primitives and inline colors; the SVG and palette are source assets, not claims of an implemented import/material pipeline. Rendering, physics, navigation, audio playback, VFX and standalone export must be verified by the runtime/export owners.
