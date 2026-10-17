import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntity, createScene, parseScene, type SaveSceneRequest, type SaveSceneResult, type SceneDocument, type SceneIO, type SceneRead, type SceneWatchEvent } from '@forgon/project-schema';
import { SceneHost, SceneSession } from '../src/session/sceneSession.js';
import type { LogInput } from '../src/model/consoleLog.js';

interface Held<T> { resolve(value: T): void; reject(error: unknown): void }

// A SceneIO whose reads and saves can be held, so tests control the interleavings.
class FakeSceneIO implements SceneIO {
  files = new Map<string, SceneRead>();
  heldReads: Array<{ path: string } & Held<SceneRead>> = [];
  holdReads = new Set<string>();
  heldSaves: Array<{ result: SaveSceneResult; resolve(value: SaveSceneResult): void }> = [];
  holdSaves = false;
  saveRequests: SaveSceneRequest[] = [];
  listeners = new Map<string, Set<(event: SceneWatchEvent) => void>>();
  watchCount = 0;
  unwatchCount = 0;
  #revision = 0;

  nextRevision(): string {
    this.#revision++;
    return `rev-${this.#revision}`;
  }

  seed(path: string, document: SceneDocument): string {
    const revision = this.nextRevision();
    this.files.set(path, { document, revision });
    return revision;
  }

  readScene(path: string): Promise<SceneRead> {
    const file = this.files.get(path);
    if (!file) return Promise.reject(new Error(`missing ${path}`));
    if (this.holdReads.has(path)) {
      return new Promise<SceneRead>((resolve, reject) => { this.heldReads.push({ path, resolve, reject }); });
    }
    return Promise.resolve(structuredClone(file));
  }

  // The bytes reach disk when the host commits, before the caller hears the answer. A held save
  // models only the delay in reporting that answer.
  saveScene(request: SaveSceneRequest): Promise<SaveSceneResult> {
    this.saveRequests.push(request);
    const current = this.files.get(request.path);
    let result: SaveSceneResult;
    if ((current?.revision ?? null) !== request.expectedRevision) {
      result = { status: 'conflict', current: current ? structuredClone(current) : null };
    } else {
      const revision = this.nextRevision();
      this.files.set(request.path, { document: structuredClone(request.document), revision });
      result = { status: 'saved', revision };
    }
    if (!this.holdSaves) return Promise.resolve(result);
    return new Promise<SaveSceneResult>(resolve => { this.heldSaves.push({ result, resolve }); });
  }

  finishHeldSave(): void {
    const held = this.heldSaves.shift();
    if (!held) throw new Error('no held save');
    held.resolve(held.result);
  }

  watchScene(path: string, listener: (event: SceneWatchEvent) => void): () => void {
    this.watchCount++;
    const set = this.listeners.get(path) ?? new Set();
    set.add(listener);
    this.listeners.set(path, set);
    return () => {
      this.unwatchCount++;
      set.delete(listener);
    };
  }

  emit(path: string, event: SceneWatchEvent): void {
    for (const listener of [...(this.listeners.get(path) ?? [])]) listener(event);
  }

  // Simulates an external writer: updates disk and notifies watchers with the new bytes.
  externalWrite(path: string, document: SceneDocument): string {
    const revision = this.nextRevision();
    const read = { document: structuredClone(document), revision };
    this.files.set(path, read);
    this.emit(path, { type: 'changed', value: structuredClone(read) });
    return revision;
  }
}

function scene(name: string): SceneDocument {
  const root = createEntity(name);
  const child = createEntity('Desk', root.id);
  return parseScene({ ...createScene('Lobby'), sceneId: 'scene_lobby', entities: [root, child] });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));
}

function collector() {
  const entries: LogInput[] = [];
  return { entries, log: (entry: LogInput) => { entries.push(entry); } };
}

test('opening a scene reads it, attaches a watcher, and becomes ready with the disk revision', async () => {
  const io = new FakeSceneIO();
  const first = scene('Lobby');
  const revision = io.seed('scenes/lobby.scene.json', first);
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  assert.equal(session.phase, 'loading');
  await flush();
  assert.equal(session.phase, 'ready');
  assert.equal(session.store?.revision, revision);
  assert.equal(session.dirty, false);
  assert.equal(io.watchCount, 1);
  session.dispose();
  assert.equal(io.unwatchCount, 1);
});

test('a superseded load never replaces the shown scene, and its watcher is released', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/a.scene.json', scene('A'));
  io.seed('scenes/b.scene.json', scene('B'));
  io.holdReads.add('scenes/a.scene.json');
  const { log } = collector();
  const host = new SceneHost({ io, context: {}, log });
  host.open('scenes/a.scene.json');
  host.open('scenes/b.scene.json');
  await flush();
  assert.equal(host.shown?.path, 'scenes/b.scene.json');
  assert.equal(host.candidate, null);
  const late = io.heldReads.find(item => item.path === 'scenes/a.scene.json')!;
  late.resolve({ document: scene('Late A'), revision: 'rev-late' });
  await flush();
  assert.equal(host.shown?.path, 'scenes/b.scene.json', 'a late A must not replace B');
  assert.equal(host.shown?.store?.scene.entities[0]?.name, 'B');
  assert.equal(io.unwatchCount, 1, 'A watcher was released when superseded');
  host.dispose();
});

