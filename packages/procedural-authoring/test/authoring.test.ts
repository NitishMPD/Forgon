import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScene } from '@forgon/project-schema';
import type { Component, PrefabDocument } from '@forgon/project-schema';
import { bakeAuthoring, captureOverrides, detach, instantiatePrefab, parseAuthoringArtifact, replayOverrides, SceneAuthor } from '../src/index.js';
import type { AuthoringArtifact, PrefabBindings, ManualOverride } from '../src/index.js';

const author = new SceneAuthor('test', 'seed');
function artifact(): AuthoringArtifact {
  const entity = author.entity('box', 'Box');
  entity.components = [{ id: author.id('render'), type: 'render', enabled: true, entityRefs: [], assetRefs: [], properties: { color: [1, 0, 0], label: 'Original' } }];
  return { formatVersion: 1, generator: { id: 'test', version: '1', seed: 'seed' },
    base: parseScene({ schemaVersion: 1, sceneId: author.id('scene'), name: 'Test', entities: [entity] }), overrides: [], detached: [] };
}
function rename(input: AuthoringArtifact): ManualOverride {
  return { overrideId: author.id('rename'), entityId: input.base.entities[0]!.id, field: 'name', before: 'Box', value: 'Manual name' };
}
function prefab(): { prefab: PrefabDocument; bindings: PrefabBindings } {
  const root = author.entity('root', 'Root'); const child = author.entity('child', 'Child', root.id);
  const render: Component = { id: author.id('root-render'), type: 'render', enabled: true, properties: {}, entityRefs: [], assetRefs: ['shared_material'] };
  const link: Component = { id: author.id('child-link'), type: 'link', enabled: true,
    properties: { targets: [root.id], component: render.id, literal: root.id }, entityRefs: [root.id], assetRefs: [] };
  root.components = [render]; child.components = [link];
  return { prefab: { schemaVersion: 1, prefabId: author.id('prefab'), name: 'Pair', rootId: root.id, entities: [root, child] },
    bindings: { formatVersion: 1, prefabId: author.id('prefab'), references: [
      { componentId: link.id, path: ['targets', 0], kind: 'entity' }, { componentId: link.id, path: ['component'], kind: 'component' },
    ] } };
}

test('seeded authoring is deterministic, keyed and stable across seeds', () => {
  const same = new SceneAuthor('test', 'seed'); const different = new SceneAuthor('test', 'different');
  assert.deepEqual(author.entity('box', 'Box'), same.entity('box', 'Box'));
  assert.equal(author.random('box'), same.random('box'));
  same.random('inserted'); assert.equal(author.random('box'), same.random('box'));
  assert.notEqual(author.random('box'), different.random('box'));
  assert.equal(author.id('box'), different.id('box'));
  assert.ok(author.random('box') >= 0 && author.random('box') < 1);
});

test('prefabs remap hierarchy, entity/component identity and declared properties only', () => {
  const source = prefab(); const before = structuredClone(source);
  const instance = instantiatePrefab(source.prefab, 'instance_one', source.bindings);
  const second = instantiatePrefab(source.prefab, 'instance_two', source.bindings);
  const [root, child] = instance.entities;
  assert.equal(child!.parentId, root!.id);
  assert.deepEqual(child!.components[0]!.entityRefs, [root!.id]);
  assert.deepEqual(child!.components[0]!.properties.targets, [root!.id]);
  assert.equal(child!.components[0]!.properties.component, root!.components[0]!.id);
  assert.equal(child!.components[0]!.properties.literal, source.prefab.rootId);
  assert.deepEqual(root!.components[0]!.assetRefs, ['shared_material']);
  assert.equal(root!.prefab!.sourceEntityId, source.prefab.rootId);
  assert.notEqual(root!.id, second.entities[0]!.id);
  assert.deepEqual(instance, instantiatePrefab(source.prefab, 'instance_one', source.bindings));
  parseScene({ schemaVersion: 1, sceneId: 'scene', name: 'Instances', entities: [...instance.entities, ...second.entities] });
  assert.deepEqual(source, before);
});

