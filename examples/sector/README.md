# Sector 07 fixture
Author: Nitish

Original, file-first 3D parkour fixture in the silhouette-runner style: **76 entities, 2 prefabs, 5 instances, 3 assets**. Art direction follows the classic high-key look — blown-out white run surfaces and flanking chasm panels backlighting ink-black silhouette sides and a black runner, every platform edge traced by a glowing light line, teal glass data shards, amber checkpoint frames and red sentinel hazards. One complete rooftop course: an entry rooftop with a relay gate spawn, four gaps onto the ferry rooftop, a switchback climb, a 13&nbsp;m chasm crossed by wall-running two neon-lined faces (or riding the relay ferry), a low slide gate on a raised catwalk, a rising uplink lift and a golden goal terrace. Four checkpoint gates, eight data shards, three sentinel plasma hazards and a synthesized relay audio cue complete the loop. The white surface plates are render-only and never touch the simulation.

The files use the shared strict schema v1. `game.project.json` registers the scene, both prefabs and the asset registry. `authoring/generated.json` stores the generated base, generator version/seed (`sector` 1.0.0), manual overrides and detached snapshots; `authoring/relay-lift.bindings.json` declares the lift's waypoint reference for re-instantiation. Stable IDs survive seed changes.

The runner is driven by the engine-free swept-AABB parkour controller in `packages/game-runtime` (run, sprint, coyote jump, double jump, wall run, wall jump, slide) with camera-relative movement aligned to the chase camera and a cinematic follow camera that dollies in from the authored pose (`intro: 3.6`), sits low behind the runner, widens its FOV with speed and rolls into wall runs. Play it from the repository root:

```powershell
pnpm --filter @forgon/game-preview build   # or a dev server on the package
```

then choose **Play Sector 07**. Controls: WASD move, mouse look (pointer lock), Shift sprint, Space jump / double jump, jump against a wall to wall-run and again to wall-jump, C slide, R restart. Reach the uplink relay.

From the repository root, after the parent installs workspace dependencies:

```powershell
pnpm --filter @forgon/cli forge inspect ../../examples/sector
pnpm --filter @forgon/cli forge validate ../../examples/sector
pnpm --filter @forgon/cli forge bake ../../examples/sector --seed night-shift
```

Bake emits `{scene, authoring}` to stdout, changes no files, and fails on conflicts or unrecorded manual scene edits. The seed repicks the course's signature neon accent (kept in the cold cyan–violet band). Do not redirect the bundle over a `.scene.json` file.

`assets/PROVENANCE.md` documents the original CC0 placeholders. Geometry uses authored primitives and inline colors; the wordmark SVG, palette and relay WAV are source assets, not claims of an implemented import/material pipeline. The course's completability is proven headlessly by the `sector` tests in `packages/game-runtime` (every authored gap clears with the run/jump/double-jump vocabulary, the slide gate blocks a standing runner and passes a sliding one, the relay lift carries the runner to the uplink).
