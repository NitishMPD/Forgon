import { BoundingBox, Color, Entity, Vec3 } from 'playcanvas';
import type { Application, CameraComponent } from 'playcanvas';

// Editor viewport camera: orbits a pivot, pans in screen space, zooms by pivot distance, and
// frames world-space boxes. It lives on its own engine entity so authored cameras stay inert
// in edit mode; play sessions spawn authored cameras separately from the detached snapshot.
// Input is wired directly onto the canvas element in offset coordinate space (top-left origin,
// same space the Picker and gizmos use) so the module stays standalone without engine Mouse.

const WORLD_UP = new Vec3(0, 1, 0);
const DEG = Math.PI / 180;
const MIN_DISTANCE = 0.05;
const MAX_DISTANCE = 800;
/** Degrees per pixel of drag. */
const ORBIT_DEGREES_PER_PIXEL = 0.55;
/** Multiplier for wheel deltas; positive deltaY (scroll down) zooms out. */
const ZOOM_PER_WHEEL_TICK = 0.0016;

export interface EditorCameraController {
  readonly entity: Entity;
  readonly camera: CameraComponent;
  setPivot(point: Vec3): void;
  /** Wheel zoom; factor > 1 moves away from the pivot, < 1 moves closer. */
  zoom(factor: number): void;
  /** Fits the camera so the world-space box fits comfortably in view. */
  frameBox(box: BoundingBox | null): void;
  /** Sensible default view used until the first scene bounds are known. */
  defaultView(): void;
  /** Gizmo gestures suspend canvas input so camera drags never fight the gizmo. */
  setLocked(locked: boolean): void;
  /** True while the user is orbiting/panning; pick-on-click should be suppressed meanwhile. */
  readonly isNavigating: boolean;
  attach(): void;
  detach(): void;
}

export function createEditorCamera(app: Application): EditorCameraController {
  const entity = new Entity('Forgon Editor Camera', app);
  const camera = entity.addComponent('camera', {
    fov: 60,
    nearClip: 0.05,
    farClip: 800,
  } as never) as CameraComponent;
  camera.clearColor = new Color(0.075, 0.09, 0.13, 1);

  const pivot = new Vec3(0, 1, 0);
  let distance = 10;
  let azimuth = -35 * DEG;
  let elevation = 30 * DEG;
  let locked = false;
  let dragMode: 'orbit' | 'pan' | null = null;
  let lastX = 0;
  let lastY = 0;
  let listenersAttached = false;

  const updateCamera = (): void => {
    const ce = Math.cos(elevation);
    entity.setPosition(
      pivot.x + distance * ce * Math.sin(azimuth),
      pivot.y + distance * Math.sin(elevation),
      pivot.z + distance * ce * Math.cos(azimuth),
    );
    entity.lookAt(pivot, WORLD_UP);
  };

  const screenPanScale = (): number => {
    const canvas = app.graphicsDevice.canvas;
    const height = canvas instanceof HTMLCanvasElement && canvas.clientHeight > 0 ? canvas.clientHeight : 800;
    return (2.2 * distance) / height;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (locked) return;
    const orbit = event.button === 0 || event.button === 2;
    const pan = event.button === 1 || (event.button === 0 && event.shiftKey);
    if (!orbit && !pan) return;
    event.preventDefault();
    dragMode = pan ? 'pan' : 'orbit';
    lastX = event.offsetX;
    lastY = event.offsetY;
    (app.graphicsDevice.canvas as HTMLCanvasElement).setPointerCapture(event.pointerId);
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
      const world = entity.getWorldTransform();
      const scale = screenPanScale();
      const right = world.getX(new Vec3());
      const up = world.getY(new Vec3());
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
    distance = clamp(distance * Math.exp(event.deltaY * ZOOM_PER_WHEEL_TICK), MIN_DISTANCE, MAX_DISTANCE);
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
    setPivot(point: Vec3): void {
      pivot.copy(point);
      updateCamera();
    },
    zoom(factor: number): void {
      distance = clamp(distance * factor, MIN_DISTANCE, MAX_DISTANCE);
      updateCamera();
    },
    frameBox(box: BoundingBox | null): void {
      if (!box) {
        controller.defaultView();
        return;
      }
      const center = box.center;
      const half = box.halfExtents;
      const radius = Math.max(half.length(), 0.05);
      const device = app.graphicsDevice;
      const aspect = device.height > 0 ? device.width / device.height : 1.6;
      const verticalFov = camera.fov * DEG;
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
      const fit = Math.max(radius / Math.sin(verticalFov / 2), radius / Math.sin(horizontalFov / 2));
      distance = clamp(fit * 1.35, MIN_DISTANCE, MAX_DISTANCE);
      pivot.copy(center);
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
      const canvas = app.graphicsDevice.canvas;
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
      const canvas = app.graphicsDevice.canvas;
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

/** Collects a combined world-space box over the given entities (render bounds, else position). */
export function boundsOfEntities(entities: readonly Entity[]): BoundingBox | null {
  let combined: BoundingBox | null = null;
  for (const entity of entities) {
    const entityBox = boxOfEntity(entity);
    if (!entityBox) continue;
    if (!combined) {
      combined = entityBox;
      continue;
    }
    combined.add(entityBox);
  }
  return combined;
}

function boxOfEntity(entity: Entity): BoundingBox | null {
  entity.getWorldTransform();
  if (entity.render && entity.render.meshInstances.length > 0) {
    let box: BoundingBox | null = null;
    for (const meshInstance of entity.render.meshInstances) {
      const aabb = meshInstance.aabb;
      if (!box) box = aabb.clone();
      else box.add(aabb);
    }
    if (box) return box;
  }
  const position = entity.getPosition();
  const radius = entity.camera || entity.light ? 0.4 : 0.5;
  const box = new BoundingBox();
  box.center.set(position.x, position.y, position.z);
  box.halfExtents.set(radius, radius, radius);
  return box;
}
