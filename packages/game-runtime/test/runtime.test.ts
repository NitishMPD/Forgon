import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Box3, Euler, Group, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { SceneNode, disposeGraph, resolveOwnerEntity, rotationDegrees } from '../src/core/projection.js';
import { projectScene } from '../src/core/reconcile.js';
import { createPickingSession } from '../src/core/picking.js';
import { applySelectionDelta, captureSelection, createGizmoController, readTransform } from '../src/core/gizmos.js';
import { createEntity, createScene } from '@forgon/project-schema';
import { createHotelFixture, createSectorFixture } from '../../test-fixtures/src/index.js';
import { createDiagnostics, createMaterialCache, createSceneRegistry } from '../src/core/projection.js';
import { reconcileScene } from '../src/core/reconcile.js';
import { createEditorCamera } from '../src/core/editor-camera.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createPhysicsWorld } from '../src/runtime/physics.js';
import { createPlaySession } from '../src/runtime/play-session.js';
import { createGuestMover, stepGuestMover } from '../src/runtime/guest-queue.js';
import { createInputState } from '../src/runtime/parkour.js';
import { mountGame, validatePlayableScene } from '../src/runtime/index.js';
import type { RuntimeEvent } from '../src/core/types.js';

function headless() { return new Group(); }
const canvas = { width: 64, height: 64, clientWidth: 64, clientHeight: 64, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
/** Loads the vendored classic-script Ammo build so play sessions get a real physics world. */
async function bootAmmo(): Promise<void> {
  const require = createRequire(import.meta.url);
  // The vendored file is unmodified classic-script/CommonJS upstream code.
  const source = await readFile(new URL('../vendor/ammo.wasm.js', import.meta.url), 'utf8');
  const module = { exports: {} as unknown };
  const factory = new Function('module', 'exports', 'require', '__dirname', source + '\nreturn module.exports;')(module, module.exports, require, new URL('../vendor/', import.meta.url).pathname);
  (globalThis as typeof globalThis & { Ammo: unknown }).Ammo = await factory({ wasmBinary: await readFile(new URL('../vendor/ammo.wasm.wasm', import.meta.url)) });
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
    copy.entities[0]!.components.push({ id: 'unsupported', type, enabled: false, properties: type === 'script' ? { src: 'scripts/unsupported.ts', params: {} } : {}, entityRefs: [], assetRefs: [] });
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
  const root = new Group(); app.add(root);
  const registry = createSceneRegistry(); const materials = createMaterialCache();
  const target = { root, registry, materials, diagnostics: createDiagnostics() };
  const scene = createScene('Reconcile');
  const parent = createEntity('Parent'); const child = createEntity('Child', parent.id);
  child.components.push({ id: 'render', type: 'render', enabled: true, properties: { primitive: 'box' }, entityRefs: [], assetRefs: [] });
  scene.entities = [child, parent];
  reconcileScene(target, scene);
  const node = registry.byId.get(child.id)!;
  assert.equal(node.parent, registry.byId.get(parent.id));
  assert.equal(node.render!.visible, true);
  const otherApp = headless();
  const added = createEntity('Added after another viewport');
  added.components = structuredClone(child.components); added.components[0]!.id = 'second-render';
  scene.entities.push(added); reconcileScene(target, scene);
  assert.equal(registry.byId.get(added.id)!.parent, root);
  scene.entities = [child, parent]; reconcileScene(target, scene); disposeGraph(otherApp);
  child.components[0]!.enabled = false;
  reconcileScene(target, scene);
  assert.equal(node.render!.visible, false);
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
  assert.equal(node.render!.visible, false);
  child.components = []; reconcileScene(target, scene);
  assert.equal(node.render, undefined);
  disposeGraph(app); materials.dispose();
});

