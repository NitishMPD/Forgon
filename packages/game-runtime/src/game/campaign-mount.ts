// Mounts a complete campaign: lazy GPU/physics boot, one play session per course, the shell menus
// in between, and persistence on every result. Standalone-player safe; imports no editor code.

import { Group, Scene } from 'three';
import { createRenderSurface } from '../core/renderer.js';
import type { AssetRecord, CampaignDocument, PrefabDocument, SceneDocument } from '@forgon/project-schema';
import { createPlaySession } from '../runtime/play-session.js';
import { loadPhysics } from '../runtime/physics.js';
import { createInputSource } from '../runtime/input.js';
import type { InputSource } from '../runtime/input.js';
import { createHud } from '../runtime/hud.js';
import type { Hud } from '../runtime/hud.js';
import type { AssetBytesResolver, RuntimeEvent } from '../core/types.js';
import type { ScriptModules } from '../scripting/index.js';
import { createShell } from './shell.js';
import type { ResultsView, Shell } from './shell.js';
import {
  createBrowserStorage, createProgress, isCourseUnlocked, loadProgress, medalFor, persistProgress, recordRun,
} from './campaign.js';
import type { CampaignProgress, CampaignSettings, CampaignStorage } from './campaign.js';
import { validatePlayableScene } from '../runtime/validate.js';

export interface CampaignOptions {
  campaign: CampaignDocument;
  scenes: readonly SceneDocument[];
  assets?: readonly AssetRecord[];
  prefabs?: readonly PrefabDocument[];
  scripts?: ScriptModules;
  loadAssetBytes?: AssetBytesResolver;
  /** Defaults to localStorage in a browser; null keeps progress in memory for this session. */
  storage?: CampaignStorage | null;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  /** Credit line shown by the shell. */
  engineLabel?: string;
  /** Disable the in-run HUD overlay (defaults to enabled). */
  hud?: boolean;
}
export interface CampaignHandle {
  readonly progress: CampaignProgress;
  dispose(): void;
}

