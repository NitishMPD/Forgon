import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, writeFile, rm, symlink, mkdir, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProject, openProject, registerAsset } from '@forgon/project-io/node';
import { importAsset, readAssetRegistry, validateAsset } from '../src/index.js';

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), 'forgon-assets-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'game'); const session = await createProject(root, 'hotel'); session.close();
  const wav = await readFile(join(root, 'assets/reception.wav'));
  const sourcePath = join(parent, 'source.wav'); await writeFile(sourcePath, wav);
  const request = { sourcePath, license: 'CC0-1.0', source: 'Original recording', id: 'imported_audio', expectedRegistryRevision: (await readAssetRegistry(root)).revision };
  return { parent, root, wav, request };
}
function glb(document: unknown, binary?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(document)); const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + (binary ? binary.length + 8 : 0), 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  if (!binary) return Buffer.concat([header, padded]);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, binary]);
}

test('imports exact bytes, stable metadata and provenance; reopened registered reads work', async t => {
  const { root, wav, request } = await setup(t);
  const result = await importAsset(root, request); assert.equal(result.status, 'saved'); if (result.status !== 'saved') return;
  assert.equal(result.asset.id, request.id); assert.equal(result.asset.kind, 'audio');
  assert.deepEqual(result.asset.provenance, { source: request.source, license: request.license, hash: createHash('sha256').update(wav).digest('hex') });
  const reopened = await openProject(root);
  try { assert.deepEqual(Buffer.from((await reopened.readAsset(request.id)).bytes), wav); } finally { reopened.close(); }
  assert.deepEqual(await readFile(request.sourcePath), wav);
});

test('stale registry revisions, stable ID reimport and destination collisions preserve originals', async t => {
  const { root, request, wav } = await setup(t); const before = await readFile(join(root, 'assets/registry.json'));
  assert.deepEqual(await importAsset(root, { ...request, expectedRegistryRevision: 'stale' }), { status: 'conflict' });
  assert.deepEqual(await readFile(join(root, 'assets/registry.json')), before);
  await importAsset(root, request);
  const fresh = (await readAssetRegistry(root)).revision;
  await assert.rejects(importAsset(root, { ...request, expectedRegistryRevision: fresh }), /Duplicate/);
  await assert.rejects(importAsset(root, { ...request, id: 'other_audio', destination: 'assets/reception.wav', expectedRegistryRevision: fresh }), /aliases/);
  await writeFile(join(root, 'assets/unregistered.wav'), wav);
  await assert.rejects(importAsset(root, { ...request, id: 'other_audio', destination: 'assets/unregistered.wav', expectedRegistryRevision: fresh }));
  assert.deepEqual(await readFile(join(root, 'assets/unregistered.wav')), wav);
});

test('invalid formats, extension mismatch, empty, oversized, SVG and malformed GLB are refused before writes', async t => {
  const { parent, root, request, wav } = await setup(t); const before = await readFile(join(root, 'assets/registry.json'));
  for (const [extension, bytes] of [['.wav', Buffer.from('RIFF')], ['.png', wav], ['.svg', Buffer.from('<svg onload="alert(1)"/>')], ['.glb', Buffer.alloc(40)], ['.jpg', Buffer.from([255, 216, 255, 217])], ['.wav', Buffer.alloc(0)]] as const) {
    const sourcePath = join(parent, `bad${extension}`); await writeFile(sourcePath, bytes);
    await assert.rejects(importAsset(root, { ...request, sourcePath }));
  }
  const oversized = join(parent, 'huge.wav'); await writeFile(oversized, Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(importAsset(root, { ...request, sourcePath: oversized }), /32 MiB/);
  await assert.rejects(importAsset(root, { ...request, destination: 'assets/audio.png' }), /extension/);
  assert.deepEqual(await readFile(join(root, 'assets/registry.json')), before);
});

test('GLB validates chunk lengths and embedded buffer ranges; all URI resources are refused', async t => {
  const { root, parent, request } = await setup(t);
  const valid = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteLength: 4 }] }, Buffer.alloc(4));
  const sourcePath = join(parent, 'model.glb'); await writeFile(sourcePath, valid);
  assert.equal((await importAsset(root, { ...request, sourcePath })).status, 'saved');
  assert.equal(validateAsset(valid, '.glb'), 'model');
  for (const uri of ['../outside.bin', 'file:///secret', 'https://remote/image.png', 'data:application/octet-stream;base64,AAAA']) assert.throws(() => validateAsset(glb({ asset: { version: '2.0' }, buffers: [{ uri, byteLength: 3 }] }), '.glb'), /URI/);
  assert.throws(() => validateAsset(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteOffset: 3, byteLength: 4 }] }, Buffer.alloc(4)), '.glb'), /bufferView/);
  const truncated = valid.subarray(0, valid.length - 1); assert.throws(() => validateAsset(truncated, '.glb'), /header/);
});

