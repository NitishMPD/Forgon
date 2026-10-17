import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '@forgon/editor-core';
import { createEntity, createScene, parsePrefab } from '@forgon/project-schema';
import { parsePlacement, placementCommand, primitives } from '../src/model/placement.js';

const surface = { position: [3, 2, -4] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };

test('each supported primitive places a render entity at the surface in one undo step', () => {
  for (const primitive of primitives) {
    const scene = createScene('Test'); const store = new EditorStore(scene, 'r1');
    const placement = placementCommand({ kind: 'primitive', primitive }, surface, []);
    store.execute(placement.command);
    const entity = store.scene.entities[0]!;
    assert.equal(entity.id, placement.selectedId);
    assert.equal(entity.parentId, null);
    assert.deepEqual(entity.transform.position, surface.position);
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
  assert.throws(() => placementCommand({ kind: 'prefab', prefabId: 'missing' }, surface, []), /no longer/);
  assert.throws(() => placementCommand({ kind: 'primitive', primitive: 'box' }, { ...surface, position: [NaN, 0, 0] }, []), /finite/);
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
