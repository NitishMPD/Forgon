/**
 * Provenance verification for the pinned T3 sidecar artifact.
 *
 * Forgon does not `npm install t3`: installing a package by name would silently resolve to
 * whatever the registry serves today, which is exactly the unpinned dependency the reuse audit
 * warns against (docs/research/t3-reuse.md §11, LICENSES/t3code.txt). Instead the caller supplies
 * one explicit artifact path plus the expected SHA-256 of its bytes, and this module refuses to
 * proceed when the digest is missing or does not match.
 *
 * The digest is of the entry file itself (a `dist/bin.mjs` script or a Node single-executable
 * binary). Hashing only that file is an honest claim about that file, not about every transitive
 * dependency it may load. The real `vp pack` output is a 1.8 kB `bin.mjs` that imports hashed
 * sibling chunks, so an entry-only digest identifies the launcher, not the running server; the
 * optional `bundle` manifest closes that gap by pinning every sibling chunk, and the returned
 * `scope` field says which of the two claims was actually made.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AgentBridgeError } from '@forgon/agent-bridge';

export interface T3Artifact {
  /** Absolute path to the T3 server entry file that will be spawned. */
  readonly entryPath: string;
  /** Lowercase or uppercase hex SHA-256 of `entryPath`'s bytes. Required. */
  readonly expectedSha256: string;
  /** The `serverVersion` the descriptor must report; checked after the sidecar starts. */
  readonly expectedServerVersion?: string;
  /** `executable` for a SEA binary; `node-script` runs under Node. Defaults to `node-script`. */
  readonly kind?: 'node-script' | 'executable';
  /**
   * Optional manifest of every sibling chunk the entry file loads, as paths relative to the
   * entry file's directory. The real `vp pack` output is a small `bin.mjs` that imports hashed
   * sibling chunks (~52 MB across 18 files), so a digest of the entry file alone identifies the
   * launcher, not the server. Supplying this verifies the whole loaded bundle.
   */
  readonly bundle?: readonly ArtifactFileDigest[];
}

/** One file's expected SHA-256, addressed relative to the entry file's directory. */
export interface ArtifactFileDigest {
  /** Forward-slash relative path, e.g. `binCli-CsDHl451.mjs`. Must not escape the entry dir. */
  readonly path: string;
  /** 64-hex SHA-256 of that file's bytes. */
  readonly sha256: string;
}

export interface ArtifactVerification {
  readonly entryPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly kind: 'node-script' | 'executable';
  /**
   * What the verification actually covered. `entry-file-only` is the honest label when no bundle
   * manifest was supplied: it proves the launcher, not every chunk it imports.
   */
  readonly scope: 'entry-file-only' | 'bundle';
  /** Number of sibling files verified when `scope === 'bundle'`. */
  readonly bundleFiles?: number;
  /** Deterministic digest of the verified bundle manifest, when `scope === 'bundle'`. */
  readonly bundleDigest?: string;
}

/** Injectable filesystem so verification is testable without writing a fake artifact to disk. */
export interface ArtifactIo {
  readonly hashFile: (filePath: string) => Promise<string>;
  readonly statFile: (filePath: string) => Promise<{ size: number; isFile: boolean }>;
  /** List immediate entry names in a directory. Required only by `hashArtifactBundle`. */
  readonly readDirectory?: (dir: string) => Promise<readonly string[]>;
}

export const defaultArtifactIo: ArtifactIo = {
  hashFile: async (filePath) => {
    const bytes = await readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  },
  statFile: async (filePath) => {
    const info = await stat(filePath);
    return { size: info.size, isFile: info.isFile() };
  },
  readDirectory: (dir) => readdir(dir),
};

/**
 * Deterministic digest of a verified manifest: SHA-256 over sorted `sha256␠␠relativePath` lines.
 * Changing any file's bytes changes its line; adding or removing a file changes the set. This is
 * the single value a caller can pin to name the whole bundle.
 */
