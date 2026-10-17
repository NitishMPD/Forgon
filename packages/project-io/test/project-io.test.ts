import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createProject, openProject, planCreate, readProject, createNodeProjectHost } from '../src/index.js';
import { atomicWrite, encodeJson, hash, parseJson, readBytes } from '../src/files.js';
import { createFixtureFiles } from '../src/create.js';
import { AUTHORING, JOURNAL, recoverPair } from '../src/transaction.js';
import { captureOverrides, replayOverrides } from '@forgon/procedural-authoring';
import type { NodeProjectSession } from '../src/types.js';
import type { SceneWatchEvent } from '@forgon/project-schema';
import { createEntity } from '@forgon/project-schema';

const scenePath = 'scenes/main.scene.json';
const code = (expected: string) => (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
async function directory(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgon-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function project(t: Parameters<typeof directory>[0], template = 'empty-3d'): Promise<NodeProjectSession> {
  const session = await createProject(join(await directory(t), 'game'), template);
  t.after(async () => session.close());
  return session;
}
function watchEvents(session: NodeProjectSession) {
  const events: SceneWatchEvent[] = [];
  const stop = session.sceneIO.watchScene(scenePath, event => events.push(event));
  return {
    events, stop,
    async next(type: SceneWatchEvent['type'], from = 0): Promise<SceneWatchEvent> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const event = events.slice(from).find(event => event.type === type);
        if (event) return event;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(`No ${type} watch event: ${JSON.stringify(events)}`);
    },
  };
}

test('create/open/host use actual files, preserve IDs, and never overwrite a destination', async t => {
  const parent = await directory(t); const root = join(parent, 'game');
  const host = createNodeProjectHost(async () => root);
  assert.equal(await host.pickFolder(), root);
  const plan = await host.planCreate(root);
  assert.equal(plan.blockedReason, undefined);
  await assert.rejects(planCreate(root, 'unsupported'), code('INVALID_DOCUMENT'));
  await assert.rejects(createProject(root, 'unsupported'), code('INVALID_DOCUMENT'));
  const result = await host.create(root);
  assert.equal(result.status, 'opened'); if (result.status !== 'opened') return;
  const session = result.session; t.after(async () => session.close());
  assert.deepEqual((await readdir(root, { recursive: true })).filter(path => plan.files.includes(path.replaceAll('\\', '/'))).length, plan.files.length);
  const before = await readFile(join(root, scenePath));
  assert.ok((await planCreate(root)).blockedReason);
  await assert.rejects(createProject(root), code('ALREADY_EXISTS'));
  assert.deepEqual(await readFile(join(root, scenePath)), before);
  const reopened = await host.open(root);
  assert.equal(reopened.status, 'opened');
  if (reopened.status === 'opened') {
    assert.deepEqual(await reopened.session.sceneIO.readScene(scenePath), await session.sceneIO.readScene(scenePath));
    reopened.session.close();
  }
  assert.equal((await host.listRecent())[0]?.status, 'ready');
  const empty = join(parent, 'empty'); await mkdir(empty);
  const noManifest = await host.open(empty); assert.equal(noManifest.status === 'failed' && noManifest.reason, 'not-project');
  const absent = await host.open(join(parent, 'missing')); assert.equal(absent.status === 'failed' && absent.reason, 'unreadable');
  await writeFile(join(root, 'game.project.json'), '{}');
  const invalid = await host.open(root); assert.equal(invalid.status === 'failed' && invalid.reason, 'invalid');
  assert.equal((await host.listRecent())[0]?.status, 'needs_attention');
});

test('public entry points keep the default export browser-safe and runtime under /node', async () => {
  assert.deepEqual(Object.keys(await import('@forgon/project-io')), []);
  const runtime = await import('@forgon/project-io/node');
  assert.equal(runtime.openProject, openProject);
  assert.equal(runtime.createNodeProjectHost, createNodeProjectHost);
});

test('failed creation removes only its unchanged files and preserves external additions/edits', async t => {
  const parent = await directory(t); const root = join(parent, 'failed');
  await assert.rejects(createFixtureFiles(root, { 'scenes/a.json': 'original', 'b.json': 'owned' }, async () => {
    await writeFile(join(root, 'scenes/a.json'), 'external');
    await writeFile(join(root, 'unrelated.txt'), 'keep');
    throw new Error('validation failed');
  }), code('IO_ERROR'));
  assert.equal(await readFile(join(root, 'scenes/a.json'), 'utf8'), 'external');
  assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(root, 'b.json')), { code: 'ENOENT' });
  const clean = join(parent, 'clean');
  await assert.rejects(createFixtureFiles(clean, { 'nested/a.json': 'owned' }, async () => { throw new Error('invalid'); }));
  await assert.rejects(readdir(clean), { code: 'ENOENT' });
});

