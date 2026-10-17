import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHotelFixture, createEmpty3dFixture } from '@forgon/test-fixtures';
import type { ProjectFixture } from '@forgon/test-fixtures';
import { runCli } from '../src/index.js';
import { sha256 } from '../src/export-files.js';

async function setup(t: import('node:test').TestContext, fixture: ProjectFixture): Promise<{ root: string; parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'forgon-web-test-')); const root = join(parent, 'project');
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(fixture.files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
  return { parent, root };
}
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

test('build parser requires one root, web target and output while preserving command usage errors', async t => {
  const { root, parent } = await setup(t, createEmpty3dFixture());
  for (const args of [[], [root], ['--target', 'web', root], ['--target', 'windows', root, '--out', join(parent, 'game')],
    [root, '--target', 'web', '--out', 'x', '--out', 'y'], [root, 'second', '--target', 'web', '--out', 'x'], [root, '--target', 'web', '--out']]) {
    const result = await run(['build', ...args]);
    assert.equal(result.code, 2, result.stderr); assert.equal(result.stdout, ''); assert.match(result.stderr, /Usage/);
  }
});

test('real web artifact includes exact assets, catalog snapshots, independent runtime and reproducible manifest', async t => {
  const fixture = createHotelFixture();
  fixture.assets.assets.push({ id: 'inert_script', name: 'Inert source', kind: 'script', path: 'assets/inert.ts' });
  fixture.files['assets/registry.json'] = JSON.stringify(fixture.assets);
  fixture.files['assets/inert.ts'] = 'throw new Error("UNTRUSTED SCRIPT EXECUTED");';
  fixture.files['vite.config.ts'] = 'throw new Error("UNTRUSTED VITE CONFIG EXECUTED");';
  const { root, parent } = await setup(t, fixture); const output = join(parent, 'game');
  const result = await run(['build', '--target', 'web', root, '--out', output]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'built');
  const manifestBytes = await readFile(join(output, 'build-manifest.json'));
  assert.equal(JSON.parse(result.stdout).manifestHash, sha256(manifestBytes));
  const manifest = JSON.parse(manifestBytes.toString());
  const game = JSON.parse(await readFile(join(output, 'game.json'), 'utf8'));
  assert.deepEqual(game.manifest, fixture.manifest); assert.deepEqual(game.scenes, fixture.scenes);
  assert.equal(manifest.startScene, fixture.manifest.startScene);
  for (const entry of manifest.files) {
    const bytes = await readFile(join(output, entry.path));
    assert.equal(sha256(bytes), entry.sha256, entry.path); assert.equal(bytes.length, entry.bytes);
  }
  for (const asset of manifest.assets) {
    const original = fixture.assets.assets.find(record => record.id === asset.id)!;
    assert.deepEqual(await readFile(join(output, asset.path)), await readFile(join(root, original.path)));
    assert.deepEqual(asset.provenance, original.provenance ?? null);
    assert.equal(new URL(game.assetUrls[asset.id], 'http://localhost/game/').pathname, `/game/${asset.path}`);
  }
  const js = await readFile(join(output, 'game.js'), 'utf8');
  assert.doesNotMatch(js, /@forgon\/|@tauri-apps|__vite-browser-external|UNTRUSTED SCRIPT EXECUTED|editor-viewport/);
  assert.ok(js.length > 100_000, 'Actual PlayCanvas engine is bundled');
  const wasm = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/.exec(js);
  assert.ok(wasm, 'Standalone artifact includes its physics WASM without a CDN or node_modules');
  assert.deepEqual(Buffer.from(wasm[1]!, 'base64'), await readFile(new URL('../../game-runtime/vendor/ammo.wasm.wasm', import.meta.url)));
  assert.match(await readFile(join(output, 'licenses/ammo.txt'), 'utf8'), /ammo\.js contributors/);
  assert.match(await readFile(join(output, 'licenses/ammo-provenance.md'), 'utf8'), /playcanvas\/engine\/tree\/v2\.23\.3/);
  assert.deepEqual((await readdir(output)).sort(), ['assets', 'build-manifest.json', 'game.js', 'game.json', 'index.html', 'licenses']);
  const second = await run(['build', root, '--out', join(parent, 'second'), '--target', 'web']);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(await readFile(join(parent, 'second/build-manifest.json')), manifestBytes);
  const before = await readFile(join(output, 'game.js'));
  assert.equal((await run(['build', root, '--target', 'web', '--out', output])).code, 1);
  assert.deepEqual(await readFile(join(output, 'game.js')), before);
});

test('unsupported required components and scripts fail before creating an output', async t => {
  for (const type of ['script', 'rigidbody', 'unknownComponent']) {
    const fixture = createEmpty3dFixture();
    fixture.scenes[0]!.entities[0]!.components.push({ id: 'unsupported_component', type, enabled: true, properties: {}, entityRefs: [], assetRefs: [] });
    fixture.files['scenes/main.scene.json'] = JSON.stringify(fixture.scenes[0]);
    const { root, parent } = await setup(t, fixture);
    const result = await run(['build', root, '--target', 'web', '--out', join(parent, 'game')]);
    assert.equal(result.code, 1); assert.match(result.stderr, /unsupported/i); assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(parent), ['project']);
  }
});