test('a failed open keeps the current scene on screen and reports a notice until dismissed', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const host = new SceneHost({ io, context: {}, log });
  host.open('scenes/lobby.scene.json');
  await flush();
  host.open('scenes/missing.scene.json');
  await flush();
  assert.equal(host.shown?.path, 'scenes/lobby.scene.json');
  assert.match(host.notice ?? '', /Could not read scenes\/missing\.scene\.json/);
  host.dismissNotice();
  assert.equal(host.notice, null);
  host.dispose();
});

test('a change that lands during the first read is replayed after the load, never dropped', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Old'));
  io.holdReads.add('scenes/lobby.scene.json');
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  const newer = scene('Newer');
  io.externalWrite('scenes/lobby.scene.json', newer);
  io.heldReads[0]!.resolve({ document: scene('Old'), revision: 'rev-old' });
  await flush();
  assert.equal(session.phase, 'ready');
  assert.equal(session.store?.scene.entities[0]?.name, 'Newer');
  session.dispose();
});

test('save sends a detached copy with the expected revision and acknowledges the committed revision', async () => {
  const io = new FakeSceneIO();
  const revision = io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  const root = session.store!.scene.entities[0]!;
  assert.equal(session.execute({ type: 'rename', entityId: root.id, name: 'Renamed' }), true);
  assert.equal(session.dirty, true);
  assert.equal(await session.save(), true);
  assert.equal(io.saveRequests[0]?.expectedRevision, revision);
  assert.equal(io.saveRequests[0]?.path, 'scenes/lobby.scene.json');
  assert.equal(session.dirty, false);
  assert.equal(session.saveStatus, 'saved');
  assert.notEqual(session.store?.revision, revision);
  session.dispose();
});

test('a stale save returns the current disk scene, keeps the local edit as a conflict, and blocks further saves', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log, entries } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  const root = session.store!.scene.entities[0]!;
  session.execute({ type: 'rename', entityId: root.id, name: 'Mine' });
  // Disk changes behind the editor, but the watcher is not delivered before the save is attempted.
  io.files.set('scenes/lobby.scene.json', { document: scene('Theirs'), revision: 'rev-theirs' });
  assert.equal(await session.save(), false);
  assert.equal(session.saveStatus, 'failed');
  assert.equal(session.conflict?.revision, 'rev-theirs');
  assert.equal(session.saveDisabledReason, 'Resolve the file conflict first.');
  assert.equal(await session.save(), false, 'save stays blocked while the conflict is open');
  assert.ok(entries.some(entry => entry.severity === 'warning' && /Save stopped/.test(entry.message)));
  session.resolveConflict('theirs');
  assert.equal(session.store?.scene.entities[0]?.name, 'Theirs');
  assert.equal(session.dirty, false, 'taking the file version clears the local edit');
  session.dispose();
});

test('a save that finds the file missing or invalid overwrites nothing and reports the reason', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  session.execute({ type: 'rename', entityId: session.store!.scene.entities[0]!.id, name: 'Mine' });
  io.files.delete('scenes/lobby.scene.json');
  assert.equal(await session.save(), false);
  assert.equal(io.files.has('scenes/lobby.scene.json'), false);
  assert.match(session.banner?.kind === 'invalid' ? session.banner.diagnostics[0]?.message ?? '' : '', /Nothing was overwritten/);
  session.dispose();
});

test('a watcher event for the save already on disk arrives before the save resolves, and the save is acknowledged once', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  session.execute({ type: 'rename', entityId: session.store!.scene.entities[0]!.id, name: 'Saved name' });
  io.holdSaves = true;
  const saving = session.save();
  // The bytes are already on disk; the watcher reports them before the save promise settles.
  const onDisk = io.files.get('scenes/lobby.scene.json')!;
  io.emit('scenes/lobby.scene.json', { type: 'changed', value: structuredClone(onDisk) });
  assert.equal(session.dirty, false);
  assert.equal(session.store?.revision, onDisk.revision);
  io.finishHeldSave();
  assert.equal(await saving, true);
  assert.equal(session.dirty, false);
  assert.equal(session.store?.revision, onDisk.revision);
  session.dispose();
});

test('edits made while a save is in flight stay dirty after the save is acknowledged', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  const root = session.store!.scene.entities[0]!;
  session.execute({ type: 'rename', entityId: root.id, name: 'First' });
  io.holdSaves = true;
  const saving = session.save();
  session.execute({ type: 'rename', entityId: root.id, name: 'Second' });
  io.finishHeldSave();
  assert.equal(await saving, false, 'newer edits prevent save-and-switch from discarding them');
  assert.equal(session.dirty, true);
  assert.equal(session.store?.scene.entities[0]?.name, 'Second');
  assert.equal(session.store?.canUndo, true, 'undo of the newer edit is still available');
  session.dispose();
});