test('bad prefab reference bindings fail instead of retaining stale IDs', () => {
  const source = prefab(); source.bindings.references[0]!.kind = 'component';
  assert.throws(() => instantiatePrefab(source.prefab, 'instance', source.bindings), /internal object/);
  const other = prefab(); other.bindings.references.push(other.bindings.references[0]!);
  assert.throws(() => instantiatePrefab(other.prefab, 'instance', other.bindings), /Duplicate/);
});

test('replay preserves human fields while accepting unrelated generator edits', () => {
  const input = artifact(); input.overrides.push(rename(input));
  input.overrides.push({ overrideId: 'color_override', entityId: input.base.entities[0]!.id, componentId: input.base.entities[0]!.components[0]!.id,
    field: 'property', path: ['color'], before: [1, 0, 0], value: [0, 1, 0] });
  const original = structuredClone(input); const next = structuredClone(input.base);
  next.entities[0]!.transform.position = [5, 0, 0];
  const result = replayOverrides(input, next);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.scene!.entities[0]!.name, 'Manual name');
  assert.deepEqual(result.scene!.entities[0]!.components[0]!.properties.color, [0, 1, 0]);
  assert.deepEqual(result.scene!.entities[0]!.transform.position, [5, 0, 0]);
  assert.deepEqual(input, original);
});

test('deleted entities/components/properties and competing edits are explicit conflicts', () => {
  const input = artifact(); input.overrides.push(rename(input));
  const changed = structuredClone(input.base); changed.entities[0]!.name = 'Generator name';
  assert.equal(replayOverrides(input, changed).conflicts[0]!.reason, 'generated-change');
  changed.entities = [];
  assert.equal(replayOverrides(input, changed).conflicts[0]!.reason, 'deleted-target');
  const property = artifact(); property.overrides.push({ overrideId: 'property', field: 'property', entityId: property.base.entities[0]!.id,
    componentId: property.base.entities[0]!.components[0]!.id, path: ['label'], before: 'Original', value: 'Human' });
  const removed = structuredClone(property.base); delete removed.entities[0]!.components[0]!.properties.label;
  assert.equal(replayOverrides(property, removed).conflicts[0]!.reason, 'deleted-target');
  removed.entities[0]!.components = [];
  assert.equal(replayOverrides(property, removed).conflicts[0]!.reason, 'deleted-target');
});

test('invalid replay is rejected and already-equal edits are idempotent', () => {
  const input = artifact(); const override = rename(input); input.overrides.push(override);
  const next = structuredClone(input.base); next.entities[0]!.name = 'Manual name';
  assert.deepEqual(replayOverrides(input, next).conflicts, []);
  override.value = '';
  const result = replayOverrides(input);
  assert.equal(result.scene, null); assert.equal(result.conflicts[0]!.reason, 'invalid-result');
});

test('detach preserves manual edits and survives generator deletion without prefab ownership', () => {
  const source = prefab(); const instance = instantiatePrefab(source.prefab, 'instance', source.bindings);
  const input = artifact(); input.base.entities = instance.entities;
  const root = input.base.entities[0]!;
  input.overrides = [{ overrideId: 'rename', entityId: root.id, field: 'name', before: root.name, value: 'Detached root' }];
  const detached = detach(input, instance.entities[1]!.id);
  assert.equal(detached.detached.length, 2); assert.equal(detached.overrides.length, 0);
  assert.ok(detached.detached.every(entity => !entity.prefab));
  const next = structuredClone(input.base); next.entities = [];
  const result = replayOverrides(detached, next);
  assert.deepEqual(result.conflicts, []); assert.equal(result.scene!.entities[0]!.name, 'Detached root');
});

test('strict artifacts reject duplicate overrides and unsafe property paths', () => {
  const input = artifact(); input.overrides = [rename(input), rename(input)];
  assert.throws(() => parseAuthoringArtifact(input), /Duplicate/);
  input.overrides = [{ overrideId: 'bad', entityId: input.base.entities[0]!.id, field: 'property', componentId: 'component', path: ['__proto__'], before: null, value: {} }];
  assert.throws(() => parseAuthoringArtifact(input));
});

