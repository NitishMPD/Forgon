import { unlink } from 'node:fs/promises';
import { assetSchema, parseAssetRegistry, validateProject } from '@forgon/project-schema';
import type { AssetRecord, AssetRegistry } from '@forgon/project-schema';
import { atomicWrite, boundaryError, canonicalRoot, checkPath, encodeJson, hash, parseJson, ProjectIOError, readBytes, revision, serialized, targetPath } from './files.js';
import { readCatalog, readProject } from './read-project.js';
import { recoverPair } from './transaction.js';

export interface AssetRegistryRead { registry: AssetRegistry; revision: string }
export interface RegisterAssetRequest { asset: AssetRecord; bytes: Uint8Array; expectedRegistryRevision: string }
export type RegisterAssetResult = { status: 'saved'; asset: AssetRecord; registryRevision: string } | { status: 'conflict' };

export async function readAssetRegistry(root: string): Promise<AssetRegistryRead> {
  const canonical = await canonicalRoot(root);
  return serialized(canonical, async () => {
    await recoverPair(canonical);
    const catalog = await readProject(canonical);
    const bytes = await readBytes(canonical, catalog.manifest.assetRegistry);
    return { registry: parseAssetRegistry(parseJson(bytes)), revision: hash(bytes) };
  });
}

/** Publish a registry entry only after its create-only payload exists. */
export async function registerAsset(root: string, request: RegisterAssetRequest): Promise<RegisterAssetResult> {
  const asset = assetSchema.parse(request.asset);
  checkPath(asset.path);
  if (!asset.path.startsWith('assets/') || asset.path.split('/').length !== 2) throw new ProjectIOError('INVALID_PATH', 'Imports must use a direct assets/<filename> destination');
  const bytes = Buffer.from(request.bytes);
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new ProjectIOError('LIMIT_EXCEEDED', 'Asset must contain 1 byte to 32 MiB');
  const expected = request.expectedRegistryRevision;
  const canonical = await canonicalRoot(root);
  return serialized<RegisterAssetResult>(canonical, async () => {
    await recoverPair(canonical);
    const catalog = await readProject(canonical);
    const registryPath = catalog.manifest.assetRegistry;
    if (await revision(canonical, registryPath) !== expected) return { status: 'conflict' };
    const assets = parseAssetRegistry({ ...catalog.assets, assets: [...catalog.assets.assets, asset] });
    if (assets.assets.length > 1024) throw new ProjectIOError('LIMIT_EXCEEDED', 'Asset catalog exceeds 1024 entries');
    validateProject({ ...catalog, assets });
    const aliases = [registryPath, 'game.project.json', ...(catalog.authoring ? ['authoring/generated.json'] : []), ...catalog.manifest.scenes.map(ref => ref.path), ...catalog.manifest.prefabs.map(ref => ref.path), ...catalog.assets.assets.map(entry => entry.path), ...(catalog.authoring?.prefabBindings ?? []).map(ref => ref.path)];
    const target = await targetPath(canonical, asset.path);
    for (const path of aliases) {
      const existing = await targetPath(canonical, path);
      if ((process.platform === 'win32' ? existing.toLowerCase() === target.toLowerCase() : existing === target)) throw new ProjectIOError('ALREADY_EXISTS', 'Asset destination aliases a registered file');
    }
    const after = encodeJson(assets);
    let created = false;
    try {
      await atomicWrite(canonical, asset.path, bytes, true); created = true;
      await readCatalog(canonical, undefined, assets);
      if (hash(await readBytes(canonical, asset.path, 32 * 1024 * 1024)) !== hash(bytes)) return { status: 'conflict' };
      if (!await atomicWrite(canonical, registryPath, after, false, expected)) return { status: 'conflict' };
      created = false;
      return { status: 'saved', asset, registryRevision: hash(after) };
    } finally {
      if (created) {
        // External edits survive rollback; an orphan is safer than deleting someone else's bytes.
        if (hash(await readBytes(canonical, asset.path, 32 * 1024 * 1024)) === hash(bytes)) await unlink(await targetPath(canonical, asset.path));
      }
    }
  }).catch(error => { throw boundaryError(error); });
}
