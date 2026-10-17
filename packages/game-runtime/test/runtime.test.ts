import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Application, AmmoPhysicsWorld, Entity, NullGraphicsDevice, Vec3, BoundingBox } from 'playcanvas';
import { createEntity, createScene } from '@forgon/project-schema';
import { createHotelFixture } from '../../test-fixtures/src/index.js';
import { createDiagnostics, createMaterialCache, createSceneRegistry } from '../src/core/projection.js';
import { reconcileScene } from '../src/core/reconcile.js';
import { createEditorCamera } from '../src/core/editor-camera.js';
import { createPlaySession } from '../src/runtime/play-session.js';
import { createGuestMover, stepGuestMover } from '../src/runtime/guest-queue.js';
import { mountGame, validatePlayableScene } from '../src/runtime/index.js';
import type { RuntimeEvent } from '../src/core/types.js';

function headless(physics = false): Application {
  const canvas = { id: 'runtime-test', width: 64, height: 64, style: {}, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
  return new Application(canvas, { devtools: false, graphicsDevice: new NullGraphicsDevice(canvas), ...(physics ? { physicsWorld: new AmmoPhysicsWorld() } : {}) });
}

test('standalone import is Node-safe and validates required semantics before mounting', () => {
  assert.equal(typeof mountGame, 'function');
  assert.equal(typeof document, 'undefined');
  const fixture = createHotelFixture();
  const context = { assets: fixture.assets.assets, prefabs: fixture.prefabs };
  const scene = fixture.scenes[0]!;
  const snapshot = validatePlayableScene(scene, context);
  assert.notEqual(snapshot, scene);
  for (const type of ['script', 'rigidbody', 'unknown']) {
    const copy = structuredClone(scene);
    copy.entities[0]!.components.push({ id: 'unsupported', type, enabled: false, properties: {}, entityRefs: [], assetRefs: [] });
    assert.throws(() => validatePlayableScene(copy, context), /Unsupported/);
  }
  const broken = structuredClone(scene);
  broken.entities.find(e => e.components.some(c => c.type === 'collision'))!.transform.scale[0] = 0;
  assert.throws(() => validatePlayableScene(broken, context), /positive ancestor scales/);
  const unknownProperty = structuredClone(scene);
  unknownProperty.entities.find(e => e.components.some(c => c.type === 'render'))!.components[0]!.properties.model = 'ignored.glb';
  assert.throws(() => validatePlayableScene(unknownProperty, context), /property model/);
  const noCamera = structuredClone(scene);
  noCamera.entities.find(e => e.components.some(c => c.type === 'camera'))!.enabled = false;
  assert.throws(() => validatePlayableScene(noCamera, context), /exactly one enabled camera/);
});

test('reconcile retains engine identity across reordered hierarchies, enabled edits and removed parents', () => {
  const app = headless();
  const root = new Entity('edit'); app.root.addChild(root);
  const registry = createSceneRegistry(); const materials = createMaterialCache();
  const target = { app, root, registry, materials, diagnostics: createDiagnostics() };
  const scene = createScene('Reconcile');
  const parent = createEntity('Parent'); const child = createEntity('Child', parent.id);
  child.components.push({ id: 'render', type: 'render', enabled: true, properties: { primitive: 'box' }, entityRefs: [], assetRefs: [] });
  scene.entities = [child, parent];
  reconcileScene(target, scene);
  const node = registry.byId.get(child.id)!;
  assert.equal(node.parent, registry.byId.get(parent.id));
  assert.equal(node.render!.enabled, true);
  const otherApp = headless();
  const added = createEntity('Added after another viewport');
  added.components = structuredClone(child.components); added.components[0]!.id = 'second-render';
  scene.entities.push(added); reconcileScene(target, scene);
  assert.equal(registry.byId.get(added.id)!.render!.system.app, app);
  scene.entities = [child, parent]; reconcileScene(target, scene); otherApp.destroy();
  child.components[0]!.enabled = false;
  reconcileScene(target, scene);
  assert.equal(node.render!.enabled, false);
  // Reverse an ancestor relation in one valid transaction.
  child.parentId = null; parent.parentId = child.id;
  reconcileScene(target, scene);
  assert.equal(registry.byId.get(parent.id)!.parent, node);
  parent.parentId = null; child.parentId = parent.id;
  reconcileScene(target, scene);
  child.parentId = null; scene.entities = [child];
  reconcileScene(target, scene);
  assert.equal(registry.byId.get(child.id), node);
  assert.equal(node.parent, root);
  assert.equal(node.render!.enabled, false);
  child.components = []; reconcileScene(target, scene);
  assert.equal(node.render, undefined);
  app.destroy(); materials.dispose();
});

test('editor framing uses engine bounds and scene updates retain the navigation camera', () => {
  const app = headless(); const camera = createEditorCamera(app); app.root.addChild(camera.entity);
  const box = new BoundingBox(new Vec3(8, 2, -3), new Vec3(2, 1, 4));
  camera.frameBox(box);
  const position = camera.entity.getPosition().clone();
  assert.ok(position.distance(box.center) > box.halfExtents.length());
  const root = new Entity('world', app); app.root.addChild(root);
  const materials = createMaterialCache();
  reconcileScene({ app, root, registry: createSceneRegistry(), materials, diagnostics: createDiagnostics() }, createScene('Empty'));
  assert.deepEqual(camera.entity.getPosition(), position);
  app.destroy(); materials.dispose();
});

test('guest stepping consumes distance, finishes once, and terminates overlapping looping paths', () => {
  const queue = { waypoints: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], waypointIds: ['a', 'b'], speed: 1, arrivalRadius: 0.1, loop: false };
  const state = createGuestMover(queue, { x: 0, y: 0, z: 0 }); const events: import('../src/runtime/guest-queue.js').GuestStepEvent[] = [];
  stepGuestMover(state, queue, 3, events);
  assert.equal(state.finished, true); assert.ok(Math.abs(state.position.x - 1.9) < 1e-8);
  assert.deepEqual(events.map(e => e.type), ['arrival', 'arrival', 'path-complete']);
  stepGuestMover(state, queue, 3, events); assert.equal(events.length, 3);
  const zero = { ...queue, waypoints: [{ x: 0, y: 0, z: 0 }], waypointIds: ['a'], loop: true };
  const stationary = createGuestMover(zero, { x: 0, y: 0, z: 0 });
  const arrivals: typeof events = []; stepGuestMover(stationary, zero, 1, arrivals);
  assert.equal(arrivals.length, 1);
});

