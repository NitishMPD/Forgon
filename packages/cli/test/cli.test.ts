import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createEmpty3dFixture, createHotelFixture } from '@forgon/test-fixtures';
import type { ProjectFixture } from '@forgon/test-fixtures';
import { captureOverrides } from '@forgon/procedural-authoring';
import { ProjectReader, runCli } from '../src/index.js';
import { ProjectSession } from '../../project-io/src/session.js';
import type { SaveAuthoringRequest } from '@forgon/project-io';

async function project(t: TestContext, fixture: ProjectFixture = createEmpty3dFixture()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgon-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(fixture.files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
  return root;
}
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

test('inspect/validate read complete catalogs and bake deterministically to stdout', async t => {
  const root = await project(t, createHotelFixture());
  const inspected = await run(['inspect', root]); assert.equal(inspected.code, 0, inspected.stderr);
  assert.ok(JSON.parse(inspected.stdout).entities >= 30);
  assert.equal((await run(['validate', root])).code, 0);
  const baked = await run(['bake', root]); assert.equal(baked.code, 0, baked.stderr);
  assert.deepEqual(baked, await run(['bake', root]));
  assert.notEqual(baked.stdout, (await run(['bake', root, '--seed', 'new-seed'])).stdout);
});

test('bake preserves recorded visual overrides and refuses unrecorded edits', async t => {
  const fixture = createHotelFixture(); const edited = structuredClone(fixture.scenes[0]!);
  edited.entities[0]!.name = 'Manual lobby';
  fixture.authoring = captureOverrides(fixture.authoring, edited);
  fixture.files['authoring/generated.json'] = JSON.stringify(fixture.authoring);
  fixture.files['scenes/main.scene.json'] = JSON.stringify(edited);
  const root = await project(t, fixture);
  const result = await run(['bake', root, '--seed', 'another']);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).scene.entities[0].name, 'Manual lobby');
  assert.equal(JSON.parse(result.stdout).authoring.generator.seed, 'another');
  edited.entities[0]!.name = 'Unrecorded'; await writeFile(join(root, 'scenes/main.scene.json'), JSON.stringify(edited));
  const failed = await run(['bake', root]); assert.equal(failed.code, 1); assert.match(failed.stderr, /unrecorded/);
});

test('bake conflicts and unsupported commands return nonzero without scene output', async t => {
  const fixture = createHotelFixture(); const edited = structuredClone(fixture.scenes[0]!);
  const guest = edited.entities.find(entity => entity.prefab && entity.components.some(component => component.type === 'guestQueue'))!;
  guest.components.find(component => component.type === 'render')!.properties.color = [1, 0, 1];
  fixture.authoring = captureOverrides(fixture.authoring, edited);
  fixture.files['authoring/generated.json'] = JSON.stringify(fixture.authoring); fixture.files['scenes/main.scene.json'] = JSON.stringify(edited);
  const root = await project(t, fixture);
  const conflict = await run(['bake', root, '--seed', 'changed']);
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /generated-change/); assert.equal(conflict.stdout, '');
  for (const command of ['snapshot', 'test', 'open', 'preview']) {
    const result = await run([command, root]); assert.equal(result.code, 2); assert.match(result.stderr, /Unavailable/); assert.equal(result.stdout, '');
  }
});

test('malformed input, unknown commands and unsafe catalog paths fail', async t => {
  const root = await project(t);
  assert.equal((await run(['unknown', root])).code, 2);
  assert.equal((await run(['validate'])).code, 2);
  assert.equal((await run(['inspect', root, '--seed', 'wrong'])).code, 2);
  await writeFile(join(root, 'game.project.json'), '{invalid');
  assert.equal((await run(['validate', root])).code, 1);
  const fixture = createEmpty3dFixture(); fixture.manifest.scenes[0]!.path = '../escape.json';
  await writeFile(join(root, 'game.project.json'), JSON.stringify(fixture.manifest));
  assert.equal((await run(['validate', root])).code, 1);
  const reader = await ProjectReader.create(root);
  for (const path of ['../escape.json', 'C:/outside.json', '/outside.json', 'scenes\\main.scene.json']) await assert.rejects(reader.json(path));
});

