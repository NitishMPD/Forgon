import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore, applyCommand, type SceneCommand } from '@forgon/editor-core';
import { createEntity, createScene, parseScene, type Component, type Entity, type PrefabInstance, type SceneDocument } from '@forgon/project-schema';
import {
  canReparent,
  descendantIds,
  duplicatePlan,
  indentTarget,
  outdentTarget,
  reparentCommands,
} from '../src/model/hierarchyOps.js';
import { parseJsonDraft, propertyKind, withProperty } from '../src/model/properties.js';
import { keyboardResize, rightDockSharesInspector, sharedRightDockBelow } from '../src/model/layout.js';
import { planSceneSwitch } from '../src/model/sceneSwitch.js';

// Root > Child > Grandchild, Root > Sibling, Other (root-level)
function tree(): { scene: SceneDocument; ids: Record<string, string> } {
  const root = createEntity('Root');
  const child = createEntity('Child', root.id);
  const grandchild = createEntity('Grandchild', child.id);
  const sibling = createEntity('Sibling', root.id);
  const other = createEntity('Other');
  const scene = parseScene({ ...createScene('Test'), entities: [root, child, grandchild, sibling, other] });
  return { scene, ids: { root: root.id, child: child.id, grandchild: grandchild.id, sibling: sibling.id, other: other.id } };
}

function prefabMember(entity: Entity, instanceId: string): Entity {
  const prefab: PrefabInstance = { prefabId: 'prefab_guest', instanceId, sourceEntityId: 'source_root' };
  return { ...entity, prefab };
}

test('reparent refuses cycles, self-parenting, and unknown parents, and allows siblings and the root', () => {
  const { scene, ids } = tree();
  assert.equal(canReparent(scene.entities, [ids.root!], ids.grandchild!).ok, false);
  assert.match((canReparent(scene.entities, [ids.root!], ids.child!) as { reason: string }).reason, /own child/);
  assert.match((canReparent(scene.entities, [ids.child!], ids.child!) as { reason: string }).reason, /own parent/);
  assert.match((canReparent(scene.entities, [ids.child!], 'entity_missing') as { reason: string }).reason, /no longer exists/);
  assert.equal(canReparent(scene.entities, [ids.grandchild!], ids.sibling!).ok, true);
  assert.equal(canReparent(scene.entities, [ids.grandchild!], null).ok, true);
  assert.deepEqual([...descendantIds(scene.entities, ids.root!)].sort(), [ids.child!, ids.grandchild!, ids.sibling!].sort());
});

test('prefab instance members cannot be reparented or used as a new parent', () => {
  const { scene, ids } = tree();
  const entities = scene.entities.map(entity => (entity.id === ids.sibling ? prefabMember(entity, 'instance_1') : entity));
  assert.match((canReparent(entities, [ids.sibling!], ids.other!) as { reason: string }).reason, /Prefab instance members/);
  assert.match((canReparent(entities, [ids.other!], ids.sibling!) as { reason: string }).reason, /Prefab instance members/);
});

test('reparent over a selection moves only the topmost objects, so children travel with a selected parent', () => {
  const { scene, ids } = tree();
  const plan = reparentCommands(scene.entities, [ids.child!, ids.grandchild!], ids.other!);
  assert.ok(plan.ok);
  assert.deepEqual(plan.value, { type: 'reparent', entityId: ids.child, parentId: ids.other });
  const moved = applyCommand(scene, plan.value);
  assert.equal(moved.entities.find(entity => entity.id === ids.grandchild)?.parentId, ids.child);
  assert.equal(reparentCommands(scene.entities, [ids.child!], ids.root!).ok, false);
});

test('indent and outdent pick a previous sibling or the grandparent, and refuse where nothing applies', () => {
  const { scene, ids } = tree();
  assert.deepEqual(indentTarget(scene.entities, ids.sibling!), { ok: true, value: ids.child });
  assert.equal(indentTarget(scene.entities, ids.child!).ok, false);
  assert.deepEqual(outdentTarget(scene.entities, ids.grandchild!), { ok: true, value: ids.root });
  assert.deepEqual(outdentTarget(scene.entities, ids.child!), { ok: true, value: null });
  assert.equal(outdentTarget(scene.entities, ids.other!).ok, false);
});

