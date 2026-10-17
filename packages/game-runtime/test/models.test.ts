import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createEntity, createScene, parseScene, type AssetRecord } from '@forgon/project-schema';
import { createModelCache } from '../src/core/models.js';
import { createDiagnostics, createMaterialCache, createSceneRegistry, disposeGraph, resolveOwnerEntity } from '../src/core/projection.js';
import { projectScene, reconcileScene } from '../src/core/reconcile.js';
import { createPickingSession } from '../src/core/picking.js';
import { createGizmoController } from '../src/core/gizmos.js';
import { validatePlayableScene } from '../src/runtime/validate.js';
import { createPlaySession } from '../src/runtime/play-session.js';

const asset: AssetRecord = { id: 'triangle', name: 'Triangle', kind: 'model', path: 'assets/triangle.glb' };
const context = { assets: [asset] };

/** An entirely embedded GLB triangle; no exporter, files, DOM or network required. */
function tinyGlb(patch: Record<string, unknown> = {}, animated = false): Uint8Array {
  const binary = Buffer.alloc(animated ? 68 : 36);
  [-1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  if (animated) [0, 1, 0, 0, 0, 0, 2, 0].forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  const source = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      ...(animated ? [{ bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] }, { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' }] : [])],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, ...(animated ? [{ buffer: 0, byteOffset: 36, byteLength: 8 }, { buffer: 0, byteOffset: 44, byteLength: 24 }] : [])],
    buffers: [{ byteLength: binary.length }],
    ...(animated ? { animations: [{ name: 'Rise', samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }] } : {}), ...patch });
  const json = Buffer.from(source + ' '.repeat((4 - Buffer.byteLength(source) % 4) % 4));
  const result = Buffer.alloc(28 + json.length + binary.length);
  result.write('glTF'); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + json.length); result.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(result, 28 + json.length);
  return result;
}

function modelScene() {
  const scene = createScene('Model test'); const entity = createEntity('Triangle');
  entity.components.push({ id: 'triangle_model', type: 'model', enabled: true, properties: {}, entityRefs: [], assetRefs: [asset.id] });
  const camera = createEntity('Camera'); camera.transform.position = [0, 0, 5];
  camera.components.push({ id: 'camera_component', type: 'camera', enabled: true, properties: {}, entityRefs: [], assetRefs: [] });
  scene.entities.push(entity, camera);
  return { scene, entity };
}

function meshes(root: Group): Mesh[] {
  const found: Mesh[] = []; root.traverse(node => { if (node instanceof Mesh) found.push(node); }); return found;
}

test('GLTFLoader projects shared meshes beneath entity owners; picking and refreshed selection outlines work', async () => {
  let loads = 0; let changes = 0;
  const models = createModelCache(() => { loads++; return tinyGlb(); }, () => { changes++; gizmos.setSelection([node], [entity.id]); });
  const { scene, entity } = modelScene();
  const second = createEntity('Second triangle'); second.transform.position = [3, 0, 0];
  second.components = [{ ...entity.components[0]!, id: 'second_model' }]; scene.entities.push(second);
  const root = new Group(); const projection = projectScene(root, scene, false, { models });
  const node = projection.registry.byId.get(entity.id)!;
  assert.ok(meshes(node.model!)[0]!.material instanceof MeshBasicMaterial);
  const canvas = { style: {}, ownerDocument: { defaultView: new EventTarget() }, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
  const controlsRoot = new Group(); const camera = new PerspectiveCamera(60, 1, 0.1, 100); camera.position.z = 5;
  const gizmos = createGizmoController(controlsRoot, camera, canvas, () => {});
  gizmos.setSelection([node], [entity.id]);
  await Promise.all([...projection.registry.byId.values()].map(value => value.modelInstance?.ready));
  assert.equal(loads, 1); assert.equal(changes, 2); assert.equal(models.size, 1);
  const mesh = meshes(node.model!)[0]!; const other = meshes(projection.registry.byId.get(second.id)!.model!)[0]!;
  assert.ok(mesh.material instanceof MeshStandardMaterial); assert.equal(mesh.geometry, other.geometry); assert.equal(mesh.material, other.material);
  assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true);
  assert.equal(resolveOwnerEntity(projection.registry, mesh), entity.id);
  assert.deepEqual(models.bounds(asset.id)!.min.toArray(), [-1, -1, 0]);
  const picker = createPickingSession({ clientWidth: 100, clientHeight: 100, width: 100, height: 100 }, root, projection.registry);
  assert.equal(picker.pickAt(camera, 50, 50), entity.id);
  gizmos.update();
  const outlineRoot = controlsRoot.children.find(child => child.children.some(value => value.type === 'LineSegments'))!;
  assert.equal(outlineRoot.children.length, 1);
  assert.ok(outlineRoot.children[0]!.visible);
  assert.equal(projection.diagnostics.faults.length, 0);
  gizmos.destroy(); picker.dispose(); disposeGraph(root); projection.materials.dispose(); models.dispose();
});

