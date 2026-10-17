import { EditorStore, type SceneCommand, type SceneConflict } from '@forgon/editor-core';
import type { SceneDocument, SceneIO, SceneRead, SceneWatchEvent, ValidationContext } from '@forgon/project-schema';
import type { LogInput } from '../model/consoleLog.js';
import type { FileBanner, SaveStatus } from '../model/fileState.js';

// Lifecycle of one open scene: read, watch, edit through the store, save, dispose.
// Plain TypeScript so the stale-load, watch and save ordering can be tested without a DOM.

export type SceneSessionPhase = 'loading' | 'ready' | 'failed';

export interface SceneSessionOptions {
  io: SceneIO;
  path: string;
  context: ValidationContext;
  log(entry: LogInput): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SceneSession {
  readonly path: string | null;
  readonly #io: SceneIO | null;
  readonly #context: ValidationContext;
  readonly #log: (entry: LogInput) => void;
  #phase: SceneSessionPhase = 'loading';
  #failure: string | null = null;
  #store: EditorStore | null = null;
  #banner: FileBanner | null = null;
  #saveStatus: SaveStatus = 'idle';
  #saving = false;
  #saveError: string | null = null;
  #disposed = false;
  #loadToken = 0;
  #unwatch: (() => void) | null = null;
  #pendingEvents: SceneWatchEvent[] = [];
  #version = 0;
  readonly #listeners = new Set<() => void>();

  private constructor(options: { io: SceneIO | null; path: string | null; context: ValidationContext; log(entry: LogInput): void }) {
    this.#io = options.io;
    this.path = options.path;
    this.#context = options.context;
    this.#log = options.log;
  }

  // A project scene read from the host. Loading starts immediately; observe `phase` for the outcome.
  static open(options: SceneSessionOptions): SceneSession {
    const session = new SceneSession({ io: options.io, path: options.path, context: options.context, log: options.log });
    session.#load();
    return session;
  }

  // An in-memory scene with no file. It can be edited but never saved.
  static memory(scene: SceneDocument, log: (entry: LogInput) => void): SceneSession {
    const session = new SceneSession({ io: null, path: null, context: {}, log });
    session.#store = new EditorStore(scene, null);
    session.#phase = 'ready';
    return session;
  }

  get phase(): SceneSessionPhase { return this.#phase; }
  get failure(): string | null { return this.#failure; }
  get store(): EditorStore | null { return this.#store; }
  get banner(): FileBanner | null { return this.#banner; }
  get saveStatus(): SaveStatus { return this.#saveStatus; }
  get disposed(): boolean { return this.#disposed; }
  get version(): number { return this.#version; }
  get saveError(): string | null { return this.#saveError; }
  get dirty(): boolean { return this.#store?.dirty ?? false; }
  get conflict(): SceneConflict | null { return this.#store?.conflict ?? null; }

  get saveDisabledReason(): string | null {
    if (this.#io === null) return 'The in-memory sample is not saved to disk.';
    if (this.conflict !== null) return 'Resolve the file conflict first.';
    if (this.#banner?.kind === 'deleted') return 'The scene file was removed. Restore it on disk before saving.';
    return null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #notify(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }

  #load(): void {
    const io = this.#io;
    const path = this.path;
    if (io === null || path === null) return;
    const token = ++this.#loadToken;
    try {
      // Watch before reading so a change between the read and the subscription is not missed.
      this.#unwatch = io.watchScene(path, event => this.#onWatch(event));
    } catch (error) {
      this.#fail(`Could not watch ${path}: ${messageOf(error)}`);
      this.#log({ source: 'project', severity: 'error', message: this.#failure ?? 'Could not watch the scene.', file: path });
      return;
    }
    let pending: Promise<SceneRead>;
    try {
      pending = io.readScene(path);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      read => {
        if (this.#disposed || token !== this.#loadToken) return;
        try {
          this.#store = new EditorStore(read.document, read.revision, this.#context);
          this.#phase = 'ready';
          this.#failure = null;
        } catch (error) {
          this.#fail(`The scene does not match the project catalogs: ${messageOf(error)}`);
          return;
        }
        this.#notify();
        const queued = this.#pendingEvents;
        this.#pendingEvents = [];
        for (const event of queued) this.#onWatch(event);
      },
      (error: unknown) => {
        if (this.#disposed || token !== this.#loadToken) return;
        this.#fail(`Could not read ${path}: ${messageOf(error)}`);
        this.#log({ source: 'project', severity: 'error', message: this.#failure ?? 'Could not read the scene.', file: path });
      },
    );
  }

  #fail(message: string): void {
    this.#phase = 'failed';
    this.#failure = message;
    this.#unwatch?.();
    this.#unwatch = null;
    this.#notify();
  }

  // Watch callbacks are notifications. They reconcile through the store and never overwrite dirty work.
  #onWatch(event: SceneWatchEvent): void {
    if (this.#disposed) return;
    const store = this.#store;
    const path = this.path;
    if (store === null || path === null) {
      this.#pendingEvents.push(event);
      return;
    }
    if (event.type === 'changed') {
      this.#banner = null;
      try {
        const result = store.reconcile(event.value.document, event.value.revision);
        if (result === 'conflict') {
          this.#log({ source: 'save', severity: 'warning', message: 'The file changed on disk while you have unsaved edits. Choose which version to keep.', file: path });
        }
      } catch (error) {
        this.#banner = { kind: 'invalid', diagnostics: [{ path, message: messageOf(error) }] };
        this.#log({ source: 'schema', severity: 'error', message: messageOf(error), file: path });
      }
    } else if (event.type === 'invalid') {
      this.#banner = { kind: 'invalid', diagnostics: event.diagnostics };
      const first = event.diagnostics[0];
      this.#log({ source: 'schema', severity: 'error', message: first ? `${first.path}: ${first.message}` : 'Scene file is not valid.', file: path });
    } else {
      this.#banner = { kind: 'deleted', path };
      this.#log({ source: 'project', severity: 'error', message: 'Scene file was removed on disk. Showing the last valid scene.', file: path });
    }
    this.#notify();
  }

  // Resolves true when nothing is left unsaved for this file. Callers use it before switching scenes.
  async save(): Promise<boolean> {
    const io = this.#io;
    const path = this.path;
    const store = this.#store;
    if (io === null || path === null || store === null || this.#phase !== 'ready' || this.#disposed) return false;
    if (this.#saving) return false;
    if (store.conflict !== null || this.#banner?.kind === 'deleted') return false;
    if (!store.dirty) { this.#saveError = null; this.#notify(); return true; }
    this.#saving = true;
    this.#saveStatus = 'saving';
    this.#saveError = null;
    this.#notify();
    try {
      // The original snapshot is kept for acknowledgement; the host receives a copy.
      const snapshot = store.prepareSave();
      const result = await io.saveScene({ ...snapshot, path });
      if (result.status === 'saved') {
        store.acknowledgeSave(snapshot, result.revision);
        this.#saveStatus = 'saved';
        this.#log({ source: 'save', severity: 'info', message: 'Saved scene.', file: path });
        return !store.dirty;
      }
      this.#saveStatus = 'failed';
      this.#saveError = 'Save stopped because the disk file changed. Your edits are still here.';
      if (result.current) {
        store.reconcile(result.current.document, result.current.revision);
        this.#log({ source: 'save', severity: 'warning', message: 'Save stopped: the file changed on disk. Choose which version to keep.', file: path });
      } else {
        this.#banner = { kind: 'invalid', diagnostics: [{ path, message: 'The file on disk is missing or not a valid scene. Nothing was overwritten.' }] };
        this.#log({ source: 'save', severity: 'error', message: 'Save stopped: the file on disk is missing or not a valid scene.', file: path });
      }
      return false;
    } catch (error) {
      this.#saveStatus = 'failed';
      const detail = messageOf(error);
      const generated = /AUTHORING_CONFLICT|UNRECORDED_CHANGES|generated|overrides|structural/i.test(detail);
      this.#saveError = `Save failed: ${detail}. Your edits are still here.${generated ? ' Generated objects support existing property overrides; structural changes must be made in the generator and baked explicitly.' : ''}`;
      this.#log({ source: 'save', severity: 'error', message: this.#saveError, file: path });
      return false;
    } finally {
      this.#saving = false;
      this.#notify();
    }
  }

  updateContext(context: ValidationContext): void {
    this.#store?.updateContext(context);
    Object.assign(this.#context, structuredClone(context));
  }

  execute(command: SceneCommand): boolean {
    if (this.#store === null) return false;
    try {
      this.#store.execute(command);
      return true;
    } catch (error) {
      this.#log({ source: 'editor', severity: 'error', message: messageOf(error) });
      return false;
    }
  }

  undo(): void {
    this.#store?.undo();
  }

  redo(): void {
    this.#store?.redo();
  }

  resolveConflict(choice: 'ours' | 'theirs'): void {
    if (this.#store === null) return;
    try {
      this.#store.resolveConflict(choice);
      this.#log({
        source: 'save',
        severity: 'info',
        message: choice === 'ours' ? 'Kept your edit. It is unsaved until you save.' : 'Used the file version. Your unsaved edit was discarded.',
        ...(this.path !== null ? { file: this.path } : {}),
      });
    } catch (error) {
      this.#log({ source: 'editor', severity: 'error', message: messageOf(error) });
    }
  }

  dismissBanner(): void {
    this.#banner = null;
    this.#notify();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loadToken++;
    this.#unwatch?.();
    this.#unwatch = null;
    this.#pendingEvents = [];
    this.#listeners.clear();
  }
}

export type SceneHostNotice = string | null;

// Owns the scene on screen plus at most one candidate being opened. A candidate replaces the shown
// scene only after it loads. A failed or superseded candidate never replaces it.
export class SceneHost {
  readonly #options: { io: SceneIO | null; context: ValidationContext; log(entry: LogInput): void };
  #shown: SceneSession | null = null;
  #shownUnsubscribe: (() => void) | null = null;
  #candidate: SceneSession | null = null;
  #candidateUnsubscribe: (() => void) | null = null;
  #candidateSource: string | null = null;
  #notice: SceneHostNotice = null;
  #version = 0;
  readonly #listeners = new Set<() => void>();

  constructor(options: { io: SceneIO | null; context: ValidationContext; log(entry: LogInput): void }) {
    this.#options = options;
  }

  get shown(): SceneSession | null { return this.#shown; }
  get candidate(): SceneSession | null { return this.#candidate; }
  get notice(): SceneHostNotice { return this.#notice; }
  get version(): number { return this.#version; }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #notify(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }

  // The shown session's own changes (banner, save status, store) reach host subscribers too.
  #show(session: SceneSession | null): void {
    this.#shownUnsubscribe?.();
    this.#shownUnsubscribe = session?.subscribe(() => this.#notify()) ?? null;
    this.#shown = session;
  }

  updateContext(context: ValidationContext): void {
    this.#shown?.updateContext(context);
    this.#candidate?.updateContext(context);
    this.#options.context = structuredClone(context);
  }

  dismissNotice(): void {
    if (this.#notice === null) return;
    this.#notice = null;
    this.#notify();
  }

  // Used for the in-memory sample, which has no project file to open.
  showMemory(scene: SceneDocument): void {
    this.#show(SceneSession.memory(scene, this.#options.log));
    this.#notify();
  }

  open(path: string): void {
    const io = this.#options.io;
    if (io === null) return;
    if (this.#candidate?.path === path) return;
    if (this.#candidate === null && this.#shown?.path === path) return;
    this.#dropCandidate();
    this.#notice = null;
    const next = SceneSession.open({ io, path, context: this.#options.context, log: this.#options.log });
    this.#candidate = next;
    this.#candidateSource = this.#shown?.store ? JSON.stringify(this.#shown.store.scene) : null;
    this.#candidateUnsubscribe = next.subscribe(() => this.#settle(next));
    this.#notify();
    this.#settle(next);
  }

  #dropCandidate(): void {
    this.#candidateUnsubscribe?.();
    this.#candidateUnsubscribe = null;
    this.#candidate?.dispose();
    this.#candidate = null;
  }

  #settle(session: SceneSession): void {
    if (session !== this.#candidate) return;
    if (session.phase === 'loading') return;
    this.#candidateUnsubscribe?.();
    this.#candidateUnsubscribe = null;
    this.#candidate = null;
    if (session.phase === 'ready') {
      if (this.#shown?.store && JSON.stringify(this.#shown.store.scene) !== this.#candidateSource) {
        this.#notice = 'The current scene changed while the next scene loaded. Your edits are still here; switch again when ready.';
        session.dispose();
        this.#notify();
        return;
      }
      const previous = this.#shown;
      this.#show(session);
      previous?.dispose();
    } else {
      this.#notice = session.failure ?? 'The scene could not be opened.';
      session.dispose();
    }
    this.#notify();
  }

  dispose(): void {
    this.#dropCandidate();
    this.#shownUnsubscribe?.();
    this.#shownUnsubscribe = null;
    this.#shown?.dispose();
    this.#shown = null;
    this.#listeners.clear();
  }
}