test('reader rejects junction escapes and enforces byte/depth limits', async t => {
  const root = await project(t); const outside = await mkdtemp(join(tmpdir(), 'forgon-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.json'), '{}');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const reader = await ProjectReader.create(root);
  await assert.rejects(reader.json('escape/outside.json'), /escapes canonical/);
  await writeFile(join(root, 'large.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(reader.json('large.json'), /at most|byte limit|exceeds/);
  await writeFile(join(root, 'deep.json'), '['.repeat(65) + '0' + ']'.repeat(65));
  await assert.rejects(reader.json('deep.json'), /nesting/);
  await writeFile(join(root, 'string.json'), JSON.stringify('['.repeat(100)));
  assert.equal(await reader.json('string.json'), '['.repeat(100));
});

test('catalog reads do not execute project scripts or hide missing asset files', async t => {
  const fixture = createHotelFixture();
  fixture.assets.assets.push({ id: 'untrusted_script', name: 'Untrusted', kind: 'script', path: 'assets/untrusted.ts' });
  fixture.files['assets/registry.json'] = JSON.stringify(fixture.assets);
  fixture.files['assets/untrusted.ts'] = 'throw new Error("PROJECT SCRIPT EXECUTED");';
  const root = await project(t, fixture);
  const inspected = await run(['inspect', root]); assert.equal(inspected.code, 0, inspected.stderr);
  await rm(join(root, 'assets/reception.wav'));
  assert.equal((await run(['validate', root])).code, 1);
});

test('misregistered IDs and unknown generator versions fail honestly', async t => {
  const fixture = createEmpty3dFixture(); fixture.authoring.generator.version = '99';
  fixture.files['authoring/generated.json'] = JSON.stringify(fixture.authoring);
  const root = await project(t, fixture);
  assert.equal((await run(['bake', root])).code, 1);
  fixture.manifest.scenes[0]!.id = 'wrong_id'; fixture.manifest.startScene = 'wrong_id';
  await writeFile(join(root, 'game.project.json'), JSON.stringify(fixture.manifest));
  const result = await run(['validate', root]); assert.equal(result.code, 1); assert.match(result.stderr, /identity/);
});

test('validate checks declared prefab-binding artifacts and internal reference kinds', async t => {
  const fixture = createHotelFixture();
  const bindings = JSON.parse(fixture.files['authoring/guest.bindings.json'] as string);
  bindings.references[0].kind = 'component';
  fixture.files['authoring/guest.bindings.json'] = JSON.stringify(bindings);
  const root = await project(t, fixture);
  const result = await run(['validate', root]);
  assert.equal(result.code, 1); assert.match(result.stderr, /internal object/);
});

test('reader bounds aggregate bytes and document count', async t => {
  const root = await project(t); await writeFile(join(root, 'small.json'), '{}');
  const reader = await ProjectReader.create(root);
  for (let i = 0; i < 128; i++) await reader.json('small.json');
  await assert.rejects(reader.json('small.json'), /document count/);
  await writeFile(join(root, 'quota.json'), `"${'x'.repeat(2 * 1024 * 1024 - 2)}"`);
  const aggregate = await ProjectReader.create(root);
  for (let i = 0; i < 8; i++) await aggregate.json('quota.json');
  await assert.rejects(aggregate.json('quota.json'), /byte limit|exceeds/);
});

test('actual CLI entrypoint propagates nonzero unavailable-command status', async t => {
  const root = await project(t);
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'snapshot', root], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /Unavailable command/); assert.equal(result.stdout, '');
});

test('create templates are real, create-only, and validate after creation', async t => {
  const parent = await project(t);
  for (const template of ['empty-3d', 'hotel']) {
    const destination = join(parent, template);
    const result = await run(['create', destination, '--template', template]); assert.equal(result.code, 0, result.stderr);
    assert.equal((await run(['validate', destination])).code, 0);
    const before = await readFile(join(destination, 'game.project.json'));
    assert.equal((await run(['create', destination])).code, 1);
    assert.deepEqual(await readFile(join(destination, 'game.project.json')), before);
  }
  assert.equal((await run(['create', join(parent, 'invalid'), '--template', 'unknown'])).code, 2);
});

test('bake remains stdout-only by default and --write persists the scene/artifact pair', async t => {
  const root = await project(t, createHotelFixture());
  const before = await readFile(join(root, 'authoring/generated.json'));
  assert.equal((await run(['bake', root, '--seed', 'dry'])).code, 0);
  assert.deepEqual(await readFile(join(root, 'authoring/generated.json')), before);
  const result = await run(['bake', root, '--write', '--seed', 'saved']); assert.equal(result.code, 0, result.stderr);
  const bundle = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'authoring/generated.json'), 'utf8')), bundle.authoring);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'scenes/main.scene.json'), 'utf8')), bundle.scene);
  assert.equal(bundle.authoring.generator.seed, 'saved'); assert.equal((await run(['validate', root])).code, 0);
  for (const options of [['--write', '--write'], ['--seed'], ['--unknown']]) assert.equal((await run(['bake', root, ...options])).code, 2);
});

test('write bake returns nonzero and preserves external scene or artifact revision changes', async t => {
  for (const path of ['scenes/main.scene.json', 'authoring/generated.json']) {
    const root = await project(t); const target = join(root, path); const before = await readFile(target);
    const save = ProjectSession.prototype.saveAuthoring;
    const mock = t.mock.method(ProjectSession.prototype, 'saveAuthoring', async function(this: ProjectSession, request: SaveAuthoringRequest) {
      await writeFile(target, Buffer.concat([before, Buffer.from(' ')]));
      return save.call(this, request);
    });
    const result = await run(['bake', root, '--write', '--seed', 'stale']);
    assert.equal(result.code, 1); assert.match(result.stderr, /changed/); assert.equal(result.stdout, '');
    assert.deepEqual(await readFile(target), Buffer.concat([before, Buffer.from(' ')]));
    mock.mock.restore();
  }
});

test('CLI import requires explicit license and returns actual entrypoint failure/success statuses', async t => {
  const root = await project(t, createHotelFixture()); const source = join(root, 'assets/reception.wav');
  assert.equal((await run(['import', root, source])).code, 2);
  const imported = await run(['import', root, source, '--license', 'CC0-1.0', '--id', 'cli_import']);
  assert.equal(imported.code, 0, imported.stderr); assert.equal(JSON.parse(imported.stdout).asset.id, 'cli_import');
  assert.equal((await run(['validate', root])).code, 0);
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'import', root, source, '--license', 'CC0-1.0', '--id', 'cli_import'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
  const bad = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'import', root, source], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /Usage/);
});