test('reconcile retains cached assets until the last user leaves and disposes geometry, material and textures once', async () => {
  let loads = 0;
  const models = createModelCache(() => { loads++; return tinyGlb(); });
  const { scene, entity } = modelScene(); const root = new Group();
  const target = { root, models, registry: createSceneRegistry(), materials: createMaterialCache(), diagnostics: createDiagnostics() };
  reconcileScene(target, scene); const node = target.registry.byId.get(entity.id)!; await node.modelInstance!.ready;
  let geometryDisposals = 0; let materialDisposals = 0; let textureDisposals = 0;
  const mesh = meshes(node.model!)[0]!; const material = mesh.material as MeshStandardMaterial;
  material.map = new Texture(); material.map.addEventListener('dispose', () => textureDisposals++);
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++); material.addEventListener('dispose', () => materialDisposals++);
  entity.components[0]!.properties.castShadows = false; entity.components[0]!.properties.receiveShadows = false;
  reconcileScene(target, scene); await node.modelInstance!.ready;
  assert.equal(loads, 1); assert.equal(meshes(node.model!)[0]!.castShadow, false); assert.equal(meshes(node.model!)[0]!.receiveShadow, false);
  assert.equal(geometryDisposals, 0);
  const second = createEntity('Second'); second.components = [{ ...entity.components[0]!, id: 'second_model' }]; scene.entities.push(second);
  reconcileScene(target, scene); await target.registry.byId.get(second.id)!.modelInstance!.ready;
  entity.components = []; reconcileScene(target, scene);
  assert.equal(node.model, undefined); assert.equal(models.size, 1); assert.equal(geometryDisposals, 0);
  scene.entities = []; reconcileScene(target, scene);
  assert.equal(models.size, 0); assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1); assert.equal(textureDisposals, 1);
  disposeGraph(root); target.materials.dispose(); models.dispose(); assert.equal(geometryDisposals, 1);
});

test('missing, throwing and malformed GLB loads retain a fault placeholder and never reject projection', async () => {
  for (const resolver of [() => null, () => { throw new Error('disk failure'); }, () => new Uint8Array([1, 2, 3]), () => tinyGlb({ meshes: [] })]) {
    const { scene, entity } = modelScene(); const root = new Group(); const reported: string[] = [];
    const models = createModelCache(resolver); const projection = projectScene(root, scene, false, { models, onFault: message => reported.push(message) });
    const node = projection.registry.byId.get(entity.id)!;
    await assert.doesNotReject(node.modelInstance!.ready);
    assert.equal(reported.length, 1); assert.equal(projection.diagnostics.faults.length, 1);
    assert.match(reported[0]!, /Triangle: Model triangle:/); assert.equal(meshes(node.model!).length, 1);
    assert.ok(node.model!.userData.modelFault);
    disposeGraph(root); projection.materials.dispose(); models.dispose();
  }
});

