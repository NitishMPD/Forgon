# Sector 07 parkour fixture
Author: Nitish

Original, file-first authoring fixture: **69 entities, 2 prefab definitions, 5 prefab instances**, six rooftop decks with lips, a 13 m wall-run chasm between two faces, a raised slide run with a low gate, a relay ferry and a rising lift, four checkpoint gates (one is the spawn), eight data shards, three sentinel hazards, an uplink goal, three lights and a cinematic follow camera.

`SECTOR 07` is one complete parkour course: run the relay rooftop network, double-jump the wall-run chasm, slide under the gate, ride the lift up and reach the uplink. Movement is run, sprint, coyote jump, double jump, wall run, wall jump and slide, driven by the shipped `player` convention and simulated headlessly.

The files use the shared strict schema v1. `game.project.json` registers the scene, the two prefabs and the assets. `authoring/generated.json` stores the generated base, generator version/seed, manual overrides, detached snapshots and prefab-binding catalog separately. `authoring/relay-lift.bindings.json` declares the internal platform-path reference the lift prefab rewires per instance. Stable IDs survive seed changes; the one seeded value is the course's signature neon accent.

Scaffold a fresh copy anywhere with `pnpm --filter @forgon/cli forge create <root> --template sector`. From the repository root, after the parent installs workspace dependencies:

```powershell
pnpm --filter @forgon/cli forge inspect ../../examples/sector
pnpm --filter @forgon/cli forge validate ../../examples/sector
pnpm --filter @forgon/cli forge bake ../../examples/sector --seed second-layout
```

Bake emits `{scene, authoring}` to stdout, changes no files, and fails on conflicts or unrecorded manual scene edits. Capture visual edits with `captureOverrides(artifact, editedScene)` before regeneration. Persist the scene and corresponding artifact together through the project-io integration; the CLI does not provide writes yet. Do not redirect the bundle over a `.scene.json` file.

Exact runtime conventions and integration needs are in `docs/research/authoring-cli.md`. The parkour controller is a pure, engine-free swept-AABB simulation (`packages/game-runtime/src/runtime/parkour.ts`, fixed step 1/120 s) specialised to authored box geometry; the play session writes its transforms back onto the projected graph. Wall runs read side contacts on the X axis only, so the chasm corridor runs along +Z with its faces at ±X. Moving-platform colliders are trigger boxes carrying a static deck size. Authored jumps and mechanics are proven by `packages/game-runtime/test/sector.test.ts` against this exact checked-in fixture. Browser input (keyboard, mouse look/pointer lock, gamepad, touch), the HUD overlay and the intro dolly are optional and browser-only.

`assets/PROVENANCE.md` documents the original CC0 placeholders. Geometry uses authored primitives and inline colors; the SVG and palette are source assets, not claims of an implemented import/material pipeline. Rendering, physics, navigation, audio playback and standalone export must be verified by the runtime/export owners.
