import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { createEditorCamera } from '../src/core/editor-camera.js';
import { createProgressiveDesign } from '../src/core/progressive-design.js';

const canvas = { clientHeight: 900 } as HTMLCanvasElement;
const bounds = new Box3(new Vector3(-10, 0, -20), new Vector3(10, 15, 20));

test('turntable runs only during work and yields until a different prompt starts', () => {
  const camera = createEditorCamera(canvas);
  const progressive = createProgressiveDesign(camera);
  progressive.setPrompt('prompt-1', true);
  progressive.update(0, bounds, false);
  const start = camera.camera.position.clone();
  progressive.update(0.1, bounds, false);
  assert.ok(camera.camera.position.distanceTo(start) > 0);
  progressive.interrupt();
  const stopped = camera.camera.position.clone();
  for (const enabled of [true, false, true]) {
    progressive.setPrompt('prompt-1', enabled);
    progressive.update(0.1, bounds.clone().expandByScalar(100), false);
    assert.deepEqual(camera.camera.position, stopped, 'updates and toggling cannot resume an interrupted prompt');
  }
  progressive.setPrompt('prompt-2', true);
  progressive.update(0.1, bounds, false);
  assert.ok(camera.camera.position.distanceTo(stopped) > 0);
  progressive.setPrompt('prompt-2', false);
  const idle = camera.camera.position.clone();
  progressive.update(0.1, bounds, false);
  assert.deepEqual(camera.camera.position, idle);
  progressive.setPrompt(null, true);
  assert.equal(progressive.isActive, false);
});

function assertFits(camera: ReturnType<typeof createEditorCamera>, box: Box3): void {
  camera.camera.updateMatrixWorld();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const point = new Vector3(x, y, z).project(camera.camera);
    assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1, `clipped corner ${point.toArray()}`);
  }
}

test('all corners stay framed through rotation, expanding bounds, large scenes and resize', () => {
  const camera = createEditorCamera(canvas);
  const progressive = createProgressiveDesign(camera);
  progressive.setPrompt('prompt', true);
  for (const box of [bounds, bounds.clone().expandByScalar(2000)]) {
    for (const aspect of [2, 0.4]) {
      camera.camera.aspect = aspect;
      for (let index = 0; index < 1000; index++) {
        progressive.update(0.1, box, false);
        assertFits(camera, box);
      }
    }
  }
});

test('reduced motion keeps progressive framing without orbiting; empty scenes are safe', () => {
  const camera = createEditorCamera(canvas);
  const progressive = createProgressiveDesign(camera);
  progressive.setPrompt('prompt', true);
  const initial = camera.camera.position.clone();
  progressive.update(0.1, null, false);
  progressive.update(0.1, new Box3(), false);
  assert.deepEqual(camera.camera.position, initial);
  progressive.update(0.1, bounds, true);
  const framed = camera.camera.position.clone();
  progressive.update(0.1, bounds, true);
  assert.deepEqual(camera.camera.position, framed);
  const expanded = bounds.clone().expandByScalar(30);
  progressive.update(0.1, expanded, true);
  assertFits(camera, expanded);
  assert.ok(camera.camera.position.distanceTo(framed) > 0);
});

test('manual zoom after framing a large scene continues smoothly from the framed distance', () => {
  const camera = createEditorCamera(canvas);
  const box = bounds.clone().expandByScalar(2000);
  const center = box.getCenter(new Vector3());
  camera.frameBox(box);
  const before = camera.camera.position.distanceTo(center);
  camera.zoom(0.9);
  assert.ok(Math.abs(camera.camera.position.distanceTo(center) / before - 0.9) < 1e-8);
});
