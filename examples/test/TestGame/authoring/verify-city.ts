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
assert.equal(scene.entities.filter(entity => entity.parentId === null).length, 4, 'Only City, Cameras, Lighting and the user Box remain at the root');
assert.equal(scene.entities.filter(entity => entity.parentId === 'city_group_buildings').length, 8, 'Buildings are split into eight blocks');
for (const group of scene.entities.filter(entity => entity.id.startsWith('city_group_'))) {
  assert.equal(group.components.length, 0);
  assert.deepEqual(group.transform, { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] });
}
for (const entity of scene.entities.filter(entity => /^city_building_\d+$|^city_car_\d+$|^city_dash_|^city_cross_|^city_tree_/.test(entity.id))) {
  assert(entity.parentId, `${entity.id} must belong to a logical group`);
}
assert.equal(scene.entities.filter(entity => /^city_building_/.test(entity.id)).length, 120);
assert.equal(scene.entities.filter(entity => /^city_car_\d+$/.test(entity.id)).length, 10);
assert(scene.entities.some(entity => entity.id === 'city_park'));
for (const building of scene.entities.filter(entity => /^city_building_\d+$/.test(entity.id))) {
  assert.deepEqual(building.transform.scale, [1, 1, 1], 'Collision ancestors retain uniform scale');
  const body = scene.entities.find(entity => entity.parentId === building.id && entity.name === 'Building facade')!;
  assert(body.transform.scale[0] < 5, 'Expanded city keeps original-sized building footprints');
}
assert.equal(new Set(scene.entities.filter(entity => /^city_building_\d+$/.test(entity.id)).map(entity => entity.transform.position.join(','))).size, 120);
const island = scene.entities.find(entity => entity.id === 'city_base')!;
assert(Math.abs(island.transform.scale[0] * island.transform.scale[2] / (46 * 46) - 5) < 1e-10,
  'City ground area must be five times the original');
for (const side of ['north', 'south', 'east', 'west']) {
  const border = scene.entities.find(entity => entity.id === `city_border_${side}`)!;
  assert(border?.components.some(component => component.type === 'collision' && component.enabled));
}
for (const entity of scene.entities.filter(entity => /^city_body_|^city_tree_trunk_|^city_car_\d+$/.test(entity.id))) {
  assert(entity.components.some(component => component.type === 'collision' && component.enabled), `${entity.id} needs a collider`);
}
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
