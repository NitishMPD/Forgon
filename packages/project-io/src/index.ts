export type * from './types.js';
export { ProjectIOError } from './files.js';
export { ProjectReader, readProject } from './read-project.js';
export { planCreate } from './create.js';
export { createNodeProjectHost } from './host.js';
export { readAssetRegistry, registerAsset } from './assets.js';
export type { AssetRegistryRead, RegisterAssetRequest, RegisterAssetResult } from './assets.js';
import { createFixture } from '@forgon/test-fixtures';
import { canonicalRoot, serialized, boundaryError } from './files.js';
import { readProject } from './read-project.js';
import { recoverPair } from './transaction.js';
import { ProjectSession } from './session.js';
import { createFixtureFiles, destination } from './create.js';
import type { NodeProjectSession } from './types.js';

export async function openProject(root: string): Promise<NodeProjectSession> {
  const canonical = await canonicalRoot(root);
  return serialized(canonical, async () => {
    await recoverPair(canonical);
    return new ProjectSession(canonical, await readProject(canonical));
  });
}
export async function createProject(root: string, template = 'empty-3d'): Promise<NodeProjectSession> {
  const target = await destination(root);
  return serialized(target, async () => {
    const fixture = createFixture(template);
    await createFixtureFiles(target, fixture.files, async () => { await readProject(target); });
    return new ProjectSession(target, await readProject(target));
  }).catch(error => { throw boundaryError(error); });
}
