import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputDestination, publishArtifact, readAssetBytes } from '../src/export-files.js';

async function temporary(t: import('node:test').TestContext): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'forgon-export-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const payload = new Map([['game.js', Buffer.from('actual bytes')], ['assets/a/original.wav', Buffer.from([0, 1, 2, 255])]]);

test('publication is create-only including empty directories and concurrent builders', async t => {
  const parent = await temporary(t); const output = join(parent, 'game');
  const results = await Promise.allSettled([publishArtifact(output, payload), publishArtifact(output, payload)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(await fs.readFile(join(output, 'assets/a/original.wav')), payload.get('assets/a/original.wav'));
  await assert.rejects(publishArtifact(output, payload), /already exists/);
  const empty = join(parent, 'empty'); await fs.mkdir(empty);
  await assert.rejects(publishArtifact(empty, payload), /already exists/);
  assert.deepEqual((await fs.readdir(parent)).sort(), ['empty', 'game']);
});

test('output and artifact traversal never write outside their roots', async t => {
  const parent = await temporary(t);
  await assert.rejects(outputDestination(join(parent, 'ignored') + '/../escape'), /traversal/);
  for (const path of ['../escape', '/absolute', 'C:/escape', 'a\\escape', 'a/./escape']) {
    await assert.rejects(publishArtifact(join(parent, 'game'), new Map([[path, Buffer.from('bad')]])), /Unsafe|escapes/);
  }
  assert.deepEqual(await fs.readdir(parent), []);
});

test('publication failure cleans only owned unchanged files and all private staging', async t => {
  const parent = await temporary(t); const output = join(parent, 'game');
  const link = fs.link; let calls = 0;
  t.mock.method(fs, 'link', async (source: string, target: string) => {
    if (++calls === 2) throw new Error('injected publication interruption');
    return link(source, target);
  });
  await assert.rejects(publishArtifact(output, payload), /interruption/);
  assert.deepEqual(await fs.readdir(parent), []);
});

test('cleanup preserves concurrent user changes after a publication failure', async t => {
  const parent = await temporary(t); const output = join(parent, 'game');
  const link = fs.link; let calls = 0;
  t.mock.method(fs, 'link', async (source: string, target: string) => {
    if (++calls === 2) {
      await fs.writeFile(join(output, 'game.js'), 'user changes');
      throw new Error('injected publication interruption');
    }
    return link(source, target);
  });
  await assert.rejects(publishArtifact(output, payload), /interruption/);
  assert.equal(await fs.readFile(join(output, 'game.js'), 'utf8'), 'user changes');
  assert.deepEqual(await fs.readdir(parent), ['game']);
});

test('asset reader rejects directories and excessive assets', async t => {
  const parent = await temporary(t);
  await assert.rejects(readAssetBytes(parent), /regular file/);
  const path = join(parent, 'large'); const file = await fs.open(path, 'wx');
  try { await file.truncate(256 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(readAssetBytes(path), /256 MiB/);
});
