import { TransformGizmo, Gizmo, RotateGizmo, ScaleGizmo, TranslateGizmo } from 'playcanvas';
import type { Application, CameraComponent, Entity, Layer } from 'playcanvas';
import type { Transform } from '@forgon/project-schema';
import type { ViewportTool } from './types.js';

// Engine gizmo editing. All three transform gizmos share one Gizmo layer created with
// Gizmo.createLayer; only the active tool is attached to the current selection. The gizmos
// mutate engine node local transforms directly during a drag, so the gesture is bracketed:
// gesture start locks camera input and captures the node/id pairing, gesture end reads back
// local transforms and emits onTransform per entity so the host routes the change through
// the store. Reconcile skips transform patches for dragging ids while a gesture runs.

export interface GizmoController {
  readonly layer: Layer;
  setActiveTool(tool: ViewportTool): void;
  /** Re-targets the active tool at these engine entities; ids run parallel to entities. */
  setSelection(entities: readonly Entity[], ids: readonly string[]): void;
  /** Swaps the gesture commit path (play sessions set null while the edit graph is hidden). */
  setGestureHandler(handler: ((entityId: string, transform: Transform) => void) | null): void;
  setLocked(locked: boolean): void;
  /** True between transform:start and transform:end. */
  readonly isGestureActive: boolean;
  /** Date.now() of the most recent gesture end; pick handlers drop clicks that were drags. */
  readonly lastGestureEndedAt: number;
  destroy(): void;
}

export function createGizmoController(
  app: Application,
  camera: CameraComponent,
  onTransformCommit: (entityId: string, transform: Transform) => void,
  gestures?: {
    /** Runs on transform:start, before any node moves. */
    start(): void;
    /** Runs on transform:end after transform commits are emitted. */
    end(): void;
  },
): GizmoController {
  const layer = Gizmo.createLayer(app, 'Forgon Gizmo');
  const translate = new TranslateGizmo(camera, layer);
  const rotate = new RotateGizmo(camera, layer);
  const scale = new ScaleGizmo(camera, layer);
  const all: Array<TranslateGizmo | RotateGizmo | ScaleGizmo> = [translate, rotate, scale];

  let active: TranslateGizmo | RotateGizmo | ScaleGizmo | null = null;
  let gestureHandler: ((entityId: string, transform: Transform) => void) | null = onTransformCommit;
  let gestureActive = false;
  let lastGestureEndedAt = 0;
  /** Ids parallel to the selection the gizmo was attached to (set by setSelection). */
  let selectionIds: readonly string[] = [];
  /** Last selection seen, so a tool switch re-attaches the same nodes immediately. */
  let lastEntities: readonly Entity[] = [];
  /** Ids captured at gesture start; the gizmo nodes array is parallel to these. */
  let gestureIds: readonly string[] = [];
  let beforeTransforms: string[] = [];

  const readTransform = (entity: Entity): Transform => {
    const position = entity.getLocalPosition();
    const rotationEuler = entity.getLocalEulerAngles();
    const scaleVec = entity.getLocalScale();
    return {
      position: [position.x, position.y, position.z],
      rotationEuler: [rotationEuler.x, rotationEuler.y, rotationEuler.z],
      scale: [scaleVec.x, scaleVec.y, scaleVec.z],
    };
  };

  const onTransformStart = (): void => {
    gestureActive = true;
    // Gizmo.attach stores the array we passed (attach(nodes) sets this.nodes = nodes), so
    // gizmo.nodes stays parallel to selectionIds as long as they were set together.
    gestureIds = selectionIds.slice();
    beforeTransforms = (active?.nodes ?? []).map(node => JSON.stringify(readTransform(node as Entity)));
    gestures?.start();
  };
  const onTransformMove = (): void => {
    gestureActive = true;
  };
  const onTransformEnd = (): void => {
    gestureActive = false;
    lastGestureEndedAt = Date.now();
    const nodes = active?.nodes ?? [];
    const ids = gestureIds;
    if (gestureHandler) {
      nodes.forEach((node, index) => {
        const entityId = ids[index];
        if (entityId === undefined) return;
        const transform = readTransform(node as Entity);
        if (JSON.stringify(transform) !== beforeTransforms[index]) gestureHandler?.(entityId, transform);
      });
    }
    gestureIds = [];
    gestures?.end();
  };
  for (const gizmo of all) {
    gizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, onTransformStart);
    gizmo.on(TransformGizmo.EVENT_TRANSFORMMOVE, onTransformMove);
    gizmo.on(TransformGizmo.EVENT_TRANSFORMEND, onTransformEnd);
  }

  const controller: GizmoController = {
    layer,
    setActiveTool(tool: ViewportTool): void {
      active = tool === 'translate' ? translate : tool === 'rotate' ? rotate : tool === 'scale' ? scale : null;
      for (const gizmo of all) {
        if (gizmo === active) continue;
        gizmo.detach();
      }
      if (active && lastEntities.length > 0) active.attach(lastEntities.slice());
    },
    setSelection(entities: readonly Entity[], ids: readonly string[]): void {
      selectionIds = ids;
      lastEntities = entities;
      gestureIds = [];
      if (active) {
        if (entities.length > 0) active.attach(entities.slice());
        else active.detach();
      }
    },
    setGestureHandler(handler: ((entityId: string, transform: Transform) => void) | null): void {
      gestureHandler = handler;
    },
    setLocked(locked: boolean): void {
      if (locked) {
        for (const gizmo of all) gizmo.enabled = false;
      } else if (active && active.nodes.length > 0) {
        active.enabled = true;
      }
    },    get isGestureActive(): boolean {
      return gestureActive;
    },
    get lastGestureEndedAt(): number {
      return lastGestureEndedAt;
    },
    destroy(): void {
      for (const gizmo of all) {
        gizmo.off(TransformGizmo.EVENT_TRANSFORMSTART, onTransformStart);
        gizmo.off(TransformGizmo.EVENT_TRANSFORMMOVE, onTransformMove);
        gizmo.off(TransformGizmo.EVENT_TRANSFORMEND, onTransformEnd);
        gizmo.destroy();
      }
      active = null;
    },
  };

  return controller;
}