test('editor framing uses engine bounds and scene updates retain the navigation camera', () => {
  const app = headless(); const camera = createEditorCamera(canvas); app.add(camera.entity);
  const box = new Box3().setFromCenterAndSize(new Vector3(8, 2, -3), new Vector3(4, 2, 8));
  camera.frameBox(box);
  const position = camera.entity.position.clone();
  assert.ok(position.distanceTo(box.getCenter(new Vector3())) > box.getSize(new Vector3()).length() / 2);
  const root = new Group(); app.add(root);
  const materials = createMaterialCache();
  reconcileScene({ root, registry: createSceneRegistry(), materials, diagnostics: createDiagnostics() }, createScene('Empty'));
  assert.deepEqual(camera.entity.position, position);
  disposeGraph(app); materials.dispose();
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
  await bootAmmo();
  const app = headless();
  const editRoot = new Group(); app.add(editRoot);
  const fixture = createHotelFixture(); const scene = fixture.scenes[0]!;
  const original = structuredClone(scene); const events: RuntimeEvent[] = [];
  const session = createPlaySession({ world: app, editRoot, context: { assets: fixture.assets.assets, prefabs: fixture.prefabs }, onRuntimeEvent: event => events.push(event) });
  session.start(scene);
  assert.equal(session.isPlaying, true); assert.equal(editRoot.visible, false);
  const floor = session.getPhysics()!.raycastFirst(new Vector3(3, 4, 3), new Vector3(3, -3, 3));
  assert.equal(floor?.entity.name, 'Terrazzo floor');
  const guest = app.getObjectByName('Guest 1') as SceneNode;
  assert.equal(guest.collision!.kinematic, true);
  const before = guest.getWorldPosition(new Vector3()).clone();
  scene.entities.find(e => e.name === 'Queue waypoint 2')!.transform.position = [100, 100, 100];
  session.update(0.5);
  assert.ok(guest.getWorldPosition(new Vector3()).distanceTo(before) > 0);
  assert.ok(events.some(e => e.type === 'arrival'));
  assert.ok(events.some(e => e.type === 'vfx'));
  assert.ok(guest.getWorldPosition(new Vector3()).x < 10, 'later authoring does not alter the playing path');
  scene.entities.find(e => e.name === 'Queue waypoint 2')!.transform.position = original.entities.find(e => e.name === 'Queue waypoint 2')!.transform.position;
  session.stop();
  assert.equal(editRoot.visible, true); assert.equal(session.isPlaying, false);
  assert.equal(app.getObjectByName('Guest 1'), undefined);
  assert.deepEqual(scene, original);
  session.dispose(); disposeGraph(app);
});

test('the Sector parkour session drives the rig, the lifts and the chase camera from authored input', async () => {
  await bootAmmo();
  const app = headless();
  const editRoot = new Group(); app.add(editRoot);
  const fixture = createSectorFixture(); const scene = fixture.scenes[0]!;
  const events: RuntimeEvent[] = [];
  const session = createPlaySession({
    world: app, editRoot, context: { assets: fixture.assets.assets, prefabs: fixture.prefabs },
    // Held forward + sprint: the runner takes the opening gaps and the camera chases.
    input: { sample: () => ({ state: { ...createInputState(), moveZ: 1, sprint: true }, yaw: 0, pitch: 0.16, manual: false, restart: false }) },
    onRuntimeEvent: event => events.push(event),
  });
  session.start(scene);
  assert.equal(session.isPlaying, true);
  const hud = session.getHud()!;
  assert.equal(hud.checkpointTotal, 4, 'the four relay gates are registered');
  assert.equal(hud.total, 8, 'eight shards are registered');
  const runner = app.getObjectByName('Runner') as SceneNode;
  assert.ok(runner, 'the runner root is projected from the authored player');
  const start = runner.getWorldPosition(new Vector3()).clone();
  const ferry = app.getObjectByName('Relay lift ferry') as SceneNode;
  const ferryStart = ferry.getWorldPosition(new Vector3()).clone();
  for (let i = 0; i < 600; i++) session.update(1 / 60);
  assert.ok(runner.getWorldPosition(new Vector3()).distanceTo(start) > 5, 'the rig follows the simulated runner through the course');
  assert.ok(ferry.getWorldPosition(new Vector3()).distanceTo(ferryStart) > 0.5, 'the relay ferry is a real moving platform');
  const finalHud = session.getHud()!;
  assert.ok(finalHud.time > 0 && finalHud.speed >= 0, 'the HUD tracks the run');
  assert.ok(app.getObjectByName('Sentinel switchback'), 'hazard prefab instances are projected');
  session.stop();
  assert.equal(session.isPlaying, false);
  assert.equal(app.getObjectByName('Runner'), undefined);
  session.dispose(); disposeGraph(app);
});