export const bundleManifestDigest = (files: readonly ArtifactFileDigest[]): string => {
  const lines = files
    .map((file) => `${file.sha256.toLowerCase()}  ${file.path}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
};

/**
 * Hash an entry file plus every sibling it may load, producing the manifest `T3Artifact.bundle`
 * expects. Directory traversal is one level (the packed output is flat); `entry` names which file
 * is the spawn target and is included in the manifest like any other file.
 */
export const hashArtifactBundle = async (
  entryPath: string,
  io: ArtifactIo = defaultArtifactIo,
): Promise<{ entrySha256: string; bundle: readonly ArtifactFileDigest[]; bundleDigest: string }> => {
  if (io.readDirectory === undefined) {
    throw provenanceFailure('The supplied ArtifactIo cannot enumerate a directory for bundle hashing.');
  }
  const dir = path.dirname(entryPath);
  const entrySha256 = (await io.hashFile(entryPath)).toLowerCase();
  const names = await io.readDirectory(dir);
  const bundle: ArtifactFileDigest[] = [];
  for (const name of [...names].sort()) {
    const filePath = path.join(dir, name);
    const info = await io.statFile(filePath);
    if (!info.isFile) continue;
    bundle.push({ path: name.replaceAll('\\', '/'), sha256: (await io.hashFile(filePath)).toLowerCase() });
  }
  return { entrySha256, bundle, bundleDigest: bundleManifestDigest(bundle) };
};

const provenanceFailure = (detail: string): AgentBridgeError =>
  new AgentBridgeError(
    'provenance_unverified',
    'The T3 sidecar artifact could not be verified against its pinned digest.',
    { detail },
  );

export const isHexDigest = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value.trim());

/**
 * Verify an artifact's bytes and identity. Throws `provenance_unverified` when the path is not a
 * regular file, the expected digest is missing or malformed, or the computed digest differs.
 */
export const verifyArtifact = async (
  artifact: T3Artifact,
  io: ArtifactIo = defaultArtifactIo,
): Promise<ArtifactVerification> => {
  if (!path.isAbsolute(artifact.entryPath)) {
    throw provenanceFailure(`entryPath must be absolute, got "${artifact.entryPath}".`);
  }
  if (!isHexDigest(artifact.expectedSha256)) {
    throw provenanceFailure(
      'expectedSha256 must be a 64-character hex SHA-256; refusing to launch an unverified artifact.',
    );
  }

  let info: { size: number; isFile: boolean };
  try {
    info = await io.statFile(artifact.entryPath);
  } catch (cause) {
    throw provenanceFailure(
      `entryPath "${artifact.entryPath}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!info.isFile) {
    throw provenanceFailure(`entryPath "${artifact.entryPath}" is not a regular file.`);
  }

  let sha256: string;
  try {
    sha256 = (await io.hashFile(artifact.entryPath)).toLowerCase();
  } catch (cause) {
    throw provenanceFailure(
      `hashing "${artifact.entryPath}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const expected = artifact.expectedSha256.trim().toLowerCase();
  if (sha256 !== expected) {
    throw provenanceFailure(
      `SHA-256 mismatch for "${artifact.entryPath}": expected ${expected}, computed ${sha256}.`,
    );
  }

  const base: ArtifactVerification = {
    entryPath: artifact.entryPath,
    sha256,
    sizeBytes: info.size,
    kind: artifact.kind ?? 'node-script',
    scope: 'entry-file-only',
  };
  if (artifact.bundle === undefined) return base;
  return { ...base, ...(await verifyBundleManifest(artifact.entryPath, artifact.bundle, io)) };
};

/**
 * Verify every sibling chunk named by a bundle manifest and return the manifest digest. The entry
 * file may appear in the manifest too; it is re-hashed here so the manifest is self-contained.
 */
const verifyBundleManifest = async (
  entryPath: string,
  manifest: readonly ArtifactFileDigest[],
  io: ArtifactIo,
): Promise<Pick<ArtifactVerification, 'scope' | 'bundleFiles' | 'bundleDigest'>> => {
  if (manifest.length === 0) {
    throw provenanceFailure('An empty bundle manifest proves nothing; omit `bundle` or list its files.');
  }
  const dir = path.dirname(entryPath);
  const resolvedDir = path.resolve(dir);
  const verified: ArtifactFileDigest[] = [];
  for (const file of manifest) {
    if (!isHexDigest(file.sha256)) {
      throw provenanceFailure(`Bundle entry "${file.path}" has a malformed SHA-256.`);
    }
    const filePath = path.resolve(dir, file.path);
    const relative = path.relative(resolvedDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.length === 0) {
      throw provenanceFailure(`Bundle entry "${file.path}" escapes the entry directory; refusing.`);
    }
    let fileInfo: { size: number; isFile: boolean };
    try {
      fileInfo = await io.statFile(filePath);
    } catch (cause) {
      throw provenanceFailure(
        `Bundle entry "${file.path}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!fileInfo.isFile) throw provenanceFailure(`Bundle entry "${file.path}" is not a regular file.`);
    const hash = (await io.hashFile(filePath)).toLowerCase();
    if (hash !== file.sha256.trim().toLowerCase()) {
      throw provenanceFailure(
        `SHA-256 mismatch for bundle entry "${file.path}": expected ${file.sha256.trim().toLowerCase()}, computed ${hash}.`,
      );
    }
    verified.push({ path: file.path.replaceAll('\\', '/'), sha256: hash });
  }
  return { scope: 'bundle', bundleFiles: verified.length, bundleDigest: bundleManifestDigest(verified) };
};

/** Compare a running server's advertised version with the pinned expectation. */
export const assertServerVersion = (expected: string | undefined, actual: string): void => {
  if (expected === undefined || expected === actual) return;
  throw provenanceFailure(
    `The running T3 server reports version "${actual}", but the pinned artifact expects "${expected}".`,
  );
};
