import { EdgesGeometry, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Transform } from '@forgon/project-schema';
import type { SnapSettings, ViewportTool } from './types.js';
import { isVisible, rotationDegrees } from './projection.js';

export interface GizmoController {
  setActiveTool(tool: ViewportTool): void;
  setSpace(space: 'local' | 'world'): void;
  setSnap(snap: SnapSettings): void;
  setSelection(entities: readonly Object3D[], ids: readonly string[]): void;
  setGestureHandler(handler: ((entityId: string, transform: Transform) => void) | null): void;
  setLocked(locked: boolean): void;
  readonly isGestureActive: boolean;
  readonly lastGestureEndedAt: number;
  update(): void;
  destroy(): void;
}
export function readTransform(entity: Object3D): Transform {
  return {
    position: entity.position.toArray(),
    rotationEuler: rotationDegrees(entity).toArray(),
    scale: entity.scale.toArray(),
  };
}
export function captureSelection(entities: readonly Object3D[]) {
  const selected = new Set(entities);
  return entities.map(entity => {
    entity.updateWorldMatrix(true, false);
    let parentMoves = false;
    for (let parent = entity.parent; parent; parent = parent.parent) if (selected.has(parent)) parentMoves = true;
    return { entity, world: entity.matrixWorld.clone(), parent: entity.parent?.matrixWorld.clone() ?? new Matrix4(), parentMoves };
  });
}
/** Apply one world-space pivot delta, including selections that contain both parent and child. */
export function applySelectionDelta(selection: ReturnType<typeof captureSelection>, delta: Matrix4): void {
  for (const item of selection) {
    const parent = item.parentMoves ? delta.clone().multiply(item.parent) : item.parent;
    const local = parent.clone().invert().multiply(delta).multiply(item.world);
    local.decompose(item.entity.position, item.entity.quaternion, item.entity.scale);
    item.entity.updateMatrix();
  }
}
export function createGizmoController(
  root: Object3D,
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  onTransformCommit: (entityId: string, transform: Transform) => void,
  gestures?: { start(): void; end(): void },
): GizmoController {
  const controls = new TransformControls(camera, canvas);
  const helper = controls.getHelper();
  const pivot = new Group();
  const outlines = new Group();
  const outlineMaterial = new LineBasicMaterial({ color: 0xf5aa62, depthTest: true, toneMapped: false });
  root.add(pivot, helper, outlines);
  let links: { source: Mesh; outline: LineSegments }[] = [];
  let entities: readonly Object3D[] = [];
  let ids: readonly string[] = [];
  let tool: ViewportTool = 'select';
  let locked = false;
  let active = false;
  let snap: SnapSettings = { enabled: false, translate: 0.5, rotateDeg: 15, scale: 0.1 };
  let ctrl = false;
  const applySnap = (): void => {
    const enabled = snap.enabled !== ctrl;
    controls.setTranslationSnap(enabled ? snap.translate : null);
    controls.setRotationSnap(enabled ? snap.rotateDeg * Math.PI / 180 : null);
    controls.setScaleSnap(enabled ? snap.scale : null);
  };
  const modifier = (event: KeyboardEvent | PointerEvent): void => { ctrl = event.ctrlKey; applySnap(); };
  const clearModifier = (): void => { ctrl = false; applySnap(); };
  const window = canvas.ownerDocument?.defaultView;
  canvas.addEventListener('pointerdown', modifier, true);
  window?.addEventListener('keydown', modifier);
  window?.addEventListener('keyup', modifier);
  window?.addEventListener('blur', clearModifier);
  let ended = 0;
  let handler: ((entityId: string, transform: Transform) => void) | null = onTransformCommit;
  let selection: ReturnType<typeof captureSelection> = [];
  let gestureIds: readonly string[] = [];
  let before: string[] = [];
  let pivotStart = new Matrix4();
  const resetPivot = (): void => {
    if (active) return;
    pivot.position.set(0, 0, 0);
    for (const entity of entities) pivot.position.add(entity.getWorldPosition(new Vector3()));
    if (entities.length) pivot.position.divideScalar(entities.length);
    pivot.quaternion.copy(controls.space === 'local' && entities[0] ? entities[0].getWorldQuaternion(new Quaternion()) : new Quaternion());
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld();
  };
  const attach = (): void => {
    if (!locked && tool !== 'select' && entities.length) { controls.setMode(tool); resetPivot(); controls.attach(pivot); }
    else controls.detach();
  };
  const clearOutlines = (): void => {
    for (const { outline } of links) outline.geometry.dispose();
    links = []; outlines.clear();
  };
  const start = (): void => {
    active = true;
    selection = captureSelection(entities); gestureIds = [...ids];
    before = entities.map(entity => JSON.stringify(readTransform(entity)));
    pivot.updateMatrixWorld(); pivotStart.copy(pivot.matrixWorld);
    gestures?.start();
  };
  const change = (): void => {
    if (!active) return;
    pivot.updateMatrixWorld();
    applySelectionDelta(selection, pivot.matrixWorld.clone().multiply(pivotStart.clone().invert()));
  };
  const end = (): void => {
    if (!active) return;
    active = false; ended = Date.now();
    // An unchanged pivot is a click; avoid floating-point-only undo entries.
    const moved = pivot.matrixWorld.elements.some((value, index) => Math.abs(value - pivotStart.elements[index]!) > 1e-9);
    if (moved && handler) selection.forEach(({ entity }, index) => {
      const transform = readTransform(entity);
      if (JSON.stringify(transform) !== before[index]) handler?.(gestureIds[index]!, transform);
    });
    gestures?.end(); resetPivot();
  };
  controls.addEventListener('mouseDown', start);
  controls.addEventListener('objectChange', change);
  controls.addEventListener('mouseUp', end);
  return {
    setActiveTool(value) { if (active) return; tool = value; attach(); },
    setSpace(value) { if (active) return; controls.setSpace(value); resetPivot(); },
    setSnap(value) {
      if (typeof value.enabled !== 'boolean' || ![value.translate, value.rotateDeg, value.scale].every(step => Number.isFinite(step) && step > 0)) {
        throw new RangeError('Snap steps must be finite positive numbers.');
      }
      snap = { ...value }; applySnap();
    },
    setSelection(next, nextIds) {
      if (active) return;
      entities = [...next]; ids = [...nextIds];
      clearOutlines();
      const seen = new Set<Mesh>();
      for (const entity of entities) entity.traverse(node => {
        if (!(node instanceof Mesh) || seen.has(node)) return;
        seen.add(node);
        const outline = new LineSegments(new EdgesGeometry(node.geometry), outlineMaterial);
        outline.matrixAutoUpdate = false;
        outlines.add(outline); links.push({ source: node, outline });
      });
      attach();
    },
    setGestureHandler(value) { handler = value; },
    setLocked(value) { if (active) end(); locked = value; controls.enabled = !value; outlines.visible = !value; attach(); },
    get isGestureActive() { return active; },
    get lastGestureEndedAt() { return ended; },
    update() {
      for (const { source, outline } of links) {
        source.updateWorldMatrix(true, false);
        outline.matrix.copy(source.matrixWorld); outline.visible = isVisible(source);
      }
    },
    destroy() {
      canvas.removeEventListener('pointerdown', modifier, true);
      window?.removeEventListener('keydown', modifier);
      window?.removeEventListener('keyup', modifier);
      window?.removeEventListener('blur', clearModifier);
      controls.removeEventListener('mouseDown', start); controls.removeEventListener('objectChange', change); controls.removeEventListener('mouseUp', end);
      controls.dispose(); clearOutlines(); outlineMaterial.dispose();
      helper.removeFromParent(); pivot.removeFromParent(); outlines.removeFromParent();
    },
  };
}