test('cache disposal frees loaded resources once and prevents late attachments or faults', async () => {
  const loaded = createModelCache(() => tinyGlb());
  const instance = loaded.instantiate(asset.id, {}, true, () => assert.fail('unexpected fault')); await instance.ready;
  let disposals = 0; meshes(instance.root)[0]!.geometry.addEventListener('dispose', () => disposals++);
  loaded.dispose(); assert.equal(loaded.size, 0); assert.equal(disposals, 1);
  instance.dispose(); loaded.dispose(); assert.equal(disposals, 1);
  let resolve!: (bytes: Uint8Array) => void;
  const pending = createModelCache(() => new Promise<Uint8Array>(done => { resolve = done; }));
  const late = pending.instantiate(asset.id, {}, true, () => assert.fail('disposed cache emitted a fault'));
  await Promise.resolve(); pending.dispose(); resolve(tinyGlb()); await late.ready;
  assert.equal(meshes(late.root)[0]!.material instanceof MeshBasicMaterial, true, 'no parsed content attaches after disposal');
  late.dispose(); assert.equal(late.root.children.length, 0);
});

test('external resources and decoder requirements report clear faults before parsing or fetching', async t => {
  const parse = t.mock.method(GLTFLoader.prototype, 'parseAsync');
  const cases = [
    { patch: { images: [{ uri: 'https://example.com/image.png' }] }, fault: /resource URLs/ },
    { patch: { extensions: { KHR_draco_mesh_compression: {} } }, fault: /Draco/ },
    { patch: { extensions: { KHR_texture_basisu: {} } }, fault: /KTX2/ },
    { patch: { extensions: { EXT_meshopt_compression: {} } }, fault: /Meshopt/ },
  ];
  for (const { patch, fault } of cases) {
    const models = createModelCache(() => tinyGlb(patch)); const faults: string[] = [];
    const instance = models.instantiate(asset.id, {}, true, message => faults.push(message));
    await instance.ready; assert.match(faults[0]!, fault); instance.dispose(); models.dispose();
  }
  assert.equal(parse.mock.callCount(), 0);
});

test('removing a pending model prevents attachment/faults and disposes the late parsed asset', async t => {
  let resolve!: (bytes: Uint8Array) => void; let frees = 0;
  const parse = GLTFLoader.prototype.parseAsync;
  t.mock.method(GLTFLoader.prototype, 'parseAsync', async function(this: GLTFLoader, data: ArrayBuffer | string, path: string) {
    const gltf = await parse.call(this, data, path);
    meshes(gltf.scene)[0]!.geometry.addEventListener('dispose', () => frees++); return gltf;
  });
  const models = createModelCache(() => new Promise<Uint8Array>(done => { resolve = done; }));
  let faults = 0; const instance = models.instantiate(asset.id, {}, true, () => { faults++; });
  await Promise.resolve(); instance.dispose(); assert.equal(models.size, 0);
  resolve(tinyGlb()); await instance.ready;
  assert.equal(instance.root.children.length, 0); assert.equal(faults, 0); assert.equal(frees, 1); models.dispose();
});

test('model validation accepts one GLB ref and rejects missing, multiple and non-model refs', () => {
  const { scene, entity } = modelScene();
  assert.equal(validatePlayableScene(scene, context).entities[0]!.components[0]!.type, 'model');
  for (const refs of [[], ['missing'], [asset.id, asset.id]]) {
    entity.components[0]!.assetRefs = refs; assert.throws(() => validatePlayableScene(scene, context), /asset|GLB/);
  }
  entity.components[0]!.assetRefs = [asset.id];
  for (const bad of [{ ...asset, kind: 'audio' as const }, { ...asset, path: 'assets/triangle.gltf' }]) {
    assert.throws(() => parseScene(scene, { assets: [bad] }), /GLB model asset/);
  }
  entity.components[0]!.properties.receiveShadows = 'yes'; assert.throws(() => parseScene(scene, context), /boolean/);
  entity.components[0]!.properties = { path: 'arbitrary.glb' }; assert.throws(() => validatePlayableScene(scene, context), /property path/);
});