export async function mountCampaign(container: HTMLElement, options: CampaignOptions): Promise<CampaignHandle> {
  const { campaign } = options;
  const byId = new Map(options.scenes.map(scene => [scene.sceneId, scene]));
  const courses = campaign.courses.map(course => {
    const scene = byId.get(course.sceneId);
    if (!scene) throw new Error(`Campaign course ${course.name} has no scene ${course.sceneId}`);
    // Fail before a menu ever appears: every course must be playable as authored.
    validatePlayableScene(scene, { assets: options.assets ?? [], prefabs: options.prefabs ?? [] });
    return { course, scene };
  });
  const storage: CampaignStorage | null = options.storage === undefined ? createBrowserStorage() : options.storage;
  let progress = loadProgress(campaign, storage);

  let canvas: HTMLCanvasElement | null = null;
  let world: Scene | null = null;
  let surface: ReturnType<typeof createRenderSurface> | null = null;
  let session: ReturnType<typeof createPlaySession> | null = null;
  let input: InputSource | null = null;
  let hud: Hud | null = null;
  let audioContext: AudioContext | null = null;
  let booting: Promise<void> | null = null;
  let currentIndex = -1;
  let paused = false;
  let disposed = false;
  const deps: Parameters<typeof createPlaySession>[0] = {
    world: new Scene(), editRoot: new Group(),
    audioContext: null, loadAssetBytes: options.loadAssetBytes, scripts: options.scripts,
    context: { assets: options.assets ?? [], prefabs: options.prefabs ?? [] },
    input: undefined,
    onRuntimeEvent: event => {
      options.onRuntimeEvent?.(event);
      handleEvent(event);
    },
  };

  function handleEvent(event: RuntimeEvent): void {
    if (disposed) return;
    if (event.type === 'goal' && currentIndex >= 0) finishCourse(event.time, event.collected, event.deaths, event.total);
    else if (event.type === 'fault') {
      paused = true; session?.setPaused(true);
      shell?.showError(event.message);
    }
  }

  function persist(): void {
    persistProgress(campaign, progress, storage);
  }
  function applySettings(settings: CampaignSettings): void {
    progress = { ...progress, settings };
    session?.setVolume(settings.volume);
    input?.setSensitivity?.(settings.sensitivity);
    persist();
  }

  const shell: Shell = createShell(container, {
    campaign, progress, reducedMotion: progress.settings.reducedMotion,
    ...(options.engineLabel ? { engineLabel: options.engineLabel } : {}),
    actions: {
      play: index => { void playCourse(index); },
      resume,
      retry: () => { void playCourse(currentIndex >= 0 ? currentIndex : 0); },
      next: () => { void playCourse(currentIndex + 1); },
      quit,
      settingsChanged: applySettings,
      resetProgress: () => {
        progress = createProgress(campaign);
        shell.update(progress);
        persist();
      },
    },
  });

  async function ensureRuntime(): Promise<void> {
    if (session) return;
    if (booting) return booting;
    booting = (async () => {
      await loadPhysics();
      if (disposed) throw new Error('Campaign was disposed while loading');
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%';
      canvas.tabIndex = 0;
      canvas.setAttribute('aria-label', 'Game viewport');
      container.appendChild(canvas);
      world = new Scene();
      const editRoot = new Group();
      world.add(editRoot);
      deps.world = world; deps.editRoot = editRoot; deps.audioContext = audioContext;
      session = createPlaySession(deps);
      // The GPU is allocated before DOM input/HUD work, mirroring the standalone player.
      surface = createRenderSurface(canvas, container, world, () => session!.getCamera(), dt => {
        if (!paused) session!.update(dt);
        const numbers = session!.getHud(); if (numbers) hud?.update(numbers);
      }, error => handleEvent({ type: 'fault', message: String(error) }));
      input = createInputSource(canvas, { sensitivity: progress.settings.sensitivity });
      deps.input = input;
      session.setVolume(progress.settings.volume);
      surface.start();
    })();
    try { await booting; } catch (error) { booting = null; throw error; }
  }

  async function playCourse(index: number): Promise<void> {
    const entry = courses[index];
    if (!entry || disposed) return;
    if (!isCourseUnlocked(campaign, progress, index)) { shell.showCourses(); return; }
    // Create/resume audio inside the click gesture, before any async WASM work.
    if (!audioContext && typeof AudioContext !== 'undefined') {
      audioContext = new AudioContext();
    }
    if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => undefined);
    shell.showLoading(`Course ${String(index + 1).padStart(2, '0')} · ${entry.course.name}`);
    try {
      await ensureRuntime();
      if (disposed) return;
      deps.audioContext = audioContext;
      hud?.dispose();
      hud = options.hud === false ? null : createHud(container, {
        label: `Course ${String(index + 1).padStart(2, '0')} · ${entry.course.name}`,
        finishOverlay: false,
      });
      session!.start(entry.scene);
      session!.setVolume(progress.settings.volume);
      session!.setPaused(false);
      paused = false;
      currentIndex = index;
      progress = { ...progress, lastPlayedSceneId: entry.course.sceneId };
      persist();
      shell.hide();
      canvas?.focus();
    } catch (error) {
      shell.showError(error instanceof Error ? error.message : String(error));
    }
  }

  function finishCourse(seconds: number, shards: number, deaths: number, total: number): void {
    const entry = courses[currentIndex];
    if (!entry) return;
    const recorded = recordRun(campaign, progress, entry.course.sceneId, { seconds, shards, completed: true });
    progress = recorded.progress;
    persist();
    session?.setPaused(true);
    paused = true;
    const nextIndex = currentIndex + 1;
    const nextCourse = campaign.courses[nextIndex];
    const hasNext = Boolean(nextCourse) && isCourseUnlocked(campaign, progress, nextIndex);
    const unlocked = recorded.outcome.unlockedSceneId
      ? campaign.courses.find(course => course.sceneId === recorded.outcome.unlockedSceneId)?.name ?? null
      : null;
    const view: ResultsView = {
      courseIndex: currentIndex, courseName: entry.course.name, seconds,
      shards, totalShards: total, deaths,
      medal: medalFor(entry.course, seconds),
      bestSeconds: progress.courses[entry.course.sceneId]?.bestSeconds ?? null,
      newBest: recorded.outcome.newBest, firstClear: recorded.outcome.firstClear,
      unlockedName: unlocked, hasNext,
      nextName: nextCourse ? nextCourse.name : null,
    };
    shell.update(progress);
    shell.showResults(view);
  }

  function pause(): void {
    if (currentIndex < 0 || paused || disposed) return;
    paused = true; session?.setPaused(true);
    shell.showPause(currentIndex);
  }
  function resume(): void {
    if (!paused) return;
    if (!session?.isPlaying) { void playCourse(currentIndex >= 0 ? currentIndex : 0); return; }
    paused = false; session.setPaused(false);
    shell.hide();
    canvas?.focus();
  }
  function quit(): void {
    session?.stop();
    hud?.dispose(); hud = null;
    currentIndex = -1; paused = false;
    shell.showCourses();
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' && event.key !== 'p' && event.key !== 'P') return;
    if (event.key === 'Escape') {
      const screen = shell.screen;
      if (screen === 'pause') { resume(); return; }
      if (screen === 'settings' || screen === 'credits') { shell.back(); return; }
      if (currentIndex >= 0 && !shell.visible) { pause(); return; }
      return;
    }
    if (currentIndex < 0 || shell.visible) return;
    if (paused) resume(); else pause();
  };
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown);
  shell.showTitle();

  return {
    get progress() { return progress; },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeyDown);
      shell.dispose();
      hud?.dispose(); hud = null;
      session?.dispose();
      surface?.dispose();
      input?.dispose();
      audioContext?.close().catch(() => undefined);
      world?.clear();
      canvas?.remove();
      session = null; surface = null; input = null; canvas = null; world = null;
    },
  };
}
