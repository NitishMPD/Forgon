import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseScene, validateProject } from '@forgon/project-schema';
import type { SaveSceneRequest, SaveSceneResult, SceneRead, SceneWatchEvent, SceneIO } from '@forgon/project-schema';
import { captureOverrides, parseAuthoringArtifact, replayOverrides } from '@forgon/procedural-authoring';
import type { AuthoringArtifact } from '@forgon/procedural-authoring';
import type { AssetRead, AuthoringRead, NodeProjectSession, ReadProject, SaveAuthoringRequest, SaveAuthoringResult } from './types.js';
import { atomicWrite, boundaryError, encodeJson, hash, missing, parseJson, ProjectIOError, readBytes, revision, serialized, targetPath } from './files.js';
import { readProject, readCatalog } from './read-project.js';
import { AUTHORING, recoverPair, writePair } from './transaction.js';

function replayScene(artifact: AuthoringArtifact) {
  const replay = replayOverrides(artifact);
  if (replay.conflicts.length || !replay.scene) throw new ProjectIOError('AUTHORING_CONFLICT', JSON.stringify(replay.conflicts));
  return replay.scene;
}
export class ProjectSession implements NodeProjectSession {
  #closed = false;
  #stops = new Set<() => void>();
  #catalog: ReadProject;
  readonly sceneIO: SceneIO;
  constructor(readonly root: string, catalog: ReadProject) {
    this.#catalog = catalog;
    this.sceneIO = { readScene: path => this.readScene(path).catch(error => { throw boundaryError(error); }), saveScene: request => this.saveScene(request).catch(error => { throw boundaryError(error); }), watchScene: (path, listener) => this.watchScene(path, listener) };
  }
  get manifest() { return structuredClone(this.#catalog.manifest); }
  get assets() { return structuredClone(this.#catalog.assets.assets); }
  get prefabs() { return structuredClone(this.#catalog.prefabs); }
  private assertOpen(): void { if (this.#closed) throw new ProjectIOError('CLOSED', 'Project session is closed'); }
  async readCatalog(): Promise<ReadProject> {
    return serialized(this.root, async () => { this.assertOpen(); await recoverPair(this.root); return this.catalog(); });
  }
  private async catalog(): Promise<ReadProject> {
    this.#catalog = await readProject(this.root);
    return structuredClone(this.#catalog);
  }
  private sceneRef(catalog: ReadProject, path: string) {
    const ref = catalog.manifest.scenes.find(ref => ref.path === path);
    if (!ref) throw new ProjectIOError('INVALID_PATH', 'Only registered scene paths are accessible');
    return ref;
  }
  private async readScene(path: string): Promise<SceneRead> {
    return serialized(this.root, async () => {
      this.assertOpen(); await recoverPair(this.root);
      const catalog = await this.catalog();
      return this.sceneBytes(catalog, path);
    });
  }
  private async sceneBytes(catalog: ReadProject, path: string): Promise<SceneRead> {
    const ref = this.sceneRef(catalog, path);
    const bytes = await readBytes(this.root, path);
    const document = parseScene(parseJson(bytes), { assets: catalog.assets.assets, prefabs: catalog.prefabs });
    if (document.sceneId !== ref.id) throw new ProjectIOError('INVALID_DOCUMENT', 'Scene identity differs from manifest');
    validateProject({ ...catalog, scenes: catalog.scenes.map(scene => scene.sceneId === document.sceneId ? document : scene) });
    return { document, revision: hash(bytes) };
  }
  async readAuthoring(): Promise<AuthoringRead | null> {
    return serialized(this.root, async () => {
      this.assertOpen(); await recoverPair(this.root);
      try { const bytes = await readBytes(this.root, AUTHORING); return { document: parseAuthoringArtifact(parseJson(bytes)), revision: hash(bytes) }; }
      catch (error) { if (missing(error)) return null; throw boundaryError(error); }
    });
  }
  private async saveScene(request: SaveSceneRequest): Promise<SaveSceneResult> {
    request = parseJson(encodeJson(request)) as SaveSceneRequest;
    return serialized(this.root, async () => {
      this.assertOpen(); await recoverPair(this.root);
      this.sceneRef(this.#catalog, request.path);
      const absent = await revision(this.root, request.path) === null;
      if (absent && request.expectedRevision !== null) return { status: 'conflict', current: null };
      const catalog = absent ? await readCatalog(this.root, { path: request.path, document: request.document }) : await this.catalog();
      const ref = this.sceneRef(catalog, request.path);
      const document = parseScene(request.document, { assets: catalog.assets.assets, prefabs: catalog.prefabs });
      if (document.sceneId !== ref.id) throw new ProjectIOError('INVALID_DOCUMENT', 'Cannot change registered scene identity');
      validateProject({ ...catalog, scenes: catalog.scenes.map(scene => scene.sceneId === document.sceneId ? document : scene) });
      if (absent) {
        if (catalog.authoring?.base.sceneId === document.sceneId) throw new ProjectIOError('AUTHORING_CONFLICT', 'Recover deleted generated scene explicitly before saving');
        try { await atomicWrite(this.root, request.path, encodeJson(document), true); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return { status: 'conflict', current: await this.sceneBytes(await this.catalog(), request.path) };
          throw error;
        }
        return { status: 'saved', revision: hash(encodeJson(document)) };
      }
      const current = await this.sceneBytes(catalog, request.path);
      if (current.revision !== request.expectedRevision) return { status: 'conflict', current };
      const bytes = encodeJson(document);
      if (catalog.authoring?.base.sceneId === document.sceneId) {
        if (!isDeepStrictEqual(replayScene(catalog.authoring), current.document)) throw new ProjectIOError('UNRECORDED_CHANGES', 'Record external manual edits before saving generated scene');
        let authoring: AuthoringArtifact;
        try { authoring = captureOverrides(catalog.authoring, document); }
        catch (error) { throw new ProjectIOError('AUTHORING_CONFLICT', String(error), { cause: error }); }
        const before = await readBytes(this.root, request.path);
        const authoringBefore = await readBytes(this.root, AUTHORING);
        if (hash(before) !== request.expectedRevision || !isDeepStrictEqual(parseAuthoringArtifact(parseJson(authoringBefore)), catalog.authoring)) return { status: 'conflict', current: await this.sceneBytes(await this.catalog(), request.path) };
        if (!await writePair(this.root, request.path, before, bytes, authoringBefore, encodeJson(authoring))) return { status: 'conflict', current: await this.sceneBytes(await this.catalog(), request.path) };
      } else {
        if (await revision(this.root, request.path) !== request.expectedRevision) return { status: 'conflict', current: await this.sceneBytes(await this.catalog(), request.path) };
        if (!await atomicWrite(this.root, request.path, bytes, false, request.expectedRevision)) return { status: 'conflict', current: await this.sceneBytes(await this.catalog(), request.path) };
      }
      return { status: 'saved', revision: hash(bytes) };
    });
  }
  async saveAuthoring(request: SaveAuthoringRequest): Promise<SaveAuthoringResult> {
    request = parseJson(encodeJson(request, 4 * 1024 * 1024)) as SaveAuthoringRequest;
    return serialized<SaveAuthoringResult>(this.root, async () => {
      this.assertOpen(); await recoverPair(this.root);
      const catalog = await this.catalog(); this.sceneRef(catalog, request.path);
      const before = await readBytes(this.root, request.path); const authoringBefore = await readBytes(this.root, AUTHORING);
      if (hash(before) !== request.expectedRevision || hash(authoringBefore) !== request.expectedAuthoringRevision) return { status: 'conflict' };
      const old = parseAuthoringArtifact(parseJson(authoringBefore));
      const document = parseScene(request.scene, { assets: catalog.assets.assets, prefabs: catalog.prefabs });
      const authoring = parseAuthoringArtifact(request.authoring);
      if (document.sceneId !== this.sceneRef(catalog, request.path).id || old.base.sceneId !== document.sceneId || authoring.base.sceneId !== document.sceneId || old.generator.id !== authoring.generator.id) throw new ProjectIOError('AUTHORING_CONFLICT', 'Pair identity cannot change');
      if (!isDeepStrictEqual(replayScene(old), parseScene(parseJson(before)))) throw new ProjectIOError('UNRECORDED_CHANGES', 'Saved scene differs from recorded overrides');
      if (!isDeepStrictEqual(replayScene(authoring), document)) throw new ProjectIOError('AUTHORING_CONFLICT', 'Proposed scene differs from override replay');
      parseScene(authoring.base, { assets: catalog.assets.assets, prefabs: catalog.prefabs });
      // Binding declarations are immutable in a pair save; registry/binding edits need their own validated project operation.
      if (!isDeepStrictEqual(old.prefabBindings, authoring.prefabBindings)) throw new ProjectIOError('AUTHORING_CONFLICT', 'Cannot change prefab binding catalog in pair save');
      validateProject({ ...catalog, scenes: catalog.scenes.map(scene => scene.sceneId === document.sceneId ? document : scene) });
      const after = encodeJson(document); const authoringAfter = encodeJson(authoring);
      return await writePair(this.root, request.path, before, after, authoringBefore, authoringAfter)
        ? { status: 'saved', revision: hash(after), authoringRevision: hash(authoringAfter) } : { status: 'conflict' };
    }).catch(error => { throw boundaryError(error); });
  }
  async readAsset(assetId: string): Promise<AssetRead> {
    this.assertOpen();
    const catalog = await this.readCatalog();
    const asset = catalog.assets.assets.find(asset => asset.id === assetId);
    if (!asset) throw new ProjectIOError('NOT_FOUND', 'Unknown registered asset ID');
    const bytes = await readBytes(this.root, asset.path, 32 * 1024 * 1024);
    return { asset: structuredClone(asset), bytes, revision: hash(bytes) };
  }
  private watchScene(path: string, listener: (event: SceneWatchEvent) => void): () => void {
    this.assertOpen(); this.sceneRef(this.#catalog, path);
    let stopped = false; let busy = false; let previous = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = (event: SceneWatchEvent, key: string): void => {
      if (stopped || this.#closed || key === previous) return;
      previous = key;
      try { listener(event); } catch { /* A subscriber cannot terminate filesystem monitoring. */ }
    };
    const check = async (): Promise<void> => {
      if (stopped || busy) return;
      busy = true;
      try {
        const value = await this.readScene(path);
        emit({ type: 'changed', value }, value.revision);
      } catch (error) {
        if (stopped) return;
        // Missing a dependency is invalid; only a missing scene is a deletion.
        let deleted = false;
        try { deleted = await revision(this.root, path) === null; } catch { /* Invalid bytes/paths remain invalid. */ }
        if (deleted) emit({ type: 'deleted' }, 'deleted');
        else emit({ type: 'invalid', diagnostics: [{ path, message: String(error) }] }, `invalid:${String(error)}`);
      } finally { busy = false; }
    };
    const schedule = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(() => void check(), 50); };
    let watcher: ReturnType<typeof watch> | undefined;
    void targetPath(this.root, path).then(target => {
      if (stopped) return;
      try { watcher = watch(dirname(target), schedule); watcher.on('error', schedule); } catch { /* Poll fallback covers removed directories. */ }
    }).catch(schedule);
    const interval = setInterval(schedule, 250);
    const stop = (): void => { stopped = true; watcher?.close(); clearInterval(interval); if (timer) clearTimeout(timer); this.#stops.delete(stop); };
    this.#stops.add(stop); schedule();
    return stop;
  }
  close(): void { this.#closed = true; for (const stop of this.#stops) stop(); }
}
