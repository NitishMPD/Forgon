import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openProject } from '../../../../packages/project-io/src/index.ts';
import { createEntity } from '../../../../packages/project-schema/src/index.ts';
import { validatePlayableScene } from '../../../../packages/game-runtime/src/runtime/validate.ts';

async function main() {
  const session = await openProject(fileURLToPath(new URL('../', import.meta.url)));
  try {
    const path = 'scenes/main.scene.json';
    const { document, revision } = await session.sceneIO.readScene(path);
    if (document.entities.some(entity => entity.id === 'city_group_city')) return;
    const originals = structuredClone(document.entities);
    const group = (id: string, name: string, parentId: string | null = 'city_group_city'): string => {
      const entity = createEntity(name, parentId); entity.id = `city_group_${id}`;
      assert(!document.entities.some(existing => existing.id === entity.id));
      document.entities.push(entity); return entity.id;
    };
    group('city', 'City', null);
    const cameras = group('cameras', 'Cameras', null);
    const lighting = group('lighting', 'Lighting', null);
    const terrain = group('terrain', 'Ground');
    const roads = group('roads', 'Roads');
    const buildings = group('buildings', 'Buildings');
    const park = group('park', 'Central park');
    const vehicles = group('vehicles', 'Vehicles');
    const borders = group('borders', 'Borders');
    const markings = group('crossings', 'Crossings', roads);
    const fountain = group('fountain', 'Fountain', park);
    const trees = group('trees', 'Trees', park);
    const blocks = new Map<string, string>();
    const boulevards = new Map<string, string>();
    const treeGroups = new Map<string, string>();
    const district = (value: number) => value < -20 ? -1 : value > 20 ? 1 : 0;
    for (const entity of document.entities.filter(entity => originals.some(original => original.id === entity.id) && !entity.parentId)) {
      const id = entity.id;
      if (/^city_building_\d+$/.test(id)) {
        const [x, , z] = entity.transform.position;
        const bx = district(x), bz = district(z), key = `${bx}_${bz}`;
        if (!blocks.has(key)) blocks.set(key, group(`block_${key}`, `${bz < 0 ? 'South' : bz > 0 ? 'North' : ''}${bx < 0 ? 'west' : bx > 0 ? 'east' : ''} block`, buildings));
        entity.parentId = blocks.get(key)!;
      } else if (/^city_(road|dash)_/.test(id)) {
        const [, , axis, offset] = id.split('_'); const key = `${axis}_${offset}`;
        if (!boulevards.has(key)) boulevards.set(key, group(`boulevard_${key}`, `${axis!.toUpperCase()} boulevard ${offset}`, roads));
        entity.parentId = boulevards.get(key)!;
      } else if (id.startsWith('city_cross_')) entity.parentId = markings;
      else if (id.startsWith('city_tree_')) {
        const index = id.split('_').at(-1)!;
        if (!treeGroups.has(index)) treeGroups.set(index, group(`tree_${index}`, `Tree ${Number(index) + 1}`, trees));
        entity.parentId = treeGroups.get(index)!;
      } else if (id.startsWith('city_fountain_')) entity.parentId = fountain;
      else if (id === 'city_park' || id.startsWith('city_path_')) entity.parentId = park;
      else if (/^city_car_\d+$/.test(id)) entity.parentId = vehicles;
      else if (id.startsWith('city_border_')) entity.parentId = borders;
      else if (id === 'city_base' || id === 'city_paving') entity.parentId = terrain;
      else if (entity.components.some(component => component.type === 'camera')) entity.parentId = cameras;
      else if (entity.components.some(component => component.type === 'light')) entity.parentId = lighting;
    }
    // New parents are empty identity transforms; every existing entity keeps its local transform and components.
    for (const original of originals) {
      const current = document.entities.find(entity => entity.id === original.id)!;
      assert.deepEqual({ ...current, parentId: original.parentId }, original);
      if (current.parentId !== original.parentId) {
        let parentId = current.parentId;
        while (parentId) {
          const parent = document.entities.find(entity => entity.id === parentId)!;
          assert.deepEqual(parent.transform, { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] });
          parentId = parent.parentId;
        }
      }
    }
    validatePlayableScene(document);
    const saved = await session.sceneIO.saveScene({ path, document, expectedRevision: revision });
    assert.equal(saved.status, 'saved', 'Concurrent edits prevent hierarchy overwrite');
    console.log(`Organized city into ${document.entities.length - originals.length} named groups; existing transforms and references preserved.`);
  } finally { session.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
