import { Application, AmmoPhysicsWorld, Entity, FILLMODE_NONE, RESOLUTION_AUTO } from 'playcanvas';
import type { AssetRecord, PrefabDocument, SceneDocument } from '@forgon/project-schema';
import type { AssetBytesResolver, HudNumbers, RuntimeEvent } from '../core/types.js';
import { createPlaySession } from './play-session.js';
import { loadPhysics } from './physics.js';
import { validatePlayableScene } from './validate.js';
import { createInputSource } from './input.js';
import type { InputSource } from './input.js';
import { createHud } from './hud.js';
import type { Hud } from './hud.js';

export { validatePlayableScene } from './validate.js';
export { hasParkour } from './parkour.js';
export type { ParkourEvent, ParkourInputState, ParkourLevel, ParkourState } from './parkour.js';
export type { CameraDef, CameraMode, CameraView } from './camera-director.js';
export type { InputSample, InputSource } from './input.js';
export type { Hud, HudSnapshot } from './hud.js';
export type { RuntimeEvent } from '../core/types.js';

export interface GameOptions {
  scene: SceneDocument;
  assets?: readonly AssetRecord[];
  prefabs?: readonly PrefabDocument[];
  loadAssetBytes?: AssetBytesResolver;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  /** Supply an input source (tests/headless); otherwise a DOM input source is created. */
  input?: InputSource | null;
  /** Render the built-in HUD overlay; defaults to true in a browser. */
  hud?: boolean;
  /** Opening card text for a parkour course; defaults to the scene name. */
  title?: string;
  subtitle?: string;
}

export interface GameHandle {
  dispose(): void;
  /** Latest parkour HUD numbers, or null for a non-parkour scene. */
  getHud(): HudNumbers | null;
  /** True when the mounted scene contains a parkour player. */
  readonly parkour: boolean;
}

/** Mount an actual standalone player. GPU/physics failure rejects instead of simulating success. */
export async function mountGame(container: HTMLElement, options: GameOptions): Promise<GameHandle> {
  const snapshot = validatePlayableScene(options.scene, { assets: options.assets ?? [], prefabs: options.prefabs ?? [] });
  // Create/resume audio in the caller's Start gesture, before asynchronous WASM loading.
  const audioContext = snapshot.entities.some(e => e.components.some(c => c.type === 'audio' && c.enabled)) && typeof AudioContext !== 'undefined' ? new AudioContext() : null;
  if (audioContext?.state === 'suspended') void audioContext.resume().catch(error => options.onRuntimeEvent?.({ type: 'fault', message: `Audio resume failed: ${String(error)}` }));
  try { await loadPhysics(); } catch (error) { void audioContext?.close(); throw error; }
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Game viewport');
  container.appendChild(canvas);
  let app: Application | undefined;
  let observer: ResizeObserver | undefined;
  let session: ReturnType<typeof createPlaySession> | undefined;
  let input: InputSource | null = null;
  let hud: Hud | null = null;
  try {
    app = new Application(canvas, { devtools: false, physicsWorld: new AmmoPhysicsWorld() });
    app.setCanvasFillMode(FILLMODE_NONE);
    app.setCanvasResolution(RESOLUTION_AUTO);
    input = options.input === undefined ? createInputSource(canvas) : options.input;
    if (options.hud !== false) hud = createHud(container);
    const editRoot = new Entity('Unused authoring root', app);
    app.root.addChild(editRoot);
    session = createPlaySession({ app, editRoot, audioContext, loadAssetBytes: options.loadAssetBytes,
      context: { assets: options.assets ?? [], prefabs: options.prefabs ?? [] },
      input: input ?? undefined,
      onRuntimeEvent: options.onRuntimeEvent ?? (() => undefined) });
    // Resizing clears the canvas; draw now so the cleared buffer is never painted.
    let started = false;
    const resize = (): void => { app!.resizeCanvas(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1)); if (started) app!.render(); };
    observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    app.on('update', (dt: number) => {
      session!.update(dt);
      const numbers = session!.getHud();
      if (hud && numbers) hud.update(numbers);
    });
    session.start(snapshot);
    const isParkour = session.getHud() !== null;
    if (hud && isParkour) hud.showOpening(options.title ?? snapshot.name.toUpperCase(), options.subtitle ?? 'run the sector');
    app.start();
    started = true;
    let disposed = false;
    return {
      parkour: isParkour,
      getHud: () => session!.getHud(),
      dispose(): void {
        if (disposed) return;
        disposed = true;
        observer!.disconnect(); input?.dispose(); hud?.dispose(); session!.dispose(); app!.destroy(); canvas.remove();
      },
    };
  } catch (error) {
    observer?.disconnect(); input?.dispose(); hud?.dispose(); session?.dispose();
    if (audioContext && audioContext.state !== 'closed') void audioContext.close();
    app?.destroy(); canvas.remove(); throw error;
  }
}