test('PNG validates actual compressed scanlines and CRC', async () => {
  // Original 1x1 RGBA PNG, encoded as a fixture rather than synthesized header-only input.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=', 'base64');
  assert.equal(validateAsset(png, '.png'), 'texture');
  const corrupt = Buffer.from(png); corrupt[40] = corrupt[40]! ^ 1; assert.throws(() => validateAsset(corrupt, '.png'), /CRC/);
});

test('JPEG accepts real encoded pixels and rejects truncation; WAV checks actual sample format', async t => {
  const { parent, root, wav, request } = await setup(t);
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiKKKK8Q90/9k=', 'base64');
  const sourcePath = join(parent, 'original.jpg'); await writeFile(sourcePath, jpeg);
  assert.equal((await importAsset(root, { ...request, sourcePath })).status, 'saved');
  assert.throws(() => validateAsset(jpeg.subarray(0, jpeg.length - 3), '.jpg'));
  const badWav = Buffer.from(wav); badWav.writeUInt32LE(1, 28);
  assert.throws(() => validateAsset(badWav, '.wav'), /format/);
});

test('source symlinks, destination traversal and destination junction escapes are refused', async t => {
  const { root, parent, request } = await setup(t);
  const alias = join(parent, 'alias.wav'); await symlink(request.sourcePath, alias, 'file');
  await assert.rejects(importAsset(root, { ...request, sourcePath: alias }), /nonsymlink/);
  for (const destination of ['../outside.wav', 'assets/../outside.wav', 'assets\\outside.wav', 'C:/outside.wav', 'assets/con.wav']) await assert.rejects(importAsset(root, { ...request, destination }));
  const outside = join(parent, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(registerAsset(root, { asset: { id: 'unsafe', name: 'unsafe', kind: 'audio', path: 'linked/escape.wav' }, bytes: Buffer.from([1]), expectedRegistryRevision: request.expectedRegistryRevision }));
  assert.deepEqual(await readdir(outside), []);
  const external = join(outside, 'existing.wav'); await writeFile(external, 'outside original');
  await symlink(external, join(root, 'assets/escape.wav'), 'file');
  await assert.rejects(importAsset(root, { ...request, destination: 'assets/escape.wav' }), /escapes/);
  assert.equal(await readFile(external, 'utf8'), 'outside original');
});

test('registry publication failure rolls back only newly created unchanged bytes', async t => {
  const { root, request } = await setup(t);
  const registryPath = join(root, 'assets/registry.json'); const original = await readFile(registryPath);
  const link = fs.link;
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    await link(...args);
    if (String(args[1]).endsWith('imported_audio.wav')) await writeFile(registryPath, Buffer.concat([original, Buffer.from(' ')]));
  });
  syncBuiltinESMExports();
  assert.deepEqual(await importAsset(root, request), { status: 'conflict' });
  await assert.rejects(readFile(join(root, 'assets/imported_audio.wav')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(registryPath), Buffer.concat([original, Buffer.from(' ')]));
  mock.mock.restore(); syncBuiltinESMExports();
});

test('rollback preserves payload externally edited after create and registry write failure', async t => {
  const { root, request } = await setup(t);
  const registryPath = join(root, 'assets/registry.json'); const original = await readFile(registryPath); const edited = Buffer.from('external bytes');
  const link = fs.link;
  const mock = t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    await link(...args);
    if (String(args[1]).endsWith('imported_audio.wav')) { await writeFile(String(args[1]), edited); await writeFile(registryPath, Buffer.concat([original, Buffer.from(' ')])); }
  });
  syncBuiltinESMExports();
  assert.deepEqual(await importAsset(root, request), { status: 'conflict' });
  assert.deepEqual(await readFile(join(root, 'assets/imported_audio.wav')), edited);
  mock.mock.restore(); syncBuiltinESMExports();
});

test('registry rename IO failure preserves registry/source and removes the created payload', async t => {
  const { root, wav, request } = await setup(t);
  const registryPath = join(root, 'assets/registry.json'); const original = await readFile(registryPath);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === registryPath) throw Object.assign(new Error('Injected registry rename failure'), { code: 'EACCES' });
    await rename(...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(importAsset(root, request), /Injected/);
  assert.deepEqual(await readFile(registryPath), original);
  assert.deepEqual(await readFile(request.sourcePath), wav);
  await assert.rejects(readFile(join(root, 'assets/imported_audio.wav')), { code: 'ENOENT' });
  mock.mock.restore(); syncBuiltinESMExports();
});