test('invalid and deleted watch events keep the last valid scene and clear once the file is valid again', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  io.emit('scenes/lobby.scene.json', { type: 'invalid', diagnostics: [{ path: 'entities.0.transform', message: 'Expected number' }] });
  assert.equal(session.banner?.kind, 'invalid');
  assert.equal(session.store?.scene.entities[0]?.name, 'Lobby');
  io.emit('scenes/lobby.scene.json', { type: 'deleted' });
  assert.deepEqual(session.banner, { kind: 'deleted', path: 'scenes/lobby.scene.json' });
  assert.equal(session.saveDisabledReason, 'The scene file was removed. Restore it on disk before saving.');
  assert.equal(await session.save(), false);
  io.externalWrite('scenes/lobby.scene.json', scene('Restored'));
  assert.equal(session.banner, null);
  assert.equal(session.store?.scene.entities[0]?.name, 'Restored');
  session.dispose();
});

test('an external change to a clean scene reloads, and a change to a dirty scene asks the user to choose', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log, entries } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  await flush();
  io.externalWrite('scenes/lobby.scene.json', scene('Clean reload'));
  assert.equal(session.store?.scene.entities[0]?.name, 'Clean reload');
  session.execute({ type: 'rename', entityId: session.store!.scene.entities[0]!.id, name: 'Mine' });
  io.externalWrite('scenes/lobby.scene.json', scene('Their edit'));
  assert.equal(session.conflict !== null, true);
  assert.equal(session.store?.scene.entities[0]?.name, 'Mine', 'the dirty edit is retained, never overwritten');
  assert.ok(entries.some(entry => /Choose which version to keep/.test(entry.message)));
  session.dispose();
});

test('dispose releases the watcher, ignores late events and late reads, and refuses saves', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  io.holdReads.add('scenes/lobby.scene.json');
  const { log } = collector();
  const session = SceneSession.open({ io, path: 'scenes/lobby.scene.json', context: {}, log });
  session.dispose();
  assert.equal(io.unwatchCount, 1);
  io.heldReads[0]!.resolve({ document: scene('Late'), revision: 'rev-late' });
  await flush();
  assert.equal(session.store, null, 'a read that completes after dispose creates no store');
  io.emit('scenes/lobby.scene.json', { type: 'deleted' });
  assert.equal(session.banner, null);
  assert.equal(await session.save(), false);
});

test('the in-memory sample is editable, never saved, and says why', async () => {
  const { log } = collector();
  const session = SceneSession.memory(scene('Sample'), log);
  assert.equal(session.phase, 'ready');
  assert.equal(session.saveDisabledReason, 'The in-memory sample is not saved to disk.');
  assert.equal(await session.save(), false);
  assert.equal(session.execute({ type: 'rename', entityId: session.store!.scene.entities[0]!.id, name: 'Edited' }), true);
  assert.equal(session.dirty, true);
});

test('host subscribers hear about changes to the shown scene, not only about switches', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/lobby.scene.json', scene('Lobby'));
  const { log } = collector();
  const host = new SceneHost({ io, context: {}, log });
  host.open('scenes/lobby.scene.json');
  await flush();
  const seen: number[] = [];
  const unsubscribe = host.subscribe(() => seen.push(host.version));
  io.externalWrite('scenes/lobby.scene.json', scene('Changed'));
  assert.ok(seen.length > 0, 'an external reload notifies the host');
  unsubscribe();
  host.dispose();
});

test('a candidate that fails before the shown scene is ready leaves the host with a failure and no shown scene', async () => {
  const io = new FakeSceneIO();
  const { log } = collector();
  const host = new SceneHost({ io, context: {}, log });
  host.open('scenes/none.scene.json');
  await flush();
  assert.equal(host.shown, null);
  assert.match(host.notice ?? '', /Could not read/);
  host.dispose();
});

 test('edits during a candidate load keep the edited scene instead of silently replacing it', async () => {
  const io = new FakeSceneIO();
  io.seed('scenes/one.json', scene('One'));
  io.seed('scenes/two.json', scene('Two'));
  const host = new SceneHost({ io, context: {}, log() {} });
  host.open('scenes/one.json'); await flush();
  io.holdReads.add('scenes/two.json');
  host.open('scenes/two.json');
  host.shown!.execute({ type: 'rename', entityId: host.shown!.store!.scene.entities[0]!.id, name: 'Keep this' });
  const held = io.heldReads[0]!;
  held.resolve(structuredClone(io.files.get(held.path)!)); await flush();
  assert.equal(host.shown!.path, 'scenes/one.json');
  assert.equal(host.shown!.store!.scene.entities[0]!.name, 'Keep this');
  assert.match(host.notice!, /current scene changed/);
  host.dispose();
});
