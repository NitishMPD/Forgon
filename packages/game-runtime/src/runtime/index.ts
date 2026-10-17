import { Application, AmmoPhysicsWorld, Entity, FILLMODE_NONE, RESOLUTION_AUTO } from 'playcanvas';
import type { AssetRecord, PrefabDocument, SceneDocument } from '@forgon/project-schema';
import type { AssetBytesResolver, RuntimeEvent } from '../core/types.js';
import { createPlaySession } from './play-session.js';
import { loadPhysics } from './physics.js';
import { validatePlayableScene } from './validate.js';

export { validatePlayableScene } from './validate.js';
export type { RuntimeEvent } from '../core/types.js';
export interface GameOptions {
  scene: SceneDocument;
  assets?: readonly AssetRecord[];
  prefabs?: readonly PrefabDocument[];
  loadAssetBytes?: AssetBytesResolver;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}
export interface GameHandle { dispose(): void }

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
  try {
    app = new Application(canvas, { devtools: false, physicsWorld: new AmmoPhysicsWorld() });
    app.setCanvasFillMode(FILLMODE_NONE);
    app.setCanvasResolution(RESOLUTION_AUTO);
    const editRoot = new Entity('Unused authoring root', app);
    app.root.addChild(editRoot);
    session = createPlaySession({ app, editRoot, audioContext, loadAssetBytes: options.loadAssetBytes,
      context: { assets: options.assets ?? [], prefabs: options.prefabs ?? [] },
      onRuntimeEvent: options.onRuntimeEvent ?? (() => undefined) });
    const resize = (): void => { app!.resizeCanvas(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1)); };
    observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    app.on('update', (dt: number) => session!.update(dt));
    session.start(snapshot);
    app.start();
    let disposed = false;
    return { dispose(): void {
      if (disposed) return;
      disposed = true;
      observer!.disconnect(); session!.dispose(); app!.destroy(); canvas.remove();
    } };
  } catch (error) { observer?.disconnect(); session?.dispose(); if (audioContext?.state !== 'closed') void audioContext?.close(); app?.destroy(); canvas.remove(); throw error; }
}
