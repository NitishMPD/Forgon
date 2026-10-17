import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, PerspectiveCamera, Vector3 } from 'three';
import { createEntity, createScene } from '@forgon/project-schema';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createGizmoController } from '../src/core/gizmos.js';
import { createGridEntity, setGridStep } from '../src/core/grid.js';
import { createPickingSession } from '../src/core/picking.js';
import { createDiagnostics, createMaterialCache, createSceneRegistry, disposeGraph } from '../src/core/projection.js';
import { reconcileScene } from '../src/core/reconcile.js';

test('snap steps reach TransformControls; Ctrl inverts, blur resets and disposal removes listeners', () => {
  const root = new Group();
  const window = new EventTarget();
  const listeners = new Map<string, EventListener>();
  const canvas = { style: {}, ownerDocument: { defaultView: window },
    addEventListener(type: string, listener: EventListener, capture = false) { listeners.set(`${type}:${capture}`, listener); },
    removeEventListener(type: string, _listener: EventListener, capture = false) { listeners.delete(`${type}:${capture}`); },
  } as unknown as HTMLCanvasElement;
  const controller = createGizmoController(root, new PerspectiveCamera(), canvas, () => {});
  const helper = root.children.find(child => 'controls' in child)!;
  assert.ok('controls' in helper && helper.controls instanceof TransformControls);
  const controls = helper.controls;
  const snap = { enabled: true, translate: 0.25, rotateDeg: 45, scale: 0.25 };
  controller.setSnap(snap);
  assert.equal(controls.translationSnap, 0.25);
  assert.equal(controls.rotationSnap, Math.PI / 4);
  assert.equal(controls.scaleSnap, 0.25);
  const modifier = (type: string, ctrlKey: boolean) => Object.assign(new Event(type), { ctrlKey });
  listeners.get('pointerdown:true')!(modifier('pointerdown', true));
  assert.equal(controls.translationSnap, null);
  window.dispatchEvent(modifier('keyup', false));
  assert.equal(controls.translationSnap, 0.25);
  controller.setSnap({ ...snap, enabled: false });
  assert.equal(controls.rotationSnap, null);
  window.dispatchEvent(modifier('keydown', true));
  assert.equal(controls.rotationSnap, Math.PI / 4);
  window.dispatchEvent(new Event('blur'));
  assert.equal(controls.rotationSnap, null);
  assert.throws(() => controller.setSnap({ ...snap, scale: NaN }), /positive/);
  controller.destroy();
  assert.equal(listeners.size, 0);
  window.dispatchEvent(modifier('keydown', true));
  assert.equal(controls.rotationSnap, null);
});

test('visible grid divisions match translation snap steps and replacement releases old geometry', () => {
  const grid = createGridEntity();
  for (const step of [0.25, 0.5, 1, 2]) {
    let disposed = false;
    grid.geometry.addEventListener('dispose', () => { disposed = true; });
    setGridStep(grid, step);
    assert.equal(disposed, true);
    const positions = grid.geometry.getAttribute('position');
    assert.equal(positions.count, (40 / step + 1) * 4);
    assert.equal(positions.getZ(4) - positions.getZ(0), step);
  }
  assert.throws(() => setGridStep(grid, 0), /at least/);
  grid.geometry.dispose(); grid.material.dispose();
});

test('placement queries hit scene geometry, return world normals and fall back to the ground', () => {
  const root = new Group(); const registry = createSceneRegistry(); const materials = createMaterialCache();
  const scene = createScene('Test'); const entity = createEntity('Surface');
  entity.transform.position = [0, 1, 0]; entity.transform.scale = [2, 2, 2];
  entity.components.push({ id: 'surface_render', type: 'render', enabled: true, properties: { primitive: 'box' }, entityRefs: [], assetRefs: [] });
  scene.entities.push(entity);
  const target = { root, registry, materials, diagnostics: createDiagnostics() };
  reconcileScene(target, scene);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 6, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0);
  const canvas = { clientWidth: 100, clientHeight: 100, width: 200, height: 200 };
  const picker = createPickingSession(canvas, root, registry);
  const box = picker.surfaceAt(camera, 50, 50)!;
  assert.ok(new Vector3(...box.position).distanceTo(new Vector3(0, 2, 0)) < 1e-6);
  assert.deepEqual(box.normal, [0, 1, 0]);
  entity.components[0]!.properties.primitive = 'plane';
  entity.transform.rotationEuler = [0, 0, 30]; entity.transform.scale = [2, 1, 3];
  reconcileScene(target, scene);
  const slope = picker.surfaceAt(camera, 50, 50)!;
  assert.ok(new Vector3(...slope.position).distanceTo(new Vector3(0, 1, 0)) < 1e-6);
  assert.ok(new Vector3(...slope.normal).distanceTo(new Vector3(-0.5, Math.sqrt(3) / 2, 0)) < 1e-6);
  entity.enabled = false; reconcileScene(target, scene);
  const ground = picker.surfaceAt(camera, 50, 50)!;
  assert.ok(Math.abs(ground.position[1]) < 1e-6); assert.deepEqual(ground.normal, [0, 1, 0]);
  assert.equal(picker.surfaceAt(camera, -1, 50), null);
  assert.equal(picker.surfaceAt(camera, NaN, 50), null);
  camera.up.set(0, 1, 0); camera.lookAt(0, 6, 10);
  assert.equal(picker.surfaceAt(camera, 50, 50), null, 'a ray parallel to the ground has no placement');
  picker.dispose(); disposeGraph(root); materials.dispose();
});