test('a parkour session honours input attached mid-run, so an editor can wire controls at Play', async () => {
  await bootAmmo();
  const app = headless();
  const editRoot = new Group(); app.add(editRoot);
  const fixture = createSectorFixture(); const scene = fixture.scenes[0]!;
  // The editor viewport holds a live reference and attaches the browser controls when Play starts.
  const deps = {
    world: app, editRoot, context: { assets: fixture.assets.assets, prefabs: fixture.prefabs },
    input: undefined as undefined | { sample(): { state: ReturnType<typeof createInputState>; yaw: number; pitch: number; manual: boolean; restart: boolean } },
    onRuntimeEvent: () => undefined,
  };
  const session = createPlaySession(deps);
  session.start(scene);
  const runner = app.getObjectByName('Runner') as SceneNode;
  const start = runner.getWorldPosition(new Vector3()).clone();
  for (let i = 0; i < 120; i++) session.update(1 / 60);
  assert.ok(runner.getWorldPosition(new Vector3()).distanceTo(start) < 1, 'no input leaves the runner at the spawn while it settles');
  deps.input = { sample: () => ({ state: { ...createInputState(), moveZ: 1, sprint: true }, yaw: 0, pitch: 0.16, manual: false, restart: false }) };
  for (let i = 0; i < 240; i++) session.update(1 / 60);
  assert.ok(runner.getWorldPosition(new Vector3()).distanceTo(start) > 3, 'input attached after start drives the run');
  session.dispose(); disposeGraph(app);
});


test('projection retains primitive dimensions, composed degree rotations, hierarchy and shared resource ownership', () => {
  const scene = createScene('Primitives');
  const parent = createEntity('Parent'); parent.transform.position = [2, 3, 4];
  parent.transform.rotationEuler = [27, 43, -19];
  const primitives = ['box', 'sphere', 'cylinder', 'plane', 'cone', 'capsule', 'torus'];
  scene.entities = [parent, ...primitives.map(primitive => {
    const child = createEntity(primitive, parent.id);
    child.transform.position = [1, 2, 3];
    child.components = [{ id: primitive, type: 'render', enabled: true, properties: { primitive, color: [1, 0.5, 0.2] }, entityRefs: [], assetRefs: [] }];
    return child;
  })];
  const root = new Group();
  const projection = projectScene(root, scene, false);
  const parentNode = projection.registry.byId.get(parent.id)!;
  const [x, y, z] = parent.transform.rotationEuler.map(degree => degree * Math.PI / 360) as [number, number, number];
  const sx = Math.sin(x), sy = Math.sin(y), sz = Math.sin(z), cx = Math.cos(x), cy = Math.cos(y), cz = Math.cos(z);
  const legacy = new Quaternion(sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz);
  assert.ok(parentNode.quaternion.angleTo(legacy) < 1e-7);
  const first = projection.registry.byId.get(scene.entities[1]!.id)!;
  const expected = new Vector3(1, 2, 3).applyQuaternion(legacy).add(new Vector3(2, 3, 4));
  assert.ok(first.getWorldPosition(new Vector3()).distanceTo(expected) < 1e-7);
  const sizes = [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 0, 1], [1, 1, 1], [1, 2, 1], [1, 0.4, 1]];
  for (const [index, definition] of scene.entities.slice(1).entries()) {
    const node = projection.registry.byId.get(definition.id)!;
    const mesh = node.render!; mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox!.getSize(new Vector3());
    size.toArray().forEach((value, axis) => assert.ok(Math.abs(value - sizes[index]![axis]!) < 1e-6, definition.name));
    assert.equal(mesh.material, first.render!.material);
    assert.equal(mesh.receiveShadow, true); assert.equal(mesh.castShadow, true);
    assert.equal(resolveOwnerEntity(projection.registry, mesh), definition.id);
  }
  let disposed = 0;
  first.render!.geometry.addEventListener('dispose', () => disposed++);
  disposeGraph(root); assert.equal(disposed, 0, 'geometry belongs to projection cache');
  projection.materials.dispose(); assert.equal(disposed, 1);
});

