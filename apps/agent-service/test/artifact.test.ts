import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isAgentBridgeError } from '@forgon/agent-bridge';
import {
  assertServerVersion,
  bundleManifestDigest,
  hashArtifactBundle,
  isHexDigest,
  verifyArtifact,
  type ArtifactIo,
} from '../src/index.js';

const DIGEST = 'a'.repeat(64);
const entry = path.resolve('C:/forgon/t3/dist/bin.mjs');

const io = (overrides: Partial<ArtifactIo> = {}): ArtifactIo => ({
  hashFile: async () => DIGEST,
  statFile: async () => ({ size: 12_345, isFile: true }),
  ...overrides,
});

const provenance = (error: unknown): boolean =>
  isAgentBridgeError(error) && error.code === 'provenance_unverified';

test('isHexDigest accepts only 64 hex characters', () => {
  assert.equal(isHexDigest(DIGEST), true);
  assert.equal(isHexDigest('A'.repeat(64)), true);
  assert.equal(isHexDigest('abcd'), false);
  assert.equal(isHexDigest('z'.repeat(64)), false);
});

test('verifyArtifact returns the digest, size and kind on a match', async () => {
  const verification = await verifyArtifact({ entryPath: entry, expectedSha256: DIGEST }, io());
  assert.deepEqual(verification, { entryPath: entry, sha256: DIGEST, sizeBytes: 12_345, kind: 'node-script', scope: 'entry-file-only' });
});

test('verifyArtifact accepts an uppercase expected digest and normalises it', async () => {
  const verification = await verifyArtifact(
    { entryPath: entry, expectedSha256: DIGEST.toUpperCase() },
    io(),
  );
  assert.equal(verification.sha256, DIGEST);
});

test('a relative entry path is refused', async () => {
  await assert.rejects(
    verifyArtifact({ entryPath: 'dist/bin.mjs', expectedSha256: DIGEST }, io()),
    provenance,
  );
});

test('a missing or malformed digest is refused before touching the file', async () => {
  let statted = false;
  const spy = io({ statFile: async () => { statted = true; return { size: 1, isFile: true }; } });
  await assert.rejects(verifyArtifact({ entryPath: entry, expectedSha256: '' }, spy), provenance);
  await assert.rejects(verifyArtifact({ entryPath: entry, expectedSha256: 'nope' }, spy), provenance);
  assert.equal(statted, false);
});

test('a non-file entry path is refused', async () => {
  await assert.rejects(
    verifyArtifact({ entryPath: entry, expectedSha256: DIGEST }, io({ statFile: async () => ({ size: 0, isFile: false }) })),
    provenance,
  );
});

test('an unreadable entry path is refused with the cause', async () => {
  await assert.rejects(
    verifyArtifact(
      { entryPath: entry, expectedSha256: DIGEST },
      io({ statFile: async () => { throw new Error('ENOENT'); } }),
    ),
    provenance,
  );
});

test('a digest mismatch is refused and names both digests', async () => {
  await assert.rejects(
    verifyArtifact({ entryPath: entry, expectedSha256: DIGEST }, io({ hashFile: async () => 'b'.repeat(64) })),
    (error: unknown) =>
      isAgentBridgeError(error) &&
      error.code === 'provenance_unverified' &&
      /expected a{64}, computed b{64}/.test(error.detail ?? ''),
  );
});

test('a hashing failure is refused', async () => {
  await assert.rejects(
    verifyArtifact({ entryPath: entry, expectedSha256: DIGEST }, io({ hashFile: async () => { throw new Error('EIO'); } })),
    provenance,
  );
});

test('an executable artifact keeps its kind', async () => {
  const verification = await verifyArtifact(
    { entryPath: entry, expectedSha256: DIGEST, kind: 'executable' },
    io(),
  );
  assert.equal(verification.kind, 'executable');
});

test('assertServerVersion refuses a version that does not match the pin', () => {
  assert.doesNotThrow(() => assertServerVersion(undefined, '1.2.3'));
  assert.doesNotThrow(() => assertServerVersion('1.2.3', '1.2.3'));
  assert.throws(() => assertServerVersion('1.2.3', '9.9.9'), provenance);
});

