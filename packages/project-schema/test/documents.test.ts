import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntity, createScene, parseScene, parsePrefab, parseAssetRegistry, parseProjectManifest,
  relativePathSchema, serializeScene, validateProject,
} from '../src/index.js';
import type { Component, PrefabDocument, ProjectManifest } from '../src/index.js';

function fixture() {
  const parent = createEntity('Parent');
  const child = createEntity('Child', parent.id);
  const scene = { ...createScene('Scene'), entities: [parent, child] };
  return { parent, child, scene };
}
const component = (id = 'component_test'): Component => ({
  id, type: 'render', enabled: true, properties: { color: [1, 0, 0], note: null }, entityRefs: [], assetRefs: [],
});

test('scene canonical serialization round-trips stable IDs and ordering', () => {
  const { scene } = fixture();
  const text = serializeScene(scene);
  assert.deepEqual(parseScene(JSON.parse(text)), scene);
  assert.equal(serializeScene(parseScene(JSON.parse(text))), text);
  assert.ok(text.endsWith('\n'));
});
test('unknown fields and unsupported schema versions cannot silently lose data', () => {
  const { scene } = fixture();
  assert.throws(() => parseScene({ ...scene, schemaVersion: 2 }));
  assert.throws(() => parseScene({ ...scene, futureFeature: true }));
  assert.throws(() => parseScene({ ...scene, entities: [{ ...scene.entities[0], futureFeature: true }] }));
});
test('reject finite-transform violations while allowing zero and mirrored scale', () => {
  const { scene, parent } = fixture();
  for (const invalid of [NaN, Infinity, -Infinity]) {
    parent.transform.position[0] = invalid;
    assert.throws(() => parseScene(scene));
  }
  parent.transform.position[0] = 0;
  parent.transform.scale = [-1, 0, 1];
  assert.doesNotThrow(() => parseScene(scene));
  parent.components.push({ ...component(), properties: { bad: Infinity } });
  assert.throws(() => parseScene(scene));
});
test('reject duplicate IDs, malformed IDs, missing parents, self and multi-node cycles', () => {
  const { scene, parent, child } = fixture();
  assert.throws(() => parseScene({ ...scene, entities: [parent, parent] }));
  assert.throws(() => parseScene({ ...scene, sceneId: parent.id }));
  assert.throws(() => parseScene({ ...scene, sceneId: '../scene' }));
  child.parentId = 'missing';
  assert.throws(() => parseScene(scene));
  child.parentId = child.id;
  assert.throws(() => parseScene(scene));
  child.parentId = parent.id;
  parent.parentId = child.id;
  assert.throws(() => parseScene(scene));
});
test('parsing does not rewrite authored names or share mutable input', () => {
  const { scene } = fixture();
  scene.name = '  Authored spacing  ';
  const parsed = parseScene(scene);
  assert.equal(parsed.name, scene.name);
  parsed.entities[0]!.transform.position[0] = 99;
  assert.equal(scene.entities[0]!.transform.position[0], 0);
});
test('component IDs and explicit references are validated', () => {
  const { scene, parent, child } = fixture();
  parent.components.push(component(parent.id));
  assert.throws(() => parseScene(scene));
  parent.components = [component()];
  child.components = [component()];
  assert.throws(() => parseScene(scene));
  child.components = [];
  parent.components[0]!.entityRefs = ['missing'];
  assert.throws(() => parseScene(scene));
  parent.components[0]!.entityRefs = [child.id];
  parent.components[0]!.assetRefs = ['asset_model'];
  assert.doesNotThrow(() => parseScene(scene));
  assert.throws(() => parseScene(scene, { assets: [] }));
  assert.doesNotThrow(() => parseScene(scene, { assets: [{ id: 'asset_model', name: 'Model', path: 'assets/model.glb', kind: 'model' }] }));
});
test('prefab root, source IDs and instance mapping are validated', () => {
  const source = createEntity('Source');
  const prefab: PrefabDocument = { schemaVersion: 1, prefabId: 'prefab_test', name: 'Test', rootId: source.id, entities: [source] };
  assert.deepEqual(parsePrefab(prefab), prefab);
  assert.throws(() => parsePrefab({ ...prefab, rootId: 'missing' }));
  assert.throws(() => parsePrefab({ ...prefab, entities: [source, createEntity('Other root')] }));
  const { scene, parent, child } = fixture();
  parent.prefab = { prefabId: prefab.prefabId, instanceId: 'instance_test', sourceEntityId: source.id };
  assert.doesNotThrow(() => parseScene(scene, { prefabs: [prefab] }));
  assert.throws(() => parseScene(scene, { prefabs: [] }));
  child.prefab = { ...parent.prefab };
  assert.throws(() => parseScene(scene, { prefabs: [prefab] }));
  child.prefab.sourceEntityId = 'missing';
  assert.throws(() => parseScene(scene, { prefabs: [prefab] }));
  child.prefab.prefabId = 'different_prefab';
  assert.throws(() => parseScene(scene));
});
test('relative paths reject Windows/Unix escapes and noncanonical segments', () => {
  for (const invalid of ['/tmp/file', '../file', 'a/../file', 'C:/file', 'C:\\file', 'a\\file', '//host/file', './file', 'a//file', 'a/./file', 'a/\0file', '']) {
    assert.equal(relativePathSchema.safeParse(invalid).success, false, invalid);
  }
  assert.equal(relativePathSchema.parse('assets/my model.glb'), 'assets/my model.glb');
});
test('project validation checks complete catalogs, references, and project-wide identity', () => {
  const { scene, parent } = fixture();
  const manifest: ProjectManifest = { schemaVersion: 1, projectId: 'project_test', name: 'Test', startScene: scene.sceneId,
    scenes: [{ id: scene.sceneId, path: 'scenes/test.scene.json' }], prefabs: [], assetRegistry: 'assets/registry.json' };
  const assets = { schemaVersion: 1 as const, assets: [] };
  const project = { manifest, scenes: [scene], prefabs: [], assets };
  assert.doesNotThrow(() => validateProject(project));
  assert.throws(() => validateProject({ ...project, scenes: [] }));
  assert.throws(() => validateProject({ ...project, scenes: [scene, scene] }));
  assert.throws(() => parseProjectManifest({ ...manifest, startScene: 'missing' }));
  assert.throws(() => parseProjectManifest({ ...manifest, assetRegistry: manifest.scenes[0]!.path }));
  assert.throws(() => parseAssetRegistry({ schemaVersion: 1, assets: [
    { id: 'asset_test', name: 'A', kind: 'other', path: 'assets/a' },
    { id: 'asset_test', name: 'B', kind: 'other', path: 'assets/b' },
  ] }));
  parent.id = manifest.projectId;
  scene.entities[1]!.parentId = parent.id;
  assert.throws(() => validateProject(project));
});
