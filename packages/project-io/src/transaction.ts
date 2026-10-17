import { unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parseProjectManifest, parseScene } from '@forgon/project-schema';
import { parseAuthoringArtifact, replayOverrides } from '@forgon/procedural-authoring';
import { atomicWrite, encodeJson, hash, missing, parseJson, ProjectIOError, readBytes, revision, targetPath } from './files.js';

export const JOURNAL = '.forgon-transaction.json';
export const AUTHORING = 'authoring/generated.json';
const JOURNAL_LIMIT = 12 * 1024 * 1024;
interface Journal { version: 1; scenePath: string; sceneBefore: string; sceneAfter: string; authoringBefore: string; authoringAfter: string }

/** Recovery is rollback, idempotent even if interrupted between restoring the two originals. */
export async function recoverPair(root: string): Promise<boolean> {
  let bytes: Buffer;
  try { bytes = await readBytes(root, JOURNAL, JOURNAL_LIMIT); } catch (error) { if (missing(error)) return false; throw error; }
  try {
    const value = parseJson(bytes) as Journal;
    if (!value || value.version !== 1 || Object.keys(value).sort().join() !== ['version', 'scenePath', 'sceneBefore', 'sceneAfter', 'authoringBefore', 'authoringAfter'].sort().join()) throw new Error('Invalid journal shape');
    const manifest = parseProjectManifest(parseJson(await readBytes(root, 'game.project.json')));
    if (!manifest.scenes.some(ref => ref.path === value.scenePath) || value.scenePath === AUTHORING) throw new Error('Unregistered recovery target');
    const decode = (source: string): Buffer => {
      if (typeof source !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) throw new Error('Invalid journal bytes');
      const decoded = Buffer.from(source, 'base64');
      if (decoded.length > 2 * 1024 * 1024) throw new Error('Journal document exceeds limit');
      return decoded;
    };
    const sceneBefore = decode(value.sceneBefore); const sceneAfter = decode(value.sceneAfter);
    const authoringBefore = decode(value.authoringBefore); const authoringAfter = decode(value.authoringAfter);
    for (const [sceneBytes, artifactBytes] of [[sceneBefore, authoringBefore], [sceneAfter, authoringAfter]] as const) {
      const scene = parseScene(parseJson(sceneBytes));
      const artifact = parseAuthoringArtifact(parseJson(artifactBytes));
      const replay = replayOverrides(artifact);
      if (scene.sceneId !== manifest.scenes.find(ref => ref.path === value.scenePath)!.id || replay.conflicts.length || !isDeepStrictEqual(replay.scene, scene)) throw new Error('Invalid recovery pair identity/replay');
    }
    const pairs = [[value.scenePath, sceneBefore, sceneAfter], [AUTHORING, authoringBefore, authoringAfter]] as const;
    // Inspect both before restoring either: an unrelated external version must never be overwritten.
    for (const [path, before, after] of pairs) {
      const current = await revision(root, path);
      if (current !== hash(before) && current !== hash(after)) throw new Error(`Unrecognized external version: ${path}`);
    }
    for (const [path, before, after] of pairs) {
      const current = await revision(root, path);
      if (current === hash(before)) continue;
      if (current !== hash(after)) throw new Error(`External change during recovery: ${path}`);
      if (!await atomicWrite(root, path, before, false, hash(after))) throw new Error(`External change during recovery: ${path}`);
    }
    await unlink(await targetPath(root, JOURNAL));
    return true;
  } catch (error) { throw new ProjectIOError('RECOVERY_CONFLICT', `Recovery stopped; preserve journal and files: ${String(error)}`, { cause: error }); }
}

export async function writePair(root: string, scenePath: string, sceneBefore: Buffer, sceneAfter: Buffer, authoringBefore: Buffer, authoringAfter: Buffer): Promise<boolean> {
  if (await revision(root, scenePath) !== hash(sceneBefore) || await revision(root, AUTHORING) !== hash(authoringBefore)) return false;
  const journal: Journal = { version: 1, scenePath, sceneBefore: sceneBefore.toString('base64'), sceneAfter: sceneAfter.toString('base64'),
    authoringBefore: authoringBefore.toString('base64'), authoringAfter: authoringAfter.toString('base64') };
  await atomicWrite(root, JOURNAL, encodeJson(journal, JOURNAL_LIMIT), true);
  try {
    if (await revision(root, scenePath) !== hash(sceneBefore) || await revision(root, AUTHORING) !== hash(authoringBefore)) {
      // No source was changed by us; the journal cannot authorize rollback of an external version.
      await unlink(await targetPath(root, JOURNAL));
      return false;
    }
    if (!await atomicWrite(root, scenePath, sceneAfter, false, hash(sceneBefore))) throw new ProjectIOError('RECOVERY_CONFLICT', 'Scene changed during pair save');
    if (await revision(root, AUTHORING) !== hash(authoringBefore)) throw new ProjectIOError('RECOVERY_CONFLICT', 'Authoring changed during pair save');
    if (!await atomicWrite(root, AUTHORING, authoringAfter, false, hash(authoringBefore))) throw new ProjectIOError('RECOVERY_CONFLICT', 'Authoring changed during pair save');
    await unlink(await targetPath(root, JOURNAL));
    return true;
  } catch (error) {
    try { await recoverPair(root); } catch (recovery) { throw recovery; }
    throw error;
  }
}
