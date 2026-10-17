import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replayOverrides } from '../../../../packages/procedural-authoring/src/index.ts';
import { validatePlayableScene } from '../../../../packages/game-runtime/src/runtime/validate.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, root)), 'utf8'));
const scene = validatePlayableScene(read('scenes/main.scene.json'));
const replay = replayOverrides(read('authoring/generated.json'));
assert.deepEqual(replay.conflicts, []);
assert.deepEqual(replay.scene, scene);
assert.equal(scene.entities.filter(entity => /^city_building_/.test(entity.id)).length, 24);
assert.equal(scene.entities.filter(entity => /^city_car_\d+$/.test(entity.id)).length, 10);
assert(scene.entities.some(entity => entity.id === 'city_park'));
assert(scene.entities.some(entity => entity.id === 'entity_ed2c31d0-48cb-41ec-b08a-4f9bd3008db7'));
const lights = scene.entities.flatMap(entity => entity.components
  .filter(component => entity.enabled && component.enabled && component.type === 'light')
  .map(component => ({ entity, properties: component.properties })));
assert.equal(lights.length, 3);
assert.equal(lights.filter(light => light.properties.castShadows).length, 1);
const sun = lights.find(light => light.entity.id === 'gen_1ccbb62837a9802c')!;
assert(sun.entity.transform.position[1] > 30, 'Sun shadow camera must sit above the skyline');
assert.equal(sun.properties.kind, 'directional');
assert(lights.some(light => light.entity.id === 'city_sky_fill' && light.properties.kind === 'directional'
  && light.properties.castShadows === false), 'City-wide fill must stay shadow-free');
assert(lights.some(light => light.properties.kind === 'omni' && light.properties.range === 8), 'Fountain accent stays local');
console.log(`City verified: ${scene.entities.length} entities, valid runtime scene, exact authoring replay.`);