test('capture records transform/material/name edits and added objects', () => {
  const input = artifact(); const edited = structuredClone(input.base);
  edited.entities[0]!.name = 'Human'; edited.entities[0]!.transform.position = [2, 3, 4];
  edited.entities[0]!.components[0]!.properties.color = [0, 0, 1];
  const captured = captureOverrides(input, edited);
  assert.equal(captured.overrides.length, 3); assert.deepEqual(replayOverrides(captured).scene, edited);
  assert.deepEqual(captureOverrides(captured, input.base).overrides, []);
  edited.entities.push(author.entity('manual', 'Manual'));
  assert.deepEqual(replayOverrides(captureOverrides(input, edited)).scene, edited);
});

test('bake advances seed/base and preserves manual intent when generation temporarily agrees', () => {
  const input = artifact(); input.overrides.push(rename(input));
  const next = structuredClone(input.base); next.entities[0]!.name = 'Manual name';
  const baked = bakeAuthoring(input, next, { ...input.generator, seed: 'new-seed' });
  assert.ok(baked.authoring); assert.equal(baked.authoring.generator.seed, 'new-seed');
  assert.equal(baked.authoring.overrides[0]!.before, 'Manual name');
  assert.deepEqual(replayOverrides(baked.authoring).scene, baked.scene);
  next.entities[0]!.name = 'Later generated name';
  const conflict = bakeAuthoring(baked.authoring, next);
  assert.equal(conflict.authoring, null); assert.equal(conflict.conflicts[0]!.reason, 'generated-change');
});

test('detached entities retain deleted-parent conflicts instead of silently reparenting', () => {
  const input = artifact(); const child = author.entity('child', 'Child', input.base.entities[0]!.id);
  input.base.entities.push(child);
  const detached = detach(input, child.id);
  const next = structuredClone(input.base); next.entities = [];
  const result = bakeAuthoring(detached, next);
  assert.equal(result.scene, null); assert.equal(result.authoring, null);
  assert.equal(result.conflicts[0]!.reason, 'invalid-result');
});

test('detach and capture preserve author order', () => {
  const input = artifact(); input.base.entities.push(author.entity('second', 'Second'));
  const detached = detach(input, input.base.entities[0]!.id);
  assert.deepEqual(replayOverrides(detached).scene!.entities.map(entity => entity.id), input.base.entities.map(entity => entity.id));
  const reordered = structuredClone(input.base); reordered.entities.reverse();
  assert.deepEqual(replayOverrides(captureOverrides(input, reordered)).scene, reordered);
});

test('structural edits round-trip, can be undone, and conflict with competing generation', () => {
  const input = artifact();
  const edited = structuredClone(input.base);
  const child = author.entity('manual-child', 'Child', edited.entities[0]!.id);
  edited.entities.push(child);
  edited.entities[0]!.components = [];
  edited.entities.reverse();
  const captured = captureOverrides(input, edited);
  assert.deepEqual(replayOverrides(captured).scene, edited);
  assert.deepEqual(replayOverrides(captureOverrides(captured, input.base)).scene, input.base);
  const generated = structuredClone(input.base);
  generated.entities[0]!.name = 'Generator edit';
  assert.equal(bakeAuthoring(captured, generated).authoring, null);
  const baked = bakeAuthoring(captured, input.base);
  assert.ok(baked.authoring);
  assert.deepEqual(replayOverrides(baked.authoring).scene, edited);
  const deleted = { ...input.base, entities: [] };
  assert.deepEqual(replayOverrides(captureOverrides(input, deleted)).scene, deleted);
  const deletionBake = bakeAuthoring(captureOverrides(input, deleted), deleted);
  assert.ok(deletionBake.authoring);
  assert.deepEqual(replayOverrides(deletionBake.authoring).scene, deleted);
  const prefabSource = prefab();
  const instance = instantiatePrefab(prefabSource.prefab, 'manual-instance', prefabSource.bindings);
  const placedPrefab = { ...input.base, entities: [...input.base.entities, ...instance.entities] };
  assert.deepEqual(replayOverrides(captureOverrides(input, placedPrefab)).scene, placedPrefab);
  const detached = detach(input, input.base.entities[0]!.id);
  assert.deepEqual(replayOverrides(captureOverrides(detached, deleted)).scene, deleted);
});