test('registered asset reads are bounded data and opening never evaluates scripts', async t => {
  const session = await project(t, 'hotel');
  const asset = session.assets[0]!;
  const read = await session.readAsset(asset.id);
  assert.deepEqual(read.asset, asset);
  assert.equal(read.revision, hash(read.bytes));
  await assert.rejects(session.readAsset('../game.project.json'), code('NOT_FOUND'));
  const registryPath = join(session.root, session.manifest.assetRegistry);
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.assets.push({ id: 'danger_script', name: 'Never run', kind: 'script', path: 'assets/danger.mjs' });
  await writeFile(join(session.root, 'assets/danger.mjs'), "throw new Error('PROJECT SCRIPT EXECUTED');");
  await writeFile(registryPath, JSON.stringify(registry));
  const opened = await openProject(session.root); t.after(async () => opened.close());
  assert.match(new TextDecoder().decode((await opened.readAsset('danger_script')).bytes), /PROJECT SCRIPT EXECUTED/);
  await writeFile(join(session.root, asset.path), Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(session.readAsset(asset.id), code('LIMIT_EXCEEDED'));
});

test('bounded UTF-8/JSON parsing and catalog validation reject unsafe input', async t => {
  const session = await project(t);
  assert.throws(() => parseJson(Buffer.from([0xc3, 0x28])), code('INVALID_DOCUMENT'));
  assert.throws(() => parseJson(Buffer.from('['.repeat(65) + '0' + ']'.repeat(65))), code('INVALID_DOCUMENT'));
  assert.equal(parseJson(Buffer.from('{"text":"[[[\\\""}')) !== null, true);
  await writeFile(join(session.root, scenePath), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  await assert.rejects(readProject(session.root), code('LIMIT_EXCEEDED'));
  await assert.rejects(readBytes(session.root, '../outside'), code('INVALID_PATH'));
  await writeFile(join(session.root, AUTHORING), '{}');
  await assert.rejects(session.readAuthoring(), code('INVALID_DOCUMENT'));
  for (const path of ['/absolute', 'C:/data', 'x\\y', 'x:stream', 'x/../y', 'CON.txt', 'x./y', 'x /y', 'x//y', 'x\0y']) {
    await assert.rejects(readBytes(session.root, path), code('INVALID_PATH'));
  }
});

test('canonical containment rejects real directory junction escapes for reads and writes', async t => {
  const session = await project(t); const outside = await directory(t);
  await writeFile(join(outside, 'secret.json'), '{}');
  await symlink(outside, join(session.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readBytes(session.root, 'escape/secret.json'), code('INVALID_PATH'));
  await assert.rejects(atomicWrite(session.root, 'escape/new.json', Buffer.from('{}')), code('INVALID_PATH'));
  await assert.rejects(readFile(join(outside, 'new.json')), { code: 'ENOENT' });
  const rootAlias = join(await directory(t), 'alias');
  await symlink(session.root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = await openProject(rootAlias); t.after(async () => alias.close());
  assert.equal(alias.root, await realpath(session.root));
});

test('revision saves serialize sessions, reject stale/create-only saves, and preserve atomic originals', async t => {
  const session = await project(t);
  // A project without a generated authoring pair uses the single-file save path.
  await unlink(join(session.root, AUTHORING));
  const second = await openProject(session.root); t.after(async () => second.close());
  const initial = await session.sceneIO.readScene(scenePath);
  const firstEdit = structuredClone(initial.document); firstEdit.name = 'first';
  const secondEdit = structuredClone(initial.document); secondEdit.name = 'second';
  const results = await Promise.all([
    session.sceneIO.saveScene({ path: scenePath, document: firstEdit, expectedRevision: initial.revision }),
    second.sceneIO.saveScene({ path: scenePath, document: secondEdit, expectedRevision: initial.revision }),
  ]);
  assert.equal(results[0]!.status, 'saved'); assert.equal(results[1]!.status, 'conflict');
  const current = await session.sceneIO.readScene(scenePath);
  assert.equal(current.document.name, 'first');
  assert.equal(current.revision, hash(await readFile(join(session.root, scenePath))));
  assert.equal((await session.sceneIO.saveScene({ path: scenePath, document: secondEdit, expectedRevision: null })).status, 'conflict');
  assert.equal(await atomicWrite(session.root, scenePath, encodeJson(secondEdit), false, initial.revision), false);
  assert.deepEqual(await session.sceneIO.readScene(scenePath), current);
  assert.equal((await readdir(join(session.root, 'scenes'))).some(path => path.endsWith('.tmp')), false);
  const wrong = structuredClone(firstEdit); wrong.sceneId = 'other_scene';
  await assert.rejects(session.sceneIO.saveScene({ path: scenePath, document: wrong, expectedRevision: current.revision }), code('INVALID_DOCUMENT'));
  await assert.rejects(session.sceneIO.saveScene({ path: 'unregistered.json', document: firstEdit, expectedRevision: null }), code('INVALID_PATH'));
  await assert.rejects(session.sceneIO.saveScene({ path: 'unregistered.json', document: firstEdit, expectedRevision: 'stale' }), code('INVALID_PATH'));
  await unlink(join(session.root, scenePath));
  assert.deepEqual(await session.sceneIO.saveScene({ path: scenePath, document: firstEdit, expectedRevision: current.revision }), { status: 'conflict', current: null });
  const created = await session.sceneIO.saveScene({ path: scenePath, document: firstEdit, expectedRevision: null });
  assert.equal(created.status, 'saved');
});

test('scene file symlink escapes cannot be opened, read or overwritten', async t => {
  const session = await project(t); const outside = await directory(t);
  const read = await session.sceneIO.readScene(scenePath);
  const bytes = await readFile(join(session.root, scenePath)); const secret = join(outside, 'scene.json');
  await writeFile(secret, bytes); await unlink(join(session.root, scenePath));
  try { await symlink(secret, join(session.root, scenePath), 'file'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') { t.skip('Windows file symlink privilege unavailable; directory junction containment is tested separately'); return; }
    throw error;
  }
  await assert.rejects(openProject(session.root), code('INVALID_PATH'));
  await assert.rejects(session.sceneIO.readScene(scenePath), code('INVALID_PATH'));
  await assert.rejects(session.sceneIO.saveScene({ path: scenePath, document: read.document, expectedRevision: read.revision }), code('INVALID_PATH'));
  assert.deepEqual(await readFile(secret), bytes);
});

test('watcher reports valid, invalid, dependency failure and deletion, then disposes cleanly', async t => {
  const session = await project(t); const monitor = watchEvents(session);
  t.after(async () => monitor.stop());
  await monitor.next('changed');
  let from = monitor.events.length;
  await writeFile(join(session.root, scenePath), '{invalid');
  await monitor.next('invalid', from);
  const fixture = (await import('@forgon/test-fixtures')).createEmpty3dFixture();
  from = monitor.events.length; await writeFile(join(session.root, scenePath), encodeJson(fixture.scenes[0]));
  await monitor.next('changed', from);
  from = monitor.events.length; await unlink(join(session.root, session.manifest.assetRegistry));
  await monitor.next('invalid', from);
  assert.equal(monitor.events.slice(from).some(event => event.type === 'deleted'), false);
  from = monitor.events.length; await unlink(join(session.root, scenePath));
  await monitor.next('deleted', from);
  session.close(); const count = monitor.events.length;
  await writeFile(join(session.root, scenePath), encodeJson(fixture.scenes[0]));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(monitor.events.length, count);
  assert.throws(() => session.sceneIO.watchScene(scenePath, () => {}), code('CLOSED'));
  await assert.rejects(session.sceneIO.readScene(scenePath), code('CLOSED'));
  await assert.rejects(session.readAsset('anything'), code('CLOSED'));
  monitor.stop(); session.close();
});

test('adding, editing and deleting objects in a generated template survives save and reopen', async t => {
  const session = await project(t);
  const initial = await session.sceneIO.readScene(scenePath);
  const edited = structuredClone(initial.document);
  edited.entities.push(createEntity('Box'));
  let saved = await session.sceneIO.saveScene({ path: scenePath, document: edited, expectedRevision: initial.revision });
  assert.equal(saved.status, 'saved');
  const reopened = await openProject(session.root); t.after(() => reopened.close());
  assert.deepEqual((await reopened.sceneIO.readScene(scenePath)).document, edited);
  assert.deepEqual(replayOverrides((await reopened.readAuthoring())!.document).scene, edited);
  edited.entities.at(-1)!.components = [{ id: 'manual-render', type: 'render', enabled: true, properties: { primitive: 'box' }, entityRefs: [], assetRefs: [] }];
  const current = await reopened.sceneIO.readScene(scenePath);
  saved = await reopened.sceneIO.saveScene({ path: scenePath, document: edited, expectedRevision: current.revision });
  assert.equal(saved.status, 'saved');
  assert.deepEqual((await reopened.sceneIO.readScene(scenePath)).document, edited);
  const stale = await session.sceneIO.saveScene({ path: scenePath, document: initial.document, expectedRevision: initial.revision });
  assert.equal(stale.status, 'conflict');
  edited.entities.pop();
  const latest = await reopened.sceneIO.readScene(scenePath);
  assert.equal((await reopened.sceneIO.saveScene({ path: scenePath, document: edited, expectedRevision: latest.revision })).status, 'saved');
  assert.deepEqual((await reopened.sceneIO.readScene(scenePath)).document, initial.document);
});

test('generated scene saves persist overrides and checked pair saves survive reopen', async t => {
  const session = await project(t, 'hotel');
  const before = await session.sceneIO.readScene(scenePath); const edited = structuredClone(before.document);
  edited.entities[0]!.name = 'Human edited lobby';
  const saved = await session.sceneIO.saveScene({ path: scenePath, document: edited, expectedRevision: before.revision });
  assert.equal(saved.status, 'saved');
  const recorded = (await session.readAuthoring())!;
  assert.deepEqual(replayOverrides(recorded.document).scene, edited);
  const next = structuredClone(edited); next.entities[0]!.transform.position[0] = 3;
  const artifact = captureOverrides(recorded.document, next);
  const request = { path: scenePath, scene: next, authoring: artifact, expectedRevision: (await session.sceneIO.readScene(scenePath)).revision, expectedAuthoringRevision: recorded.revision };
  assert.equal((await session.saveAuthoring(request)).status, 'saved');
  assert.equal((await session.saveAuthoring(request)).status, 'conflict');
  const reopened = await openProject(session.root); t.after(async () => reopened.close());
  assert.deepEqual((await reopened.sceneIO.readScene(scenePath)).document, next);
  assert.deepEqual(replayOverrides((await reopened.readAuthoring())!.document).scene, next);
  await assert.rejects(readFile(join(session.root, JOURNAL)), { code: 'ENOENT' });
  await writeFile(join(session.root, scenePath), encodeJson(edited));
  const external = await session.sceneIO.readScene(scenePath);
  await assert.rejects(session.sceneIO.saveScene({ path: scenePath, document: next, expectedRevision: external.revision }), code('UNRECORDED_CHANGES'));
  assert.deepEqual((await session.sceneIO.readScene(scenePath)).document, edited);
});

test('pair journal recovers every interrupted commit/rollback state idempotently', async t => {
  const session = await project(t); const before = await session.sceneIO.readScene(scenePath);
  const oldArtifact = (await session.readAuthoring())!;
  const changed = structuredClone(before.document); changed.entities[0]!.name = 'new';
  const sceneBefore = await readFile(join(session.root, scenePath)); const sceneAfter = encodeJson(changed);
  const authoringBefore = await readFile(join(session.root, AUTHORING)); const authoringAfter = encodeJson(captureOverrides(oldArtifact.document, changed));
  const journal = { version: 1, scenePath, sceneBefore: sceneBefore.toString('base64'), sceneAfter: sceneAfter.toString('base64'), authoringBefore: authoringBefore.toString('base64'), authoringAfter: authoringAfter.toString('base64') };
  for (const [scene, artifact] of [[sceneBefore, authoringBefore], [sceneAfter, authoringBefore], [sceneAfter, authoringAfter], [sceneBefore, authoringAfter]]) {
    await writeFile(join(session.root, scenePath), scene!); await writeFile(join(session.root, AUTHORING), artifact!);
    await writeFile(join(session.root, JOURNAL), encodeJson(journal));
    const reopened = await openProject(session.root); reopened.close();
    assert.deepEqual(await readFile(join(session.root, scenePath)), sceneBefore);
    assert.deepEqual(await readFile(join(session.root, AUTHORING)), authoringBefore);
    assert.equal(await recoverPair(session.root), false);
  }
});

test('recovery refuses unrelated external bytes/deletions and preserves journal and both files', async t => {
  const session = await project(t); const before = await session.sceneIO.readScene(scenePath);
  const oldArtifact = (await session.readAuthoring())!;
  const changed = structuredClone(before.document); changed.entities[0]!.name = 'pending';
  const sceneBefore = await readFile(join(session.root, scenePath)); const sceneAfter = encodeJson(changed);
  const authoringBefore = await readFile(join(session.root, AUTHORING)); const authoringAfter = encodeJson(captureOverrides(oldArtifact.document, changed));
  const journal = encodeJson({ version: 1, scenePath, sceneBefore: sceneBefore.toString('base64'), sceneAfter: sceneAfter.toString('base64'), authoringBefore: authoringBefore.toString('base64'), authoringAfter: authoringAfter.toString('base64') });
  await writeFile(join(session.root, JOURNAL), journal);
  await writeFile(join(session.root, scenePath), sceneAfter);
  const unrelated = Buffer.from('external bytes'); await writeFile(join(session.root, AUTHORING), unrelated);
  await assert.rejects(openProject(session.root), code('RECOVERY_CONFLICT'));
  assert.deepEqual(await readFile(join(session.root, AUTHORING)), unrelated);
  assert.deepEqual(await readFile(join(session.root, scenePath)), sceneAfter);
  assert.deepEqual(await readFile(join(session.root, JOURNAL)), journal);
  await unlink(join(session.root, AUTHORING));
  await assert.rejects(recoverPair(session.root), code('RECOVERY_CONFLICT'));
  assert.deepEqual(await readFile(join(session.root, scenePath)), sceneAfter);
});

test('open recovers a half pair left by an exited process without running project code', async t => {
  const session = await project(t); const before = await session.sceneIO.readScene(scenePath);
  const artifact = (await session.readAuthoring())!;
  const changed = structuredClone(before.document); changed.entities[0]!.name = 'interrupted';
  const sceneBefore = await readFile(join(session.root, scenePath)); const sceneAfter = encodeJson(changed);
  const authoringBefore = await readFile(join(session.root, AUTHORING)); const authoringAfter = encodeJson(captureOverrides(artifact.document, changed));
  const staging = await directory(t); const journalSource = join(staging, 'journal'); const sceneSource = join(staging, 'scene');
  await writeFile(journalSource, encodeJson({ version: 1, scenePath, sceneBefore: sceneBefore.toString('base64'), sceneAfter: sceneAfter.toString('base64'), authoringBefore: authoringBefore.toString('base64'), authoringAfter: authoringAfter.toString('base64') }));
  await writeFile(sceneSource, sceneAfter);
  // Persist the exact boundary after the first replacement, then terminate without cleanup.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { copyFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [root, journal, scene] = process.argv.slice(1);
    copyFileSync(journal, join(root, '.forgon-transaction.json'));
    copyFileSync(scene, join(root, 'scenes/main.scene.json'));
    process.exit(73);
  `, session.root, journalSource, sceneSource], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.status, 73, child.stderr);
  const reopened = await openProject(session.root); t.after(async () => reopened.close());
  assert.deepEqual(await readFile(join(session.root, scenePath)), sceneBefore);
  assert.deepEqual(await readFile(join(session.root, AUTHORING)), authoringBefore);
});
