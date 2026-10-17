# TestGame City
Author: Nitish

A compact static city scene built with Forgon's existing render primitives. The start scene contains 24 buildings, four intersecting boulevards, crossings, a central park and fountain, 24 trees, and ten parked cars.

The original scene identity, camera, lights, and user-created box are retained. The camera frames the city. Scene edits are captured as overrides in `authoring/generated.json`, preserving the original generator base and manual editing behavior. No external assets or dependencies are required.

Lighting uses the original directional sun and local omni light plus one city-wide directional sky fill. Only the sun casts shadows; it sits above the skyline. The omni light accents the fountain with an eight-unit range. Lighting remains ordinary editable scene data and replays through authoring overrides.

This is a scene, with no traffic simulation or player gameplay. Validate runtime semantics and exact authoring replay from this directory with `pnpm exec tsx authoring/verify-city.ts`. Visual appearance has not been checked by launching the app.
