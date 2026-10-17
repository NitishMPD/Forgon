import { Application, Entity, FILLMODE_NONE, RESOLUTION_AUTO } from 'playcanvas';
import type { Layer } from 'playcanvas';
import type { SceneDocument } from '@forgon/project-schema';
import { boundsOfEntities, createEditorCamera, type EditorCameraController } from '../core/editor-camera.js';
import { createGizmoController, type GizmoController } from '../core/gizmos.js';
import { createGridEntity } from '../core/grid.js';
import { createMaterialCache, createSceneRegistry, type MaterialCache, type ProjectionDiagnostics, type SceneRegistry } from '../core/projection.js';
import { createPickingSession, type PickingSession } from '../core/picking.js';
import { reconcileScene, type ReconcileStats } from '../core/reconcile.js';
import { faultMessage, validateScene } from '../core/validate.js';
import type { ViewportCallbacks, ViewportHandle, ViewportMountOptions, ViewportTool } from '../core/types.js';
import { loadPhysics, physicsReady } from '../runtime/physics.js';
import { createPlaySession, type PlaySession } from '../runtime/play-session.js';

// The editor viewport mount: a PlayCanvas Application bound to a canvas inside the given
// container, an editor-owned camera/grid/gizmo/picking stack for edit mode, and a detached
// play session over authored snapshots. The host (editor UI or the standalone preview page)
// supplies documents through update() and play(); validation runs here before any engine
// state is touched. Click picks and gizmo gestures feed the store through the callbacks.

/** Clicks that end within this window after a gizmo gesture are drags, not picks. */
const PICK_SUPPRESSION_MS = 80;
const PICK_MAX_DRAG_PX = 5;
const PICK_MAX_CLICK_MS = 350;

