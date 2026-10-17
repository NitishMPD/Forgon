import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '@forgon/editor-core';
import { createEntity, createScene, parsePrefab } from '@forgon/project-schema';
import { parsePlacement, placementCommand, primitives } from '../src/model/placement.js';

const surface = { position: [3, 2, -4] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };

test('each supported primitive places its bottom on the surface in one undo step', () => {
  for (const primitive of primitives) {
    const scene = createScene('Test'); const store = new EditorStore(scene, 'r1');
    const placement = placementCommand({ kind: 'primitive', primitive }, surface, []);
    store.execute(placement.command);
    const entity = store.scene.entities[0]!;
    assert.equal(entity.id, placement.selectedId);
    assert.equal(entity.parentId, null);
    const halfHeight = primitive === 'plane' ? 0 : primitive === 'capsule' ? 1 : primitive === 'torus' ? 0.2 : 0.5;
    assert.deepEqual(entity.transform.position, [surface.position[0], surface.position[1] + halfHeight, surface.position[2]]);
    assert.equal(entity.components[0]!.type, 'render');
    assert.equal(entity.components[0]!.properties.primitive, primitive);
    const after = store.scene;
    assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
    assert.equal(store.redo(), true); assert.deepEqual(store.scene, after);
  }
});

test('prefab placement creates an instance subtree with remapped references and one undo step', () => {
  const root = createEntity('Root'); const child = createEntity('Child', root.id);
  child.transform.position = [0, 2, 0];
  root.components.push({ id: 'source_component', type: 'custom', enabled: true,
    properties: { child: child.id }, entityRefs: [child.id], assetRefs: [] });
  const prefab = parsePrefab({ schemaVersion: 1, prefabId: 'test_prefab', name: 'Rock formation', rootId: root.id, entities: [child, root] });
  const before = structuredClone(prefab);
  const scene = createScene('Test');
  const store = new EditorStore(scene, 'r1', { prefabs: [prefab] });
  const placement = placementCommand({ kind: 'prefab', prefabId: prefab.prefabId }, surface, [prefab]);
  store.execute(placement.command);
  const copyRoot = store.scene.entities.find(entity => entity.id === placement.selectedId)!;
  const copyChild = store.scene.entities.find(entity => entity.parentId === copyRoot.id)!;
  assert.equal(copyRoot.name, prefab.name);
  assert.deepEqual(copyRoot.transform.position, surface.position);
  assert.deepEqual(copyChild.transform.position, child.transform.position);
  assert.notEqual(copyRoot.id, root.id); assert.notEqual(copyChild.id, child.id);
  assert.equal(copyRoot.prefab!.prefabId, prefab.prefabId);
  assert.equal(copyRoot.prefab!.sourceEntityId, root.id);
  assert.equal(copyChild.prefab!.sourceEntityId, child.id);
  assert.equal(copyChild.prefab!.instanceId, copyRoot.prefab!.instanceId);
  assert.deepEqual(copyRoot.components[0]!.entityRefs, [copyChild.id]);
  assert.equal(copyRoot.components[0]!.properties.child, copyChild.id);
  assert.notEqual(copyRoot.components[0]!.id, 'source_component');
  assert.deepEqual(prefab, before);
  const again = placementCommand({ kind: 'prefab', prefabId: prefab.prefabId }, surface, [prefab]);
  assert.notEqual(again.selectedId, placement.selectedId);
  assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
});

test('drag payloads and invalid surface/catalog data cannot create scene objects', () => {
  for (const text of ['', '{', 'null', '[]', '{}', '{"kind":"primitive","primitive":"model"}', '{"kind":"prefab","prefabId":"../bad"}']) {
    assert.equal(parsePlacement(text), null);
  }
  assert.deepEqual(parsePlacement('{"kind":"primitive","primitive":"box"}'), { kind: 'primitive', primitive: 'box' });
  assert.deepEqual(parsePlacement('{"kind":"prefab","prefabId":"prefab_1"}'), { kind: 'prefab', prefabId: 'prefab_1' });
  assert.deepEqual(parsePlacement('{"kind":"model","assetId":"model_1"}'), { kind: 'model', assetId: 'model_1' });
  assert.equal(parsePlacement('{"kind":"model","assetId":"../bad.glb"}'), null);
  assert.throws(() => placementCommand({ kind: 'prefab', prefabId: 'missing' }, surface, []), /no longer/);
  assert.throws(() => placementCommand({ kind: 'primitive', primitive: 'box' }, { ...surface, position: [NaN, 0, 0] }, []), /finite/);
});

test('GLB placement uses asset references and loaded bounds, falling back to the origin without them', () => {
  const target = { kind: 'model' as const, assetId: 'model_1' };
  const assets = [{ id: target.assetId, name: 'Model', kind: 'model' as const, path: 'assets/model.glb' }];
  for (const minY of [null, -2, 0.75]) {
    const scene = createScene('Test'); const store = new EditorStore(scene, 'r1', { assets });
    const placement = placementCommand(target, { ...surface, modelMinY: id => { assert.equal(id, target.assetId); return minY; } }, []);
    store.execute(placement.command); const entity = store.scene.entities[0]!;
    assert.deepEqual(entity.transform.position, [3, 2 - (minY ?? 0), -4]);
    assert.equal(entity.components[0]!.type, 'model'); assert.deepEqual(entity.components[0]!.assetRefs, [target.assetId]);
    assert.deepEqual(entity.components[0]!.properties, {});
    assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
  }
  const fallback = placementCommand(target, surface, []);
  assert.equal(fallback.command.type, 'create');
  if (fallback.command.type === 'create') assert.deepEqual(fallback.command.entity.transform.position, surface.position);
  const aligned = placementCommand(target, { ...surface, normal: [0, 0, 1], modelMinY: () => -2 }, [], true);
  if (aligned.command.type === 'create') assert.deepEqual(aligned.command.entity.transform.position, [3, 2, -2]);
  const box = placementCommand({ kind: 'primitive', primitive: 'box' }, { ...surface, normal: [0, 0, 1] }, [], true);
  if (box.command.type === 'create') assert.deepEqual(box.command.entity.transform.position, [3, 2, -3.5]);
  assert.throws(() => placementCommand(target, { ...surface, modelMinY: () => NaN }, []), /finite model bounds/);
  const invalid = placementCommand({ kind: 'model', assetId: 'unknown' }, surface, []);
  assert.throws(() => new EditorStore(createScene('Test'), 'r1', { assets }).execute(invalid.command), /Missing asset/);
});

test('optional alignment puts +Y on the surface normal and remains part of the same undo step', () => {
  for (const normal of [[0, 1, 0], [1, 1, 1], [0, 0, -1], [0, -1, 0]] as [number, number, number][]) {
    const scene = createScene('Test'); const store = new EditorStore(scene, 'r1');
    const placement = placementCommand({ kind: 'primitive', primitive: 'plane' }, { ...surface, normal }, [], true);
    store.execute(placement.command);
    const [x, y, z] = store.scene.entities[0]!.transform.rotationEuler.map(value => value * Math.PI / 180);
    assert.equal(y, 0);
    const up = [-Math.sin(z!) * Math.cos(x!), Math.cos(z!) * Math.cos(x!), Math.sin(x!)];
    const length = Math.hypot(...normal);
    up.forEach((value, index) => assert.ok(Math.abs(value - normal[index]! / length) < 1e-9));
    assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
  }
  assert.throws(() => placementCommand({ kind: 'primitive', primitive: 'box' }, { ...surface, normal: [0, 0, 0] }, [], true), /normal/);
});
