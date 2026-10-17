import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntity, createScene } from '@forgon/project-schema';
import type { Component, Transform } from '@forgon/project-schema';
import { EditorStore, applyCommand } from '../src/index.js';

function fixture(revision: string | null = 'r1') {
  const parent = createEntity('Parent');
  const child = createEntity('Child', parent.id);
  const scene = { ...createScene('Test'), entities: [parent, child] };
  return { scene, parent, child, store: new EditorStore(scene, revision) };
}
const transform: Transform = { position: [1, 2, 3], rotationEuler: [0, 90, 0], scale: [1, 1, 1] };
test('commands round-trip 100 edits through undo and redo', () => {
  const { store, scene, parent } = fixture();
  for (let i = 0; i < 100; i++) store.execute({ type: 'rename', entityId: parent.id, name: `Name ${i}` });
  const edited = store.scene;
  assert.equal(store.dirty, true);
  for (let i = 0; i < 100; i++) assert.equal(store.undo(), true);
  assert.deepEqual(store.scene, scene);
  assert.equal(store.dirty, false);
  assert.equal(store.undo(), false);
  for (let i = 0; i < 100; i++) assert.equal(store.redo(), true);
  assert.deepEqual(store.scene, edited);
  assert.equal(store.redo(), false);
});
test('invalid commands and batches are atomic, preserving undo and redo', () => {
  const { store, scene, parent, child } = fixture();
  assert.throws(() => store.execute({ type: 'reparent', entityId: parent.id, parentId: child.id }));
  assert.throws(() => store.execute({ type: 'transform', entityId: parent.id, transform: { ...transform, position: [Infinity, 0, 0] } }));
  assert.throws(() => store.execute({ type: 'create', entity: child }));
  assert.throws(() => store.execute({ type: 'rename', entityId: 'missing', name: 'No' }));
  assert.throws(() => store.execute({ type: 'batch', commands: [
    { type: 'rename', entityId: parent.id, name: 'Changed' },
    { type: 'reparent', entityId: child.id, parentId: 'missing' },
  ] }));
  assert.deepEqual(store.scene, scene);
  assert.equal(store.canUndo, false);
  store.execute({ type: 'rename', entityId: parent.id, name: 'First' });
  store.undo();
  assert.throws(() => store.execute({ type: 'rename', entityId: parent.id, name: '' }));
  assert.equal(store.canRedo, true);
});
test('create, reparent, component upsert/removal and transform form one undo unit', () => {
  const { store, parent, child, scene } = fixture();
  const entity = createEntity('New');
  const component: Component = { id: 'component_a', type: 'render', enabled: true, properties: {}, entityRefs: [child.id], assetRefs: [] };
  store.execute({ type: 'batch', commands: [
    { type: 'create', entity }, { type: 'reparent', entityId: entity.id, parentId: parent.id },
    { type: 'transform', entityId: entity.id, transform }, { type: 'component', entityId: entity.id, component },
    { type: 'component', entityId: entity.id, component: { ...component, enabled: false } },
  ] });
  assert.equal(store.scene.entities[2]!.components.length, 1);
  assert.equal(store.scene.entities[2]!.components[0]!.enabled, false);
  assert.deepEqual(store.scene.entities[2]!.transform, transform);
  store.undo();
  assert.deepEqual(store.scene, scene);
  store.redo();
  store.execute({ type: 'remove-component', entityId: entity.id, componentId: component.id });
  assert.deepEqual(store.scene.entities[2]!.components, []);
  assert.throws(() => store.execute({ type: 'remove-component', entityId: entity.id, componentId: 'missing' }));
});
test('delete removes subtree but cannot leave dangling references; batch can remove references first', () => {
  const { store, scene, parent, child } = fixture();
  const observer = createEntity('Observer');
  observer.components.push({ id: 'component_ref', type: 'target', enabled: true, properties: {}, entityRefs: [child.id], assetRefs: [] });
  store.execute({ type: 'create', entity: observer });
  assert.throws(() => store.execute({ type: 'delete', entityId: parent.id }));
  store.execute({ type: 'batch', commands: [
    { type: 'remove-component', entityId: observer.id, componentId: 'component_ref' },
    { type: 'delete', entityId: parent.id },
  ] });
  assert.deepEqual(store.scene.entities.map(entity => entity.id), [observer.id]);
  store.undo();
  store.undo();
  assert.deepEqual(store.scene, scene);
});
test('batch deletion terminates even if an earlier batch operation made a temporary cycle', () => {
  const { scene, parent, child } = fixture();
  assert.deepEqual(applyCommand(scene, { type: 'batch', commands: [
    { type: 'reparent', entityId: parent.id, parentId: child.id }, { type: 'delete', entityId: parent.id },
  ] }).entities, []);
});
test('callers cannot mutate store through source, getters, context, or command objects', () => {
  const { store, scene, parent } = fixture();
  scene.entities[0]!.name = 'Outside';
  store.scene.entities[0]!.name = 'Outside again';
  store.execute({ type: 'transform', entityId: parent.id, transform });
  const expected = structuredClone(store.scene);
  const snapshot = store.prepareSave();
  snapshot.document.entities[0]!.name = 'Tampered';
  assert.throws(() => store.acknowledgeSave(snapshot, 'r2'));
  assert.deepEqual(store.scene, expected);
  assert.equal(store.scene.entities[0]!.name, 'Parent');
});
test('external invalid edits retain current state, history, revision and conflict', () => {
  const { store, scene, parent } = fixture();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Ours' });
  const ours = store.scene;
  assert.throws(() => store.reconcile({ ...scene, schemaVersion: 2 }, 'r2'));
  assert.deepEqual(store.scene, ours);
  assert.equal(store.revision, 'r1');
  assert.equal(store.canUndo, true);
  store.reconcile({ ...scene, name: 'Theirs' }, 'r2');
  const conflict = store.conflict;
  assert.throws(() => store.reconcile({}, 'r3'));
  assert.deepEqual(store.conflict, conflict);
});
test('clean external replacement clears undo and returns unchanged for watcher duplicates', () => {
  const { store, scene, parent } = fixture();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Changed' });
  store.undo();
  assert.equal(store.canRedo, true);
  const theirs = { ...scene, name: 'External' };
  assert.equal(store.reconcile(theirs, 'r2'), 'reloaded');
  assert.deepEqual(store.scene, theirs);
  assert.equal(store.dirty, false);
  assert.equal(store.canRedo, false);
  assert.equal(store.reconcile(theirs, 'r2'), 'unchanged');
  assert.throws(() => store.reconcile(scene, 'r2'));
  assert.throws(() => store.reconcile({ ...scene, sceneId: 'different' }, 'r3'));
});
test('dirty external replacement requires explicit choice; ours rebases and theirs reloads', () => {
  for (const choice of ['ours', 'theirs'] as const) {
    const { store, scene, parent } = fixture();
    store.execute({ type: 'rename', entityId: parent.id, name: 'Ours' });
    const ours = store.scene;
    const theirs = { ...scene, name: 'Theirs' };
    assert.equal(store.reconcile(theirs, 'r2'), 'conflict');
    assert.equal(store.reconcile(theirs, 'r2'), 'conflict');
    assert.deepEqual(store.scene, ours);
    assert.deepEqual(store.conflict, { base: scene, ours, theirs, revision: 'r2' });
    store.conflict!.ours.name = 'Tampered';
    assert.deepEqual(store.scene, ours);
    assert.throws(() => store.prepareSave());
    assert.throws(() => store.undo());
    assert.throws(() => store.execute({ type: 'delete', entityId: parent.id }));
    store.resolveConflict(choice);
    assert.deepEqual(store.scene, choice === 'ours' ? ours : theirs);
    assert.equal(store.revision, 'r2');
    assert.equal(store.dirty, choice === 'ours');
    assert.equal(store.canUndo, false);
  }
});
test('save acknowledgement uses saved snapshot, preserving edits made while IO was pending', () => {
  const { store, parent } = fixture();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Saved' });
  const snapshot = store.prepareSave();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Later' });
  store.acknowledgeSave(snapshot, 'r2');
  assert.equal(store.dirty, true);
  assert.equal(store.revision, 'r2');
  store.undo();
  assert.equal(store.dirty, false);
  assert.throws(() => store.acknowledgeSave(snapshot, 'r3'));
});
test('external revision change invalidates pending saves even after conflict resolution', () => {
  const { store, scene, parent } = fixture();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Ours' });
  const snapshot = store.prepareSave();
  store.reconcile({ ...scene, name: 'New disk content' }, 'r2');
  store.resolveConflict('ours');
  assert.throws(() => store.acknowledgeSave(snapshot, 'r3'));
  assert.equal(store.dirty, true);
  const rebased = store.prepareSave();
  assert.equal(rebased.expectedRevision, 'r2');
  store.acknowledgeSave(rebased, 'r3');
  assert.equal(store.dirty, false);
});
test('new document remains dirty until first create-only save and subscribers can unsubscribe', () => {
  const { store, parent } = fixture(null);
  assert.equal(store.dirty, true);
  let changes = 0;
  const unsubscribe = store.subscribe(() => { changes++; });
  const snapshot = store.prepareSave();
  assert.equal(snapshot.expectedRevision, null);
  store.acknowledgeSave(snapshot, 'r1');
  assert.equal(store.dirty, false);
  unsubscribe();
  store.execute({ type: 'rename', entityId: parent.id, name: 'New' });
  assert.equal(changes, 1);
});
test('own save watcher event before IO acknowledgement preserves later local edits and undo', () => {
  for (const editWhilePending of [true, false]) {
    const { store, parent } = fixture();
    store.execute({ type: 'rename', entityId: parent.id, name: 'Saved' });
    const snapshot = store.prepareSave();
    if (editWhilePending) store.execute({ type: 'rename', entityId: parent.id, name: 'Later' });
    const ours = store.scene;
    assert.equal(store.reconcile(snapshot.document, 'r2'), 'reloaded');
    assert.equal(store.conflict, null);
    assert.deepEqual(store.scene, ours);
    assert.equal(store.dirty, editWhilePending);
    store.acknowledgeSave(snapshot, 'r2');
    assert.equal(store.revision, 'r2');
    assert.equal(store.canUndo, true);
    assert.throws(() => store.acknowledgeSave(snapshot, 'r2'));
  }
});
test('save cannot acknowledge changed content with the original byte revision', () => {
  const { store, parent } = fixture();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Changed' });
  assert.throws(() => store.acknowledgeSave(store.prepareSave(), 'r1'));
  assert.equal(store.dirty, true);
  assert.equal(store.revision, 'r1');
});
test('mutating a pending snapshot cannot poison valid external reconciliation', () => {
  const { store, parent } = fixture();
  store.execute({ type: 'rename', entityId: parent.id, name: 'Saved' });
  const snapshot = store.prepareSave();
  const actualWrite = structuredClone(snapshot.document);
  snapshot.document.entities[0]!.transform.position[0] = Infinity;
  assert.equal(store.reconcile(actualWrite, 'r2'), 'reloaded');
  assert.equal(store.dirty, false);
  assert.throws(() => store.acknowledgeSave(snapshot, 'r2'));
});

 test('entity enabled uses validated undoable commands without touching children', () => {
  const { store, parent, child, scene } = fixture();
  store.execute({ type: 'enabled', entityId: parent.id, enabled: false });
  assert.equal(store.scene.entities.find(item => item.id === parent.id)!.enabled, false);
  assert.equal(store.scene.entities.find(item => item.id === child.id)!.enabled, true);
  assert.equal(store.dirty, true);
  store.undo();
  assert.deepEqual(store.scene, scene);
  store.redo();
  assert.equal(store.scene.entities[0]!.enabled, false);
  assert.throws(() => store.execute({ type: 'enabled', entityId: 'missing', enabled: true }));
});

test('catalog refresh preserves dirty history and rejects removing referenced assets atomically', () => {
  const { store, parent } = fixture();
  const asset = { id: 'asset_new', name: 'New', kind: 'texture' as const, path: 'assets/new.png' };
  store.updateContext({ assets: [asset], prefabs: [] });
  store.execute({ type: 'component', entityId: parent.id, component: { id: 'c_new', type: 'render', enabled: true, properties: {}, entityRefs: [], assetRefs: [asset.id] } });
  assert.throws(() => store.updateContext({ assets: [], prefabs: [] }));
  store.undo(); store.redo();
  assert.equal(store.scene.entities[0]!.components[0]!.assetRefs[0], asset.id);
  assert.equal(store.dirty, true);
});
