import { Box3, PerspectiveCamera, Vector3, Object3D } from 'three';

// Editor viewport camera: orbits a pivot, pans in screen space, zooms by pivot distance, and
// frames world-space boxes. It lives on its own engine entity so authored cameras stay inert
// in edit mode; play sessions spawn authored cameras separately from the detached snapshot.
// Input is wired directly onto the canvas element in offset coordinate space (top-left origin,
// same space the Picker and gizmos use) so the module stays standalone without engine Mouse.

const WORLD_UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
const MIN_DISTANCE = 0.05;
const MAX_DISTANCE = 800;
/** Degrees per pixel of drag. */
const ORBIT_DEGREES_PER_PIXEL = 0.55;
/** Multiplier for wheel deltas; positive deltaY (scroll down) zooms out. */
const ZOOM_PER_WHEEL_TICK = 0.0016;

export interface EditorCameraController {
  readonly entity: PerspectiveCamera;
  readonly camera: PerspectiveCamera;
  setPivot(point: Vector3): void;
  /** Wheel zoom; factor > 1 moves away from the pivot, < 1 moves closer. */
  zoom(factor: number): void;
  /** Fits the camera so the world-space box fits comfortably in view. */
  frameBox(box: Box3 | null): void;
  /** Rotate around the existing pivot without changing framing. */
  orbit(radians: number): void;
  /** Sensible default view used until the first scene bounds are known. */
  defaultView(): void;
  /** Gizmo gestures suspend canvas input so camera drags never fight the gizmo. */
  setLocked(locked: boolean): void;
  /** True while the user is orbiting/panning; pick-on-click should be suppressed meanwhile. */
  readonly isNavigating: boolean;
  attach(): void;
  detach(): void;
}

export function createEditorCamera(canvas: HTMLCanvasElement): EditorCameraController {
  const entity = new PerspectiveCamera(60, 1, 0.05, 800);
  entity.name = 'Forgon Editor Camera';
  const camera = entity;

  const pivot = new Vector3(0, 1, 0);
  let distance = 10;
  let maxZoomDistance = MAX_DISTANCE;
  let azimuth = -35 * DEG;
  let elevation = 30 * DEG;
  let locked = false;
  let dragMode: 'orbit' | 'pan' | null = null;
  let lastX = 0;
  let lastY = 0;
  let listenersAttached = false;

  const updateCamera = (): void => {
    const ce = Math.cos(elevation);
    entity.position.set(
      pivot.x + distance * ce * Math.sin(azimuth),
      pivot.y + distance * Math.sin(elevation),
      pivot.z + distance * ce * Math.cos(azimuth),
    );
    entity.up.copy(WORLD_UP);
    entity.lookAt(pivot);
    entity.updateMatrixWorld();
  };

  const screenPanScale = (): number => {
    const height = canvas.clientHeight > 0 ? canvas.clientHeight : 800;
    return (2.2 * distance) / height;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (locked) return;
    const orbit = event.button === 0 || event.button === 2;
    const pan = event.button === 1 || (event.button === 0 && event.shiftKey);
    if (!orbit && !pan) return;
    canvas.focus();
    event.preventDefault();
    dragMode = pan ? 'pan' : 'orbit';
    lastX = event.offsetX;
    lastY = event.offsetY;
    canvas.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (dragMode === null) return;
    if (locked) {
      // A gizmo gesture took the pointer mid-drag; abandon camera navigation.
      dragMode = null;
      return;
    }
    const dx = event.offsetX - lastX;
    const dy = event.offsetY - lastY;
    lastX = event.offsetX;
    lastY = event.offsetY;
    if (dx === 0 && dy === 0) return;

    navigate(dx, dy, dragMode === 'pan');
  };

  const navigate = (dx: number, dy: number, pan: boolean): void => {
    if (!pan) {
      azimuth -= dx * ORBIT_DEGREES_PER_PIXEL * DEG;
      elevation = clamp(elevation + dy * ORBIT_DEGREES_PER_PIXEL * DEG, -89 * DEG, 89 * DEG);
    } else {
      // Pan in screen space: camera right for dx, camera up for dy, scaled by pivot distance.
      const world = entity.matrixWorld;
      const scale = screenPanScale();
      const right = new Vector3().setFromMatrixColumn(world, 0);
      const up = new Vector3().setFromMatrixColumn(world, 1);
      pivot.x -= (right.x * dx - up.x * dy) * scale;
      pivot.y -= (right.y * dx - up.y * dy) * scale;
      pivot.z -= (right.z * dx - up.z * dy) * scale;
    }
    updateCamera();
  };

  const onPointerUp = (): void => {
    dragMode = null;
  };

  const onWheel = (event: WheelEvent): void => {
    if (locked) return;
    event.preventDefault();
    distance = clamp(distance * Math.exp(event.deltaY * ZOOM_PER_WHEEL_TICK), MIN_DISTANCE, maxZoomDistance);
    updateCamera();
  };

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (locked || event.ctrlKey || event.metaKey || event.altKey) return;
    const direction: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
    const delta = direction[event.key];
    if (delta) { event.preventDefault(); navigate(delta[0], delta[1], event.shiftKey); }
    else if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault(); controller.zoom(event.key === '-' ? 1.15 : 1 / 1.15);
    } else if (event.key === 'Home') { event.preventDefault(); controller.defaultView(); }
  };

  const controller: EditorCameraController = {
    entity,
    camera,
    setPivot(point: Vector3): void {
      pivot.copy(point);
      updateCamera();
    },
    zoom(factor: number): void {
      distance = clamp(distance * factor, MIN_DISTANCE, maxZoomDistance);
      updateCamera();
    },
    frameBox(box: Box3 | null): void {
      if (!box) {
        controller.defaultView();
        return;
      }
      const center = box.getCenter(new Vector3());
      const half = box.getSize(new Vector3()).multiplyScalar(0.5);
      const radius = Math.max(half.length(), 0.05);
      const aspect = camera.aspect;
      const verticalFov = camera.fov * DEG;
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
      const fit = Math.max(radius / Math.sin(verticalFov / 2), radius / Math.sin(horizontalFov / 2));
      distance = Math.max(fit * 1.35, MIN_DISTANCE);
      maxZoomDistance = Math.max(MAX_DISTANCE, distance * 4);
      camera.far = Math.max(800, maxZoomDistance + radius * 2);
      camera.updateProjectionMatrix();
      pivot.copy(center);
      updateCamera();
    },
    orbit(radians): void {
      azimuth += radians;
      updateCamera();
    },
    defaultView(): void {
      pivot.set(0, 1, 0);
      distance = 10;
      azimuth = -35 * DEG;
      elevation = 30 * DEG;
      updateCamera();
    },
    setLocked(value: boolean): void {
      locked = value;
      if (value) dragMode = null;
    },
    get isNavigating(): boolean {
      return dragMode !== null;
    },
    attach(): void {
      if (listenersAttached) return;
      listenersAttached = true;
      canvas.addEventListener('keydown', onKeyDown);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContextMenu);
    },
    detach(): void {
      if (!listenersAttached) return;
      listenersAttached = false;
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };

  updateCamera();
  return controller;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Combined world bounds of rendered descendants, with a position fallback for empty nodes. */
export function boundsOfEntities(entities: readonly Object3D[]): Box3 | null {
  if (!entities.length) return null;
  const combined = new Box3();
  for (const entity of entities) {
    entity.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(entity);
    if (box.isEmpty()) {
      const point = entity.getWorldPosition(new Vector3());
      box.setFromCenterAndSize(point, new Vector3(1, 1, 1));
    }
    combined.union(box);
  }
  return combined;
}