test('duplicating a subtree gives fresh IDs, remaps internal references, and keeps external ones', () => {
  const { scene, ids } = tree();
  const external = createEntity('External');
  const queueComponent: Component = {
    id: 'component_queue',
    type: 'guestQueue',
    enabled: true,
    properties: { waypoints: [ids.grandchild!, external.id], visualComponentId: 'component_render' },
    entityRefs: [ids.grandchild!, external.id],
    assetRefs: [],
  };
  const renderComponent: Component = { id: 'component_render', type: 'render', enabled: true, properties: { primitive: 'box' }, entityRefs: [], assetRefs: [] };
  const withRefs = parseScene({
    ...scene,
    entities: [
      ...scene.entities.map(entity => {
        if (entity.id === ids.child) return { ...entity, components: [queueComponent, renderComponent] };
        return entity;
      }),
      external,
    ],
  });
  const plan = duplicatePlan(withRefs.entities, [ids.child!], () => `${Math.random().toString(36).slice(2)}_id`);
  assert.ok(plan.ok);
  const duplicated = applyCommand(withRefs, { type: 'batch', commands: plan.value.commands }, {});
  const [copyId] = plan.value.topLevelIds;
  const copy = duplicated.entities.find(entity => entity.id === copyId)!;
  assert.equal(copy.name, 'Child copy');
  assert.equal(copy.parentId, ids.root);
  const copyGrand = duplicated.entities.find(entity => entity.parentId === copyId)!;
  assert.notEqual(copyGrand.id, ids.grandchild);
  const copyQueue = copy.components.find(component => component.type === 'guestQueue')!;
  assert.notEqual(copyQueue.id, 'component_queue');
  assert.deepEqual(copyQueue.entityRefs, [copyGrand.id, external.id]);
  assert.deepEqual(copyQueue.properties.waypoints, [copyGrand.id, external.id]);
  const copyRender = copy.components.find(component => component.type === 'render')!;
  assert.equal(copyQueue.properties.visualComponentId, copyRender.id);
  assert.equal(duplicated.entities.filter(entity => entity.id === ids.child).length, 1, 'original is untouched');
});

test('duplicates of prefab members are refused rather than producing a second instance member', () => {
  const { scene, ids } = tree();
  const entities = scene.entities.map(entity => (entity.id === ids.sibling ? prefabMember(entity, 'instance_1') : entity));
  const plan = duplicatePlan(entities, [ids.sibling!], () => 'entity_copy');
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? '' : plan.reason, /Prefab instance members/);
});

test('a duplicate batch is one undoable step in the store', () => {
  const { scene, ids } = tree();
  const store = new EditorStore(scene, 'r1');
  const plan = duplicatePlan(scene.entities, [ids.grandchild!], () => `${Math.random().toString(36).slice(2)}_id`);
  assert.ok(plan.ok);
  store.execute({ type: 'batch', commands: plan.value.commands });
  assert.equal(store.scene.entities.length, scene.entities.length + 1);
  assert.equal(store.undo(), true);
  assert.equal(store.scene.entities.length, scene.entities.length);
});

test('property kinds follow the JSON shape: finite triples are vectors, everything else is JSON', () => {
  assert.equal(propertyKind(true), 'boolean');
  assert.equal(propertyKind(1.2), 'number');
  assert.equal(propertyKind('Queue'), 'string');
  assert.equal(propertyKind([0.1, 0.2, 0.3]), 'vector3');
  assert.equal(propertyKind([1, 2]), 'json');
  assert.equal(propertyKind(['entity_a']), 'json');
  assert.equal(propertyKind(null), 'json');
});

test('JSON drafts must parse to finite values; overflowing numbers are rejected', () => {
  assert.deepEqual(parseJsonDraft('["a", 2]'), { ok: true, value: ['a', 2] });
  assert.equal(parseJsonDraft('[1,').ok, false);
  const overflow = parseJsonDraft('[1e400]');
  assert.equal(overflow.ok, false);
  assert.match(overflow.ok ? '' : overflow.message, /finite/);
});

