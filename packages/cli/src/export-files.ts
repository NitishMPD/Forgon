import { createHash } from 'node:crypto';
import fs, { lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export async function outputDestination(output: string): Promise<string> {
  if (!output || output.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('Output path cannot contain dot traversal');
  const absolute = resolve(output);
  const name = basename(absolute);
  if (!name || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Unsafe output directory name');
  const parent = await realpath(dirname(absolute));
  const target = join(parent, name);
  try { await lstat(target); throw new Error('Output already exists; choose a nonexistent output directory'); }
  catch (error) { if (!missing(error)) throw error; }
  return target;
}

function artifactPath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe artifact path: ${path}`);
  const target = resolve(root, path);
  const child = relative(root, target);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error(`Artifact path escapes output: ${path}`);
  return target;
}

/** Stage privately, claim output exclusively, and remove only tracked unchanged files on failure. */
export async function publishArtifact(output: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  const destination = await outputDestination(output);
  const stage = await mkdtemp(join(dirname(destination), '.forgon-export-'));
  const staged: string[] = [];
  const directories = new Set<string>([stage]);
  const published: { path: string; hash: string }[] = [];
  const outputDirectories: string[] = [];
  const makeParents = async (root: string, path: string, track: (path: string) => void): Promise<void> => {
    const parts = path.split('/'); parts.pop();
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      try { await mkdir(parent); track(parent); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      if (await realpath(parent) !== parent) throw new Error('Artifact parent changed during publication');
    }
  };
  try {
    for (const [path, bytes] of files) {
      const target = artifactPath(stage, path);
      await makeParents(stage, path, path => directories.add(path));
      await writeFile(target, bytes, { flag: 'wx' }); staged.push(target);
    }
    if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error('Output parent changed during build');
    await mkdir(destination); outputDirectories.push(destination);
    for (const [path, bytes] of files) {
      if (await realpath(destination) !== destination) throw new Error('Output directory changed during publication');
      const target = artifactPath(destination, path);
      await makeParents(destination, path, path => outputDirectories.push(path));
      // Same-volume hard links publish complete bytes atomically and refuse existing files.
      await fs.link(artifactPath(stage, path), target);
      published.push({ path: target, hash: sha256(bytes) });
    }
  } catch (error) {
    for (const file of published.reverse()) {
      try {
        if (await realpath(destination) === destination && await realpath(file.path) === file.path && sha256(await readFile(file.path)) === file.hash) await unlink(file.path);
      } catch { /* Preserve changed or unreadable user files. */ }
    }
    for (const directory of outputDirectories.reverse()) await rmdir(directory).catch(() => {});
    throw error;
  } finally {
    for (const file of staged.reverse()) await unlink(file).catch(() => {});
    for (const directory of [...directories].reverse()) await rmdir(directory).catch(() => {});
  }
}

export async function readAssetBytes(path: string): Promise<Uint8Array> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const limit = 256 * 1024 * 1024;
    if (!info.isFile() || info.size > limit) throw new Error('Registered asset must be a regular file at most 256 MiB');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== info.size) throw new Error('Registered asset changed while being read');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