test('Play uses the same GLB projection, emits missing-byte faults and releases models on Stop', async () => {
  const require = createRequire(import.meta.url);
  const source = await readFile(new URL('../vendor/ammo.wasm.js', import.meta.url), 'utf8');
  const module = { exports: {} as unknown };
  const factory = new Function('module', 'exports', 'require', '__dirname', source + '\nreturn module.exports;')(module, module.exports, require, new URL('../vendor/', import.meta.url).pathname);
  (globalThis as typeof globalThis & { Ammo: unknown }).Ammo = await factory({ wasmBinary: await readFile(new URL('../vendor/ammo.wasm.wasm', import.meta.url)) });
  for (const missing of [false, true]) {
    const { scene, entity } = modelScene(); const world = new Group(); const editRoot = new Group(); world.add(editRoot);
    entity.components[0]!.properties = { animation: 'Rise', loop: true };
    const faults: string[] = []; const models = createModelCache(() => missing ? null : tinyGlb({}, true));
    const session = createPlaySession({ world, editRoot, models, context, onRuntimeEvent: event => { if (event.type === 'fault') faults.push(event.message); } });
    session.start(scene);
    const playRoot = world.children.find(value => value.name === 'Forgon Play Snapshot')!;
    const node = playRoot.children.find(value => value.name === entity.name)! as import('../src/core/projection.js').SceneNode;
    await node.modelInstance!.ready;
    assert.equal(faults.length, missing ? 1 : 0);
    if (!missing) {
      const mesh = meshes(node.model!)[0]!; assert.ok(mesh.material instanceof MeshStandardMaterial);
      session.update(0.25); assert.equal(mesh.position.y, 0.5);
      session.setPaused(true); session.update(0.25); assert.equal(mesh.position.y, 0.5);
      session.setPaused(false); session.update(0.25); assert.equal(mesh.position.y, 1);
      assert.deepEqual(entity.transform.position, [0, 0, 0]);
    }
    session.stop(); assert.equal(models.size, 0); assert.equal(editRoot.visible, true); session.dispose(); models.dispose();
  }
});

test('named GLB clips animate independent Play instances, leave Edit in bind pose, and release mixers', async () => {
  const faults: string[] = []; const models = createModelCache(() => tinyGlb({}, true));
  const edit = models.instantiate(asset.id, { animation: 'Rise', loop: true }, true, message => faults.push(message));
  const loop = models.instantiate(asset.id, { animation: 'Rise', loop: true }, true, message => faults.push(message), true);
  const once = models.instantiate(asset.id, { animation: 'Rise' }, true, message => faults.push(message), true);
  const missing = models.instantiate(asset.id, { animation: 'Missing' }, true, message => faults.push(message), true);
  await Promise.all([edit.ready, loop.ready, once.ready, missing.ready]);
  const editMesh = meshes(edit.root)[0]!; const loopMesh = meshes(loop.root)[0]!; const onceMesh = meshes(once.root)[0]!;
  models.update(0.25);
  assert.equal(editMesh.position.y, 0); assert.equal(loopMesh.position.y, 0.5); assert.equal(onceMesh.position.y, 0.5);
  models.update(1);
  assert.equal(loopMesh.position.y, 0.5); assert.equal(onceMesh.position.y, 2);
  assert.match(faults[0]!, /Animation clip "Missing" was not found/); assert.equal(meshes(missing.root).length, 1);
  edit.dispose(); loop.dispose(); once.dispose(); missing.dispose(); assert.equal(models.size, 0);
  const stopped = loopMesh.position.y; models.update(1); assert.equal(loopMesh.position.y, stopped); models.dispose();
});
