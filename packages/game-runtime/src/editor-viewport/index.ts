import { Group, Scene } from 'three';
import { createRenderSurface } from '../core/renderer.js';
import type { SceneDocument } from '@forgon/project-schema';
import { boundsOfEntities, createEditorCamera, type EditorCameraController } from '../core/editor-camera.js';
import { createGizmoController, type GizmoController } from '../core/gizmos.js';
import { createGridEntity, setGridStep } from '../core/grid.js';
import { createDiagnostics, createMaterialCache, createSceneRegistry, SceneNode, disposeGraph, type MaterialCache, type SceneRegistry } from '../core/projection.js';
import { createModelCache } from '../core/models.js';
import { createPickingSession, type PickingSession } from '../core/picking.js';
import { reconcileScene } from '../core/reconcile.js';
import { faultMessage, validateScene } from '../core/validate.js';
import type { ViewportCallbacks, ViewportHandle, ViewportMountOptions, ViewportTool } from '../core/types.js';
import { loadPhysics, physicsReady } from '../runtime/physics.js';
import { createPlaySession, type PlaySession } from '../runtime/play-session.js';
import { createInputSource, type InputSource } from '../runtime/input.js';
import { createHud, type Hud } from '../runtime/hud.js';

// The editor viewport mount: a Three.js renderer bound to a canvas inside the given
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

  const world = new Scene();
  const editRoot = new Group(); editRoot.name = 'Forgon Edit Root';
  world.add(editRoot);
  const worldRoot = new Group(); editRoot.add(worldRoot);
  const grid = createGridEntity(); editRoot.add(grid);
  let gridStep = 0.5;
  const editorCamera = createEditorCamera(canvas); editRoot.add(editorCamera.entity);

  const registry: SceneRegistry = createSceneRegistry();
  const materials: MaterialCache = createMaterialCache();
  const diagnostics = createDiagnostics(message => callbacks.onFault(message));
  let modelSelectionDirty = false;
  const models = createModelCache(options.loadAssetBytes, () => { modelSelectionDirty = true; });

  const gestureChanges: { entityId: string; transform: import('@forgon/project-schema').Transform }[] = [];
  let draggingIds: Set<string> = new Set();
  const gizmoController = createGizmoController(
    world,
    editorCamera.camera,
    canvas,
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

  const picker = createPickingSession(canvas, worldRoot, registry);

  // Play reads `deps.input` every frame, so a live holder lets Play attach the browser controls
  // without rebuilding the session. Without it a parkour course would run on empty input: the
  // editor has no keyboard mapping of its own, so WASD/jump/slide would do nothing.
  const playDeps = {
    world,
    editRoot,
    context: options.context,
    loadAssetBytes: options.loadAssetBytes,
    models,
    scripts: options.scripts,
    onRuntimeEvent: (event: import('../core/types.js').RuntimeEvent) => {
      options.onRuntimeEvent?.(event);
      if (event.type === 'fault') callbacks.onFault(event.message);
    },
    input: undefined as InputSource | undefined,
  };
  const playSession: PlaySession = createPlaySession(playDeps);

  // Browser controls and HUD live only for the duration of a Play, so edit-mode shortcuts and
  // the editor camera are untouched, and nothing keeps listening after Stop.
  let playInput: InputSource | null = null;
  let playHud: Hud | null = null;
  const releasePlaySurface = (): void => {
    playDeps.input = undefined;
    playInput?.dispose(); playInput = null;
    playHud?.dispose(); playHud = null;
  };

  let lastView: { scene: SceneDocument; selectedIds: readonly string[] } | null = null;
  let currentSelectionIds: readonly string[] = [];
  let disposed = false;
  let hasSeenScene = false;


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
    const entities: SceneNode[] = [];
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
      reconcileScene({ root: worldRoot, registry, materials, diagnostics, models, draggingIds }, scene);
      applySelection();
    } catch (error) {
      callbacks.onFault(faultMessage(error));
    }
  };

  let surface: ReturnType<typeof createRenderSurface>;
  try {
    surface = createRenderSurface(canvas, container, world,
      () => playSession.isPlaying ? playSession.getCamera() : editorCamera.camera,
      dt => {
        playSession.update(dt); const numbers = playSession.getHud(); if (numbers) playHud?.update(numbers);
        if (modelSelectionDirty && !playSession.isPlaying && !gizmoController.isGestureActive) { applySelection(); modelSelectionDirty = false; }
        gizmoController.update();
      },
      error => callbacks.onFault(faultMessage(error)));
  } catch (error) {
    gizmoController.destroy(); editorCamera.detach(); grid.geometry.dispose(); grid.material.dispose(); canvas.remove(); throw error;
  }

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
            .filter((entity): entity is SceneNode => entity !== undefined);
          editorCamera.frameBox(boundsOfEntities(entities));
        });
      }
    },
    setTool(tool: ViewportTool): void {
      if (disposed) return;
      gizmoController.setActiveTool(tool);
      applySelection();
    },
    setSpace(space): void { if (!disposed) gizmoController.setSpace(space); },
    setSnap(snap): void {
      if (disposed) return;
      if (!Number.isFinite(snap.translate) || snap.translate < 0.01) throw new RangeError('Grid step must be at least 0.01 m.');
      gizmoController.setSnap(snap);
      if (snap.translate !== gridStep) { setGridStep(grid, snap.translate); gridStep = snap.translate; }
    },
    surfaceAt(clientX, clientY) {
      if (disposed || playSession.isPlaying) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const point = picker.surfaceAt(editorCamera.camera,
        (clientX - rect.left) * canvas.clientWidth / rect.width,
        (clientY - rect.top) * canvas.clientHeight / rect.height);
      return point ? { ...point, modelMinY: assetId => {
        const minY = models.bounds(assetId)?.min.y;
        return minY !== undefined && Number.isFinite(minY) ? minY : null;
      } } : null;
    },
    frameSelection(): void {
      if (disposed) return;
      const view = lastView;
      if (!view) return;
      const entities = view.selectedIds
        .map(id => registry.byId.get(id))
        .filter((entity): entity is SceneNode => entity !== undefined);
      editorCamera.frameBox(boundsOfEntities(entities));
    },
    play(scene: SceneDocument, scripts?: import('../scripting/index.js').ScriptModules): void {
      if (disposed) return;
      try {
        if (!physicsReady()) throw new Error('Physics is still loading. Retry Play when initialization completes.');
        playSession.start(scene, scripts);
        if (typeof window !== 'undefined') {
          if (!playInput) playInput = createInputSource(canvas);
          playDeps.input = playInput;
          // Move focus off the Play button so Space jumps instead of re-activating it.
          canvas.focus();
        }
        const numbers = playSession.getHud();
        if (numbers && typeof document !== 'undefined') {
          if (!playHud) playHud = createHud(container);
          playHud.showOpening(scene.name.toUpperCase(), 'reach the uplink');
        }
        gizmoController.setLocked(true);
        editorCamera.setLocked(true);
      } catch (error) {
        playSession.stop();
        releasePlaySurface();
        gizmoController.setLocked(false);
        editorCamera.setLocked(false);
        callbacks.onFault(`Play failed: ${faultMessage(error)}`);
        throw error;
      }
    },
    stop(): void {
      if (disposed) return;
      editorCamera.setLocked(false);
      playSession.stop();
      releasePlaySurface();
      gizmoController.setLocked(false);
      if (lastView) {
        // Replays any authoring that happened while playing.
        reconcileCurrentView();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      surface.dispose();
      playSession.dispose();
      releasePlaySurface();
      gizmoController.destroy();
      editorCamera.detach();
      picker?.dispose();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      materials.dispose();
      disposeGraph(worldRoot);
      models.dispose();
      registry.byId.clear(); registry.idByNode.clear();
      grid.geometry.dispose(); grid.material.dispose();
      world.clear();
      canvas.remove();
    },
  };

  void loadPhysics().catch(error => { if (!disposed) callbacks.onFault(`Physics initialization failed: ${faultMessage(error)}`); });
  try { surface.start(); } catch (error) { handle.dispose(); throw error; }

  return handle;
};

export type { EditorCameraController, GizmoController, PickingSession, SceneDocument };
