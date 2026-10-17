import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { createId } from '@forgon/project-schema';
import { ProjectIOError, readAssetRegistry, registerAsset } from '@forgon/project-io/node';
import type { RegisterAssetResult } from '@forgon/project-io/node';
import { validateAsset } from './validate.js';
export { validateAsset } from './validate.js';

export interface ImportAssetRequest {
  sourcePath: string; license: string; source?: string; name?: string; id?: string; destination?: string;
  expectedRegistryRevision: string;
}
export { readAssetRegistry };
export async function importAsset(root: string, request: ImportAssetRequest): Promise<RegisterAssetResult> {
  const info = await lstat(request.sourcePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new ProjectIOError('INVALID_PATH', 'Import source must be a regular nonsymlink file');
  const handle = await open(request.sourcePath, 'r');
  let bytes: Buffer;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > 32 * 1024 * 1024 || current.ino !== info.ino || current.dev !== info.dev) throw new ProjectIOError('INVALID_PATH', 'Import source changed or exceeds 32 MiB');
    const buffer = Buffer.alloc(32 * 1024 * 1024 + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > 32 * 1024 * 1024) throw new ProjectIOError('LIMIT_EXCEEDED', 'Import source exceeds 32 MiB');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const extension = extname(request.sourcePath).toLowerCase();
  const kind = validateAsset(bytes, extension);
  const id = request.id ?? createId('asset');
  const destination = request.destination ?? `assets/${id}${extension}`;
  if (extname(destination).toLowerCase() !== extension) throw new ProjectIOError('INVALID_DOCUMENT', 'Destination extension must match source');
  return registerAsset(root, { asset: { id, name: request.name ?? basename(request.sourcePath), kind, path: destination,
    provenance: { source: request.source ?? basename(request.sourcePath), license: request.license, hash: createHash('sha256').update(bytes).digest('hex') } }, bytes, expectedRegistryRevision: request.expectedRegistryRevision });
}