test('reconcile skips dragged transforms and cleans up removed projected components', () => {
  const root = new Group(); const scene = createScene('Drag'); const definition = createEntity('Box');
  definition.components = [{ id: 'render', type: 'render', enabled: true, properties: {}, entityRefs: [], assetRefs: [] }];
  scene.entities = [definition];
  const projection = projectScene(root, scene, false);
  const node = projection.registry.byId.get(definition.id)!;
  node.position.set(9, 8, 7); definition.name = 'Renamed'; definition.enabled = false;
  reconcileScene({ root, ...projection, draggingIds: new Set([definition.id]) }, scene);
  assert.deepEqual(node.position.toArray(), [9, 8, 7]); assert.equal(node.name, 'Renamed'); assert.equal(node.visible, false);
  definition.components = [];
  reconcileScene({ root, ...projection }, scene);
  assert.equal(node.render, undefined); assert.deepEqual(node.position.toArray(), definition.transform.position);
  disposeGraph(root); projection.materials.dispose();
});

test('multi-selection pivot deltas preserve parent/child local transforms and schema degrees', () => {
  const root = new Group(); const parent = new SceneNode(); const child = new SceneNode(); const peer = new SceneNode();
  root.add(parent, peer); parent.add(child); parent.position.set(2, 0, 0); child.position.set(1, 0, 0); peer.position.set(-2, 0, 0);
  const selection = captureSelection([child, parent, peer]);
  const delta = new Matrix4().compose(new Vector3(3, 2, 1), new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)), new Vector3(2, 2, 2));
  applySelectionDelta(selection, delta); root.updateMatrixWorld(true);
  for (const original of selection) {
    const expected = delta.clone().multiply(original.world);
    original.entity.matrixWorld.elements.forEach((value, index) => assert.ok(Math.abs(value - expected.elements[index]!) < 1e-7));
  }
  assert.deepEqual(readTransform(child).position, [1, 0, 0]);
  assert.ok(Math.abs(rotationDegrees(peer).y - 90) < 1e-6);
});

test('ray picking resolves owners and excludes hidden hierarchies and helpers outside the world root', () => {
  const root = new Group(); const scene = createScene('Pick'); const box = createEntity('Box');
  box.components = [{ id: 'box', type: 'render', enabled: true, properties: {}, entityRefs: [], assetRefs: [] }]; scene.entities = [box];
  const projection = projectScene(root, scene, false);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100); camera.position.z = 5; camera.lookAt(0, 0, 0);
  const picker = createPickingSession(canvas, root, projection.registry);
  assert.equal(picker.pickAt(camera, 32, 32), box.id);
  root.visible = false; assert.equal(picker.pickAt(camera, 32, 32), null);
  root.visible = true; projection.registry.byId.get(box.id)!.render!.visible = false;
  assert.equal(picker.pickAt(camera, 32, 32), null);
  picker.dispose(); disposeGraph(root); projection.materials.dispose();
});


test('Ammo synchronizes scaled rotated kinematic boxes and releases its independent world', async () => {
  await bootAmmo();
  const root = new Group(); const parent = new Group(); parent.position.x = 3; root.add(parent);
  const box = new SceneNode(); parent.add(box); box.position.set(1, 1, 0); box.rotation.y = Math.PI / 2; box.scale.set(2, 1, 1);
  box.collision = { halfExtents: new Vector3(0.2, 0.5, 0.2), enabled: true, isTrigger: false, kinematic: true };
  const physics = createPhysicsWorld(root);
  const ray = (x: number) => physics.raycastFirst(new Vector3(x, 4, 0), new Vector3(x, -4, 0));
  assert.equal(ray(4)?.entity, box);
  assert.equal(ray(4.3), null, 'box rotation and scale are applied in world space');
  box.position.x = 4; physics.sync();
  assert.equal(ray(4), null, 'old broadphase bounds are removed'); assert.equal(ray(7)?.entity, box);
  physics.dispose(); physics.dispose(); disposeGraph(root);
});

