import { mkdir, realpath, rmdir, unlink, open, lstat, readFile } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { createFixture } from '@forgon/test-fixtures';
import { canonicalRoot, checkPath, contained, ioError, missing, ProjectIOError, targetPath, boundaryError } from './files.js';
import type { CreatePlan } from './types.js';

export async function destination(root: string): Promise<string> {
  const absolute = resolve(root);
  checkPath(basename(absolute));
  return resolve(await canonicalRoot(dirname(absolute)), basename(absolute));
}
export async function planCreate(root: string, template = 'empty-3d'): Promise<CreatePlan> {
  let fixture: ReturnType<typeof createFixture>;
  try { fixture = createFixture(template); } catch (error) { throw boundaryError(error); }
  try {
    const target = await destination(root);
    try { await lstat(target); return { root: target, files: Object.keys(fixture.files), blockedReason: 'Destination already exists; choose a new project folder' }; }
    catch (error) { if (!missing(error)) throw error; }
    return { root: target, files: Object.keys(fixture.files) };
  } catch (error) { return { root, files: Object.keys(fixture.files), blockedReason: String(error) }; }
}

/** Internal creation primitive: track only our own files/directories, never recursively remove a user tree. */
export async function createFixtureFiles(root: string, files: Record<string, string | Uint8Array>, validate: () => Promise<void>): Promise<void> {
  const created: { path: string; bytes: Buffer }[] = [];
  const directories: string[] = [];
  try { await mkdir(root); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ProjectIOError('ALREADY_EXISTS', 'Project destination already exists');
    throw ioError(error);
  }
  directories.push(root);
  try {
    for (const [path, value] of Object.entries(files)) {
      checkPath(path);
      const parts = path.split('/'); parts.pop();
      let parent = root;
      for (const part of parts) {
        parent = resolve(parent, part);
        try { await mkdir(parent); directories.push(parent); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
        contained(root, await realpath(parent));
      }
      const target = await targetPath(root, path); const bytes = Buffer.from(value);
      const handle = await open(target, 'wx', 0o600);
      created.push({ path: target, bytes });
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    await validate();
  } catch (error) {
    for (const file of created.reverse()) {
      try { if ((await readFile(file.path)).equals(file.bytes)) await unlink(file.path); } catch { /* Preserve changed/unreadable files. */ }
    }
    for (const directory of directories.reverse()) await rmdir(directory).catch(() => {});
    throw ioError(error);
  }
}
