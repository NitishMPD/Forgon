import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, stat, rename, unlink, link } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, dirname, basename } from 'node:path';
import type { ProjectIOErrorCode } from './types.js';

export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export class ProjectIOError extends Error {
  constructor(readonly code: ProjectIOErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ProjectIOError'; }
}
export const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'NOT_FOUND');
export function ioError(error: unknown): ProjectIOError {
  if (error instanceof ProjectIOError) return error;
  return new ProjectIOError(missing(error) ? 'NOT_FOUND' : 'IO_ERROR', error instanceof Error ? error.message : String(error), { cause: error });
}
export function boundaryError(error: unknown): ProjectIOError {
  if (error instanceof ProjectIOError) return error;
  if (error instanceof Error && 'code' in error) return ioError(error);
  return new ProjectIOError('INVALID_DOCUMENT', error instanceof Error ? error.message : String(error), { cause: error });
}
export function checkPath(path: string): void {
  if (typeof path !== 'string' || !path || /[\\:\x00-\x1f<>"|?*]/.test(path) || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new ProjectIOError('INVALID_PATH', `Unsafe project-relative path: ${path}`);
  }
}
export function contained(root: string, target: string, allowRoot = false): void {
  const child = relative(root, target);
  if ((!child && !allowRoot) || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new ProjectIOError('INVALID_PATH', 'Path escapes canonical project root');
}
export async function targetPath(root: string, path: string): Promise<string> {
  checkPath(path);
  try {
    const target = await realpath(resolve(root, ...path.split('/')));
    contained(root, target);
    return target;
  } catch (error) {
    if (!missing(error)) throw ioError(error);
    const parent = await realpath(dirname(resolve(root, ...path.split('/'))));
    contained(root, parent, true);
    return resolve(parent, basename(path));
  }
}
export async function readBytes(root: string, path: string, limit = MAX_JSON_BYTES): Promise<Buffer> {
  try {
    const target = await targetPath(root, path);
    const handle = await open(target, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ProjectIOError('INVALID_PATH', `Not a regular file: ${path}`);
      if (info.size > limit) throw new ProjectIOError('LIMIT_EXCEEDED', `File exceeds ${limit} bytes: ${path}`);
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new ProjectIOError('LIMIT_EXCEEDED', `File exceeds ${limit} bytes: ${path}`);
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  } catch (error) { throw ioError(error); }
}
export function parseJson(bytes: Uint8Array): unknown {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let depth = 0; let quoted = false; let escaped = false;
    for (const character of source) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') { if (++depth > 64) throw new Error('JSON nesting exceeds 64'); }
      else if (character === '}' || character === ']') depth--;
    }
    return JSON.parse(source) as unknown;
  } catch (error) { throw new ProjectIOError('INVALID_DOCUMENT', String(error), { cause: error }); }
}
export function encodeJson(value: unknown, limit = MAX_JSON_BYTES): Buffer {
  let bytes: Buffer;
  try { bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
  catch (error) { throw boundaryError(error); }
  if (bytes.length > limit) throw new ProjectIOError('LIMIT_EXCEEDED', 'Serialized document exceeds byte limit');
  parseJson(bytes);
  return bytes;
}
export async function revision(root: string, path: string): Promise<string | null> {
  try { return hash(await readBytes(root, path)); } catch (error) { if (missing(error)) return null; throw error; }
}
export async function atomicWrite(root: string, path: string, bytes: Uint8Array, createOnly = false, expectedRevision?: string | null): Promise<boolean> {
  const target = await targetPath(root, path);
  const temp = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Recheck canonical parents immediately before mutation; Node has no portable directory-handle-relative rename.
    if (await targetPath(root, path) !== target) throw new ProjectIOError('INVALID_PATH', 'Destination changed during save');
    if (expectedRevision !== undefined && await revision(root, path) !== expectedRevision) return false;
    if (createOnly) await link(temp, target);
    else await rename(temp, target);
    return true;
  } finally { if (created) await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
}
const queues = new Map<string, Promise<unknown>>();
export async function serialized<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
export async function canonicalRoot(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new ProjectIOError('INVALID_PATH', 'Project root must be a directory');
    return canonical;
  } catch (error) { throw ioError(error); }
}
