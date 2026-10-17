import { stat } from 'node:fs/promises';
import { canonicalRoot, targetPath, readBytes, parseJson, encodeJson, ProjectIOError, missing, boundaryError } from './files.js';

import { parseAssetRegistry, parsePrefab, parseProjectManifest, parseScene, validateProject } from '@forgon/project-schema';
import type { AssetRegistry, PrefabDocument, SceneDocument } from '@forgon/project-schema';
import { instantiatePrefab, parseAuthoringArtifact, prefabBindingsSchema, replayOverrides, stableId } from '@forgon/procedural-authoring';
import type { AuthoringArtifact } from '@forgon/procedural-authoring';


import type { ReadProject } from './types.js';
const MAX_DOCUMENTS = 128;
const MAX_ASSETS = 1024;
export class ProjectReader {
  #bytes = 0;
  #documents = 0;
  private constructor(readonly root: string) {}
  static async create(root: string): Promise<ProjectReader> { return new ProjectReader(await canonicalRoot(root)); }
  async containedPath(path: string): Promise<string> { return targetPath(this.root, path); }
  async asset(path: string): Promise<void> {
    const target = await this.containedPath(path);
    if (!(await stat(target)).isFile()) throw new ProjectIOError('INVALID_PATH', `Asset is not a regular file: ${path}`);
  }
  async json(path: string, replacement?: unknown): Promise<unknown> {
    if (++this.#documents > MAX_DOCUMENTS) throw new ProjectIOError('LIMIT_EXCEEDED', 'Project document count exceeds 128');
    const bytes = replacement === undefined ? await readBytes(this.root, path) : encodeJson(replacement);
    if ((this.#bytes += bytes.length) > 16 * 1024 * 1024) throw new ProjectIOError('LIMIT_EXCEEDED', 'Project JSON exceeds 16 MiB');
    return parseJson(bytes);
  }
}
export async function readProject(root: string): Promise<ReadProject> {
  try { return await readCatalog(root); } catch (error) { throw boundaryError(error); }
}

/** Internal replacement validates a complete prospective catalog when creating a missing registered scene. */
export async function readCatalog(root: string, replacement?: { path: string; document: SceneDocument }, assetReplacement?: AssetRegistry): Promise<ReadProject> {
  const reader = await ProjectReader.create(root);
  const manifest = parseProjectManifest(await reader.json('game.project.json'));
  if (manifest.scenes.length + manifest.prefabs.length > MAX_DOCUMENTS - 3) throw new ProjectIOError('LIMIT_EXCEEDED', 'Project catalog exceeds document limit');
  const assets = parseAssetRegistry(await reader.json(manifest.assetRegistry, assetReplacement));
  if (assets.assets.length > MAX_ASSETS) throw new ProjectIOError('LIMIT_EXCEEDED', 'Asset catalog exceeds 1024 entries');
  const physical = new Set<string>();
  const claim = async (path: string): Promise<void> => {
    if (path === '.forgon-transaction.json') throw new ProjectIOError('INVALID_PATH', 'Catalog uses reserved journal path');
    const target = await reader.containedPath(path);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (physical.has(key)) throw new ProjectIOError('INVALID_PATH', `Catalog files alias each other: ${path}`);
    physical.add(key);
  };
  for (const path of ['game.project.json', manifest.assetRegistry, ...manifest.scenes.map(ref => ref.path), ...manifest.prefabs.map(ref => ref.path)]) await claim(path);
  const prefabs: PrefabDocument[] = [];
  for (const ref of manifest.prefabs) {
    const prefab = parsePrefab(await reader.json(ref.path));
    if (prefab.prefabId !== ref.id) throw new Error(`Prefab identity does not match manifest path ${ref.path}`);
    prefabs.push(prefab);
  }
  const scenes: SceneDocument[] = [];
  for (const ref of manifest.scenes) {
    const scene = parseScene(replacement?.path === ref.path ? replacement.document : await reader.json(ref.path));
    if (scene.sceneId !== ref.id) throw new Error(`Scene identity does not match manifest path ${ref.path}`);
    scenes.push(scene);
  }
  validateProject({ manifest, scenes, prefabs, assets });
  for (const asset of assets.assets) { await reader.asset(asset.path); }
  let authoring: AuthoringArtifact | undefined;
  try { authoring = parseAuthoringArtifact(await reader.json('authoring/generated.json')); }
  catch (error) { if (!missing(error)) throw error; }
  if (authoring && !scenes.some(scene => scene.sceneId === authoring.base.sceneId)) throw new Error('Authoring artifact scene is not registered');
  if (authoring) {
    await claim('authoring/generated.json');
    for (const ref of authoring.prefabBindings ?? []) {
      await claim(ref.path);
      const prefab = prefabs.find(prefab => prefab.prefabId === ref.prefabId);
      if (!prefab) throw new Error(`Binding catalog references missing prefab ${ref.prefabId}`);
      const bindings = prefabBindingsSchema.parse(await reader.json(ref.path));
      instantiatePrefab(prefab, stableId('cli-validation', prefab.prefabId), bindings);
    }
    parseScene(authoring.base, { assets: assets.assets, prefabs });
    const replay = replayOverrides(authoring);
    if (replay.conflicts.length || !replay.scene) throw new Error(`Invalid authoring overrides: ${JSON.stringify(replay.conflicts)}`);
    parseScene(replay.scene, { assets: assets.assets, prefabs });
  }
  return { manifest, scenes, prefabs, assets, ...(authoring ? { authoring } : {}) };
}