const CHUNK = 'b'.repeat(64);

test('verifyArtifact labels an entry-only check honestly and drops bundle fields', async () => {
  const verification = await verifyArtifact({ entryPath: entry, expectedSha256: DIGEST }, io());
  assert.equal(verification.scope, 'entry-file-only');
  assert.equal(verification.bundleFiles, undefined);
  assert.equal(verification.bundleDigest, undefined);
});

test('verifyArtifact verifies every bundle chunk and reports the manifest digest', async () => {
  const manifest = [
    { path: 'bin.mjs', sha256: DIGEST },
    { path: 'binCli-CsDHl451.mjs', sha256: CHUNK },
  ];
  const verification = await verifyArtifact(
    { entryPath: entry, expectedSha256: DIGEST, bundle: manifest },
    io({ hashFile: async (filePath) => (filePath.endsWith('binCli-CsDHl451.mjs') ? CHUNK : DIGEST) }),
  );
  assert.equal(verification.scope, 'bundle');
  assert.equal(verification.bundleFiles, 2);
  assert.equal(verification.bundleDigest, bundleManifestDigest(manifest));
});

test('an empty bundle manifest proves nothing and is refused', async () => {
  await assert.rejects(
    verifyArtifact({ entryPath: entry, expectedSha256: DIGEST, bundle: [] }, io()),
    provenance,
  );
});

test('a bundle entry with a malformed digest or an escaping path is refused', async () => {
  await assert.rejects(
    verifyArtifact({ entryPath: entry, expectedSha256: DIGEST, bundle: [{ path: 'x.mjs', sha256: 'nope' }] }, io()),
    provenance,
  );
  await assert.rejects(
    verifyArtifact(
      { entryPath: entry, expectedSha256: DIGEST, bundle: [{ path: '../evil.mjs', sha256: CHUNK }] },
      io(),
    ),
    provenance,
  );
});

test('a bundle entry whose bytes differ from its digest is refused and names the file', async () => {
  await assert.rejects(
    verifyArtifact(
      { entryPath: entry, expectedSha256: DIGEST, bundle: [{ path: 'chunk-a.mjs', sha256: CHUNK }] },
      io(),
    ),
    (error: unknown) =>
      provenance(error) && /chunk-a\.mjs/.test((error as { detail?: string }).detail ?? ''),
  );
});

test('a bundle entry that is not a regular file is refused', async () => {
  await assert.rejects(
    verifyArtifact(
      { entryPath: entry, expectedSha256: DIGEST, bundle: [{ path: 'sub', sha256: CHUNK }] },
      io({ statFile: async () => ({ size: 0, isFile: false }) }),
    ),
    provenance,
  );
});

test('hashArtifactBundle enumerates only real files, normalises paths and pins the entry', async () => {
  const seen: string[] = [];
  const result = await hashArtifactBundle(entry, {
    hashFile: async (filePath) => {
      seen.push(path.basename(filePath));
      return path.basename(filePath) === 'bin.mjs' ? DIGEST : CHUNK;
    },
    statFile: async (filePath) => ({ size: 1, isFile: path.basename(filePath) !== 'sub' }),
    readDirectory: async () => ['bin.mjs', 'binCli-CsDHl451.mjs', 'sub'],
  });

  assert.equal(result.entrySha256, DIGEST);
  assert.deepEqual(
    result.bundle.map((file) => file.path),
    ['bin.mjs', 'binCli-CsDHl451.mjs'],
  );
  assert.equal(result.bundleDigest, bundleManifestDigest(result.bundle));
  assert.ok(seen.includes('bin.mjs'));
});

test('bundleManifestDigest is order-independent and content-sensitive', () => {
  const a = [{ path: 'a.mjs', sha256: DIGEST }];
  const b = [{ path: 'b.mjs', sha256: CHUNK }];
  assert.equal(bundleManifestDigest([...a, ...b]), bundleManifestDigest([...b, ...a]));
  assert.notEqual(bundleManifestDigest(a), bundleManifestDigest(b));
  assert.notEqual(
    bundleManifestDigest(a),
    bundleManifestDigest([{ path: 'a.mjs', sha256: CHUNK }]),
  );
});
