import { Group, Scene } from 'three';
import { createRenderSurface } from '../core/renderer.js';
import type { AssetRecord, PrefabDocument, SceneDocument } from '@forgon/project-schema';
import type { AssetBytesResolver, HudNumbers, RuntimeEvent } from '../core/types.js';
import { createPlaySession } from './play-session.js';
import { loadPhysics } from './physics.js';
import { validatePlayableScene } from './validate.js';
import { createInputSource } from './input.js';
import type { InputSource } from './input.js';
import { createHud } from './hud.js';
import type { Hud } from './hud.js';
import type { ScriptModules } from '../scripting/index.js';

export { validatePlayableScene } from './validate.js';
export { hasParkour } from './parkour.js';
export { mountCampaign } from '../game/campaign-mount.js';
export type { CampaignHandle, CampaignOptions } from '../game/campaign-mount.js';
export {
  DEFAULT_SETTINGS, MEDAL_ORDER, bestMedal, createBrowserStorage, createMemoryStorage, createProgress,
  formatSeconds, isCourseUnlocked, loadProgress, medalFor, migrateProgress, persistProgress, recordRun,
  saveKey, totalMedals, unlockedCount,
} from '../game/campaign.js';
export type {
  CampaignProgress, CampaignSettings, CampaignStorage, CourseProgress, Medal, RunOutcome,
} from '../game/campaign.js';
export type { ParkourEvent, ParkourInputState, ParkourLevel, ParkourState } from './parkour.js';
export type { CameraDef, CameraMode, CameraView } from './camera-director.js';
export type { InputSample, InputSource } from './input.js';
export type { Hud, HudSnapshot } from './hud.js';
export type { RuntimeEvent } from '../core/types.js';

export interface GameOptions {
  scripts?: ScriptModules;
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
  /** Master gain for this game's cues, 0..1. */
  setVolume?(value: number): void;
  setPaused?(value: boolean): void;
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
  const world = new Scene();
  let surface: ReturnType<typeof createRenderSurface> | undefined;
  let session: ReturnType<typeof createPlaySession> | undefined;
  let input: InputSource | null = null;
  let hud: Hud | null = null;
  try {
    const editRoot = new Group(); world.add(editRoot);
    const deps = { world, editRoot, audioContext, loadAssetBytes: options.loadAssetBytes, scripts: options.scripts,
      context: { assets: options.assets ?? [], prefabs: options.prefabs ?? [] }, input: undefined as InputSource | undefined,
      onRuntimeEvent: options.onRuntimeEvent ?? (() => undefined) };
    session = createPlaySession(deps);
    // Allocate the GPU before creating DOM input/HUD resources.
    surface = createRenderSurface(canvas, container, world, () => session!.getCamera(), dt => {
      session!.update(dt); const numbers = session!.getHud(); if (numbers) hud?.update(numbers);
    }, error => options.onRuntimeEvent?.({ type: 'fault', message: String(error) }));
    input = options.input === undefined ? createInputSource(canvas) : options.input;
    deps.input = input ?? undefined;
    if (options.hud !== false) hud = createHud(container, { label: options.title ?? snapshot.name });
    session.start(snapshot);
    const isParkour = session.getHud() !== null;
    if (hud && isParkour) hud.showOpening(options.title ?? snapshot.name.toUpperCase(), options.subtitle ?? 'run the course');
    surface.start();
    let disposed = false;
    return {
      parkour: isParkour,
      getHud: () => session!.getHud(),
      setVolume: value => session!.setVolume(value),
      setPaused: value => session!.setPaused(value),
      dispose(): void {
        if (disposed) return; disposed = true;
        surface!.dispose(); input?.dispose(); hud?.dispose(); session!.dispose(); world.clear(); canvas.remove();
        if (audioContext && audioContext.state !== 'closed') void audioContext.close();
      },
    };
  } catch (error) {
    surface?.dispose(); input?.dispose(); hud?.dispose(); session?.dispose();
    if (audioContext && audioContext.state !== 'closed') void audioContext.close();
    world.clear(); canvas.remove(); throw error;
  }
}