test('a property edit is a whole-component upsert that only changes the named key', () => {
  const component: Component = {
    id: 'component_queue',
    type: 'guestQueue',
    enabled: true,
    properties: { speed: 1.2, loop: true },
    entityRefs: [],
    assetRefs: [],
  };
  const next = withProperty(component, 'speed', 2);
  assert.deepEqual(next.properties, { speed: 2, loop: true });
  assert.deepEqual(component.properties, { speed: 1.2, loop: true }, 'input is not mutated');
  assert.throws(() => withProperty(component, 'missing', 1), /Unknown property/);
});

test('the store accepts a valid property upsert and rejects a non-finite one with state unchanged', () => {
  const root = createEntity('Lobby');
  const camera: Component = { id: 'component_camera', type: 'camera', enabled: true, properties: { fov: 50 }, entityRefs: [], assetRefs: [] };
  const entity = { ...root, components: [camera] };
  const store = new EditorStore(parseScene({ ...createScene('Lobby'), entities: [entity] }), 'r1');
  const valid: SceneCommand = { type: 'component', entityId: root.id, component: withProperty(camera, 'fov', 35) };
  store.execute(valid);
  assert.equal(store.scene.entities[0]?.components[0]?.properties['fov'], 35);
  const before = store.scene;
  const invalid: SceneCommand = { type: 'component', entityId: root.id, component: withProperty(camera, 'fov', Number.NaN) };
  assert.throws(() => store.execute(invalid));
  assert.deepEqual(store.scene, before);
  assert.equal(store.undo(), true);
  assert.equal(store.scene.entities[0]?.components[0]?.properties['fov'], 50);
});

test('keyboard resizing steps, large steps with Shift, clamps, Home and End, and ignores other keys', () => {
  const limits = [200, 360] as const;
  assert.equal(keyboardResize(264, 'ArrowRight', { shiftKey: false }, 1, limits), 272);
  assert.equal(keyboardResize(264, 'ArrowLeft', { shiftKey: false }, 1, limits), 256);
  assert.equal(keyboardResize(264, 'ArrowRight', { shiftKey: true }, 1, limits), 296);
  assert.equal(keyboardResize(264, 'ArrowRight', { shiftKey: false }, -1, limits), 256, 'direction flips the growth side');
  assert.equal(keyboardResize(355, 'ArrowRight', { shiftKey: true }, 1, limits), 360, 'clamps at the maximum');
  assert.equal(keyboardResize(264, 'Home', { shiftKey: false }, 1, limits), 200);
  assert.equal(keyboardResize(264, 'End', { shiftKey: false }, 1, limits), 360);
  assert.equal(keyboardResize(264, 'a', { shiftKey: false }, 1, limits), null);
});

test('scene switching asks before dropping unsaved edits and never switches through an open conflict', () => {
  const base = { current: 'scenes/lobby.scene.json', target: 'scenes/floor-02.scene.json' };
  assert.deepEqual(planSceneSwitch({ ...base, target: base.current, dirty: true, conflict: false }), { action: 'none' });
  assert.deepEqual(planSceneSwitch({ ...base, dirty: false, conflict: false }), { action: 'switch' });
  assert.deepEqual(planSceneSwitch({ ...base, dirty: true, conflict: false }), { action: 'confirm' });
  const blocked = planSceneSwitch({ ...base, dirty: true, conflict: true });
  assert.equal(blocked.action, 'blocked');
  assert.match(blocked.action === 'blocked' ? blocked.reason : '', /Resolve the file conflict/);
});

test('the right dock shares the inspector column below 1680 px and keeps its own column at 1680 px and above', () => {
  assert.equal(sharedRightDockBelow, 1680);
  assert.equal(rightDockSharesInspector(1679), true);
  assert.equal(rightDockSharesInspector(1680), false);
  assert.equal(rightDockSharesInspector(1920), false);
});
