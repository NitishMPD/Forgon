import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openProject } from '../../../../packages/project-io/src/index.ts';
import { validatePlayableScene } from '../../../../packages/game-runtime/src/runtime/validate.ts';
import type { Entity } from '../../../../packages/project-schema/src/index.ts';

async function main() {
  const session = await openProject(fileURLToPath(new URL('../', import.meta.url)));
  try {
    const path = 'scenes/main.scene.json';
    const { document, revision } = await session.sceneIO.readScene(path);
    const roots = document.entities.filter(entity => /^city_building_\d+$/.test(entity.id));
    const bakeFootprints = (): void => {
      for (const root of document.entities.filter(entity => /^city_building_\d+$/.test(entity.id))) {
        const [x, , z] = root.transform.scale;
        for (const child of document.entities.filter(entity => entity.parentId === root.id)) {
          child.transform.position[0] *= x; child.transform.position[2] *= z;
          child.transform.scale[0] *= x; child.transform.scale[2] *= z;
        }
        root.transform.scale = [1, 1, 1];
      }
    };
    const save = async (): Promise<void> => {
      bakeFootprints();
      validatePlayableScene(document);
      const saved = await session.sceneIO.saveScene({ path, document, expectedRevision: revision });
      assert.equal(saved.status, 'saved', 'The project changed during expansion; no overwrite was attempted');
      console.log(`Expanded city: 120 distinct buildings, ${document.entities.length} editable entities.`);
    };
    if (roots.length === 120) {
      if (roots.some(root => root.transform.scale[0] !== 1 || root.transform.scale[2] !== 1)) await save();
      return;
    }
    assert.equal(roots.length, 24, 'Only expand the known 24-building city');
    const templates = structuredClone(document.entities);
    const children = new Map<string, Entity[]>();
    for (const entity of templates) if (entity.parentId) children.set(entity.parentId, [...children.get(entity.parentId) ?? [], entity]);
    const subtree = (entity: Entity): Entity[] => [entity, ...(children.get(entity.id) ?? []).flatMap(subtree)];
    const blocks = new Map<string, Entity[]>();
    const district = (value: number) => value < -20 ? -1 : value > 20 ? 1 : 0;
    for (const root of roots) {
      const key = `${district(root.transform.position[0])},${district(root.transform.position[2])}`;
      blocks.set(key, [...blocks.get(key) ?? [], root]);
    }
    let next = 24;
    for (const [key, originals] of blocks) {
      assert.equal(originals.length, 3);
      const [bx, bz] = key.split(',').map(Number) as [number, number];
      const sources = originals.map(root => subtree(templates.find(entity => entity.id === root.id)!));
      for (let slot = 0; slot < 15; slot++) {
        let root: Entity;
        if (slot < 3) root = originals[slot]!;
        else {
          const index = next++;
          const template = sources[slot % 3]!;
          const source = template.filter((entity, i) => i === 0 || /^city_body_|^city_roof_\d|^city_window_front_\d+_1$|^city_window_side_\d+_1$/.test(entity.id));
          const ids = new Map(source.map((entity, i) => [entity.id, i === 0 ? `city_building_${index}` : `${entity.id}_expanded_${index}`]));
          const copies = structuredClone(source);
          for (const entity of copies) {
            entity.id = ids.get(entity.id)!;
            if (entity.parentId) entity.parentId = ids.get(entity.parentId) ?? entity.parentId;
            for (const component of entity.components) {
              component.id = `${component.id}_expanded_${index}`;
              component.entityRefs = component.entityRefs.map(id => ids.get(id) ?? id);
            }
          }
          root = copies[0]!;
          root.name = `Building ${index + 1}`;
          document.entities.push(...copies);
        }
        // Restore original building footprints; fill the enlarged blocks with new buildings.
        root.transform.scale[0] /= Math.sqrt(5);
        root.transform.scale[2] /= Math.sqrt(5);
        root.transform.position[0] = bx * 33.5 + (slot % 5 - 2) * (bx === 0 ? 4 : 4.8);
        root.transform.position[2] = bz * 33.5 + (Math.floor(slot / 5) - 1) * 8;
      }
    }
    assert.equal(next, 120);
    // The session validates and commits scene + authoring overrides together with a revision guard.
    await save();
  } finally { session.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