test('TransformControls commits multi-selection only at gesture end and honours space and lock', () => {
  const root = new Group(); const a = new SceneNode(); const b = new SceneNode(); root.add(a, b); b.position.x = 2;
  const camera = new PerspectiveCamera(); camera.position.z = 5;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const element = { style: {}, addEventListener(_type: string, listener: EventListenerOrEventListenerObject) { listeners.add(listener); },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) { listeners.delete(listener); } } as unknown as HTMLCanvasElement;
  const pending: string[] = []; const batches: string[][] = [];
  const controller = createGizmoController(root, camera, element, id => pending.push(id), {
    start() { pending.length = 0; }, end() { if (pending.length) batches.push([...pending]); },
  });
  const helper = root.children.find(node => 'controls' in node)!;
  assert.ok('controls' in helper && helper.controls instanceof TransformControls);
  const controls = helper.controls;
  controller.setSelection([a, b], ['a', 'b']); controller.setActiveTool('translate'); controller.setSpace('local');
  assert.equal(controls.space, 'local'); controller.setSpace('world'); assert.equal(controls.space, 'world');
  controls.dispatchEvent({ type: 'mouseDown', mode: 'translate' });
  assert.equal(controller.isGestureActive, true);
  controls.object!.position.y += 3; controls.dispatchEvent({ type: 'objectChange' });
  assert.deepEqual(batches, []); assert.equal(a.position.y, 3); assert.equal(b.position.y, 3);
  controls.dispatchEvent({ type: 'mouseUp', mode: 'translate' });
  assert.deepEqual(batches, [['a', 'b']]); assert.equal(controller.isGestureActive, false); assert.ok(controller.lastGestureEndedAt > 0);
  controls.dispatchEvent({ type: 'mouseDown', mode: 'translate' }); controls.dispatchEvent({ type: 'mouseUp', mode: 'translate' });
  assert.equal(batches.length, 1, 'no-op gestures do not commit');
  controller.setLocked(true); assert.equal(controls.enabled, false); assert.equal(controls.object, undefined);
  controller.setLocked(false); assert.equal(controls.enabled, true); assert.ok(controls.object);
  controller.destroy(); assert.equal(listeners.size, 0); assert.equal(root.children.length, 2);
});

test('camera keyboard navigation, locking and listener lifecycle remain available without a renderer', () => {
  const listeners = new Map<string, EventListener>();
  const element = { clientHeight: 600, addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); },
    removeEventListener(type: string) { listeners.delete(type); } } as unknown as HTMLCanvasElement;
  const camera = createEditorCamera(element); camera.attach();
  const key = (value: string, shiftKey = false) => listeners.get('keydown')!(Object.assign(new Event('keydown'), { key: value, shiftKey }));
  const initial = camera.entity.position.clone();
  key('ArrowRight'); assert.ok(camera.entity.position.distanceTo(initial) > 0.1);
  const orbited = camera.entity.position.clone(); key('ArrowUp', true); assert.ok(camera.entity.position.distanceTo(orbited) > 0.1);
  key('Home'); assert.ok(camera.entity.position.distanceTo(initial) < 1e-7);
  key('+'); assert.ok(camera.entity.position.distanceTo(initial) > 0.1);
  camera.setLocked(true); const locked = camera.entity.position.clone(); key('ArrowLeft'); key('-'); key('Home');
  assert.deepEqual(camera.entity.position, locked);
  camera.detach(); camera.detach(); assert.equal(listeners.size, 0);
});

test('checked-in hotel and Sector scenes match the headless fixture snapshots', async () => {
  for (const [directory, fixture] of [['hotel-vertical-slice', createHotelFixture()], ['sector', createSectorFixture()]] as const) {
    const scene = JSON.parse(await readFile(new URL(`../../../examples/${directory}/scenes/main.scene.json`, import.meta.url), 'utf8'));
    assert.deepEqual(validatePlayableScene(scene, { assets: fixture.assets.assets, prefabs: fixture.prefabs }), fixture.scenes[0]);
  }
});