export const mountEditorViewport = (
  container: HTMLElement,
  callbacks: ViewportCallbacks,
  options: ViewportMountOptions = {},
): ViewportHandle => {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.setAttribute('aria-label', 'Scene viewport. Arrow keys orbit, Shift and arrows pan, plus and minus zoom, Home resets camera.');
  canvas.tabIndex = 0;
  container.appendChild(canvas);

  let app: Application;
  try { app = new Application(canvas, { devtools: false }); }
  catch (error) { canvas.remove(); throw error; }
  app.setCanvasFillMode(FILLMODE_NONE);
  app.setCanvasResolution(RESOLUTION_AUTO);

  // Edit-mode graph layout under the scene root:
  //   editRoot (toggled off during play)
  //     worldRoot    - reconciled scene entities keyed by stable id
  //     grid         - reference grid
  //     editorCamera - viewport navigation camera
  const editRoot = new Entity('Forgon Edit Root', app);
  app.root.addChild(editRoot);
  const worldRoot = new Entity('Forgon World Root', app);
  editRoot.addChild(worldRoot);
  const grid = createGridEntity(app);
  editRoot.addChild(grid);
  const editorCamera = createEditorCamera(app);
  editRoot.addChild(editorCamera.entity);

  const registry: SceneRegistry = createSceneRegistry();
  const materials: MaterialCache = createMaterialCache();
  const diagnostics: ProjectionDiagnostics = { unsupported: [] };

  const gestureChanges: { entityId: string; transform: import('@forgon/project-schema').Transform }[] = [];
  let draggingIds: Set<string> = new Set();
  const gizmoController = createGizmoController(
    app,
    editorCamera.camera,
    (entityId, transform) => gestureChanges.push({ entityId, transform }),
    {
      start: () => {
        gestureChanges.length = 0;
        draggingIds = new Set(currentSelectionIds);
        editorCamera.setLocked(true);
      },
      end: () => {
        draggingIds = new Set();
        editorCamera.setLocked(false);
        if (gestureChanges.length) {
          if (callbacks.onTransforms) callbacks.onTransforms(gestureChanges.slice());
          else for (const change of gestureChanges) callbacks.onTransform?.(change.entityId, change.transform);
        }
      },
    },
  );
  editorCamera.attach();

  let picker: PickingSession | null = null;
  {
    const layers: Layer[] = [];
    const worldLayer = app.scene.layers.getLayerByName('World');
    if (worldLayer) layers.push(worldLayer);
    picker = createPickingSession(app, registry, layers);
  }

  const playSession: PlaySession = createPlaySession({
    app,
    editRoot,
    context: options.context,
    loadAssetBytes: options.loadAssetBytes,
    onRuntimeEvent: options.onRuntimeEvent ?? (() => undefined),
  });

  let lastView: { scene: SceneDocument; selectedIds: readonly string[] } | null = null;
  let lastStats: ReconcileStats = { added: [], removed: [], patched: [] };
  let currentSelectionIds: readonly string[] = [];
  let disposed = false;
  let hasSeenScene = false;

  const resize = (): void => {
    if (disposed) return;
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    app.resizeCanvas(width, height);
  };
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  resizeObserver?.observe(container);

  let downAt: { x: number; y: number; time: number } | null = null;
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    downAt = { x: event.offsetX, y: event.offsetY, time: Date.now() };
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const start = downAt;
    downAt = null;
    if (!start || !picker || disposed || playSession.isPlaying) return;
    const moved = Math.hypot(event.offsetX - start.x, event.offsetY - start.y);
    const elapsed = Date.now() - start.time;
    const recentGesture = Date.now() - gizmoController.lastGestureEndedAt < PICK_SUPPRESSION_MS;
    if (moved > PICK_MAX_DRAG_PX || elapsed > PICK_MAX_CLICK_MS) return;
    if (editorCamera.isNavigating || gizmoController.isGestureActive || recentGesture) return;
    try {
      const entityId = picker.pickAt(editorCamera.camera, event.offsetX, event.offsetY);
      callbacks.onPick(entityId);
    } catch (error) {
      callbacks.onFault(`Picking failed: ${faultMessage(error)}`);
    }
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  const applySelection = (): void => {
    const view = lastView;
    if (!view) return;
    const entities: Entity[] = [];
    const ids: string[] = [];
    for (const id of view.selectedIds) {
      const entity = registry.byId.get(id);
      if (!entity) continue;
      entities.push(entity);
      ids.push(id);
    }
    currentSelectionIds = ids;
    // The legacy callback cannot atomically commit multiple entities.
    if (!gizmoController.isGestureActive) gizmoController.setSelection(callbacks.onTransforms ? entities : entities.slice(0, 1), callbacks.onTransforms ? ids : ids.slice(0, 1));
  };

  const reconcileCurrentView = (): void => {
    const view = lastView;
    if (!view) return;
    try {
      const scene = validateScene(view.scene, options.context);
      lastStats = reconcileScene({ app, root: worldRoot, registry, materials, diagnostics, draggingIds }, scene);
      applySelection();
    } catch (error) {
      callbacks.onFault(faultMessage(error));
    }
  };

  app.on('update', (dt: unknown) => {
    if (!disposed) playSession.update(dt as number);
  });

  const handle: ViewportHandle = {
    update(view): void {
      if (disposed) return;
      try {
        // Validate up front so a rejected scene never touches engine state.
        validateScene(view.scene, options.context);
      } catch (error) {
        callbacks.onFault(faultMessage(error));
        return;
      }
      lastView = { scene: structuredClone(view.scene), selectedIds: [...view.selectedIds] };
      if (playSession.isPlaying) {
        // The edit graph is hidden during play; the update is replayed on stop.
        return;
      }
      reconcileCurrentView();
      if (!hasSeenScene && view.scene.entities.length > 0) {
        hasSeenScene = true;
        // Let layout settle so the frame uses the real canvas aspect ratio.
        requestAnimationFrame(() => {
          if (disposed) return;
          const entities = view.scene.entities
            .map(entity => registry.byId.get(entity.id))
            .filter((entity): entity is Entity => entity !== undefined);
          editorCamera.frameBox(boundsOfEntities(entities));
        });
      }
    },
    setTool(tool: ViewportTool): void {
      if (disposed) return;
      gizmoController.setActiveTool(tool);
      applySelection();
    },
    frameSelection(): void {
      if (disposed) return;
      const view = lastView;
      if (!view) return;
      const entities = view.selectedIds
        .map(id => registry.byId.get(id))
        .filter((entity): entity is Entity => entity !== undefined);
      editorCamera.frameBox(boundsOfEntities(entities));
    },
    play(scene: SceneDocument): void {
      if (disposed) return;
      try {
        if (!physicsReady()) throw new Error('Physics is still loading. Retry Play when initialization completes.');
        playSession.start(scene);
        editorCamera.setLocked(true);
        gizmoController.setLocked(true);
      } catch (error) {
        editorCamera.setLocked(false);
        callbacks.onFault(`Play failed: ${faultMessage(error)}`);
        throw error;
      }
    },
    stop(): void {
      if (disposed) return;
      editorCamera.setLocked(false);
      playSession.stop();
      gizmoController.setLocked(false);
      if (lastView) {
        // Replays any authoring that happened while playing.
        reconcileCurrentView();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      resizeObserver?.disconnect();
      playSession.dispose();
      gizmoController.destroy();
      editorCamera.detach();
      picker?.dispose();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      materials.dispose();
      app.destroy();
      canvas.remove();
    },
  };

  void loadPhysics().then(() => {
    if (!disposed) app.systems.rigidbody?.onLibraryLoaded();
  }).catch(error => { if (!disposed) callbacks.onFault(`Physics initialization failed: ${faultMessage(error)}`); });
  resize();
  app.start();

  return handle;
};

export type { EditorCameraController, GizmoController, PickingSession, SceneDocument };