test('actual Ammo boxes raycast, queue movement updates physics and stop restores authoring snapshot', async () => {
  const require = createRequire(import.meta.url);
  // The vendored file is unmodified classic-script/CommonJS upstream code.
  const source = await readFile(new URL('../vendor/ammo.wasm.js', import.meta.url), 'utf8');
  const module = { exports: {} as unknown };
  const factory = new Function('module', 'exports', 'require', '__dirname', source + '\nreturn module.exports;')(module, module.exports, require, new URL('../vendor/', import.meta.url).pathname);
  (globalThis as typeof globalThis & { Ammo: unknown }).Ammo = await factory({ wasmBinary: await readFile(new URL('../vendor/ammo.wasm.wasm', import.meta.url)) });
  const app = headless(true);
  const editRoot = new Entity('Authoring'); app.root.addChild(editRoot);
  const fixture = createHotelFixture(); const scene = fixture.scenes[0]!;
  const original = structuredClone(scene); const events: RuntimeEvent[] = [];
  const session = createPlaySession({ app, editRoot, context: { assets: fixture.assets.assets, prefabs: fixture.prefabs }, onRuntimeEvent: event => events.push(event) });
  session.start(scene);
  assert.equal(session.isPlaying, true); assert.equal(editRoot.enabled, false);
  const floor = app.systems.rigidbody!.raycastFirst(new Vec3(3, 4, 3), new Vec3(3, -3, 3));
  assert.equal(floor?.entity.name, 'Terrazzo floor');
  const guest = app.root.findByName('Guest 1') as Entity;
  assert.equal(guest.rigidbody!.type, 'kinematic');
  const before = guest.getPosition().clone();
  scene.entities.find(e => e.name === 'Queue waypoint 2')!.transform.position = [100, 100, 100];
  session.update(0.5);
  assert.ok(guest.getPosition().distance(before) > 0);
  assert.ok(events.some(e => e.type === 'arrival'));
  assert.ok(events.some(e => e.type === 'vfx'));
  assert.ok(guest.getPosition().x < 10, 'later authoring does not alter the playing path');
  scene.entities.find(e => e.name === 'Queue waypoint 2')!.transform.position = original.entities.find(e => e.name === 'Queue waypoint 2')!.transform.position;
  session.stop();
  assert.equal(editRoot.enabled, true); assert.equal(session.isPlaying, false);
  assert.equal(app.root.findByName('Guest 1'), null);
  assert.deepEqual(scene, original);
  session.dispose(); app.destroy();
});
