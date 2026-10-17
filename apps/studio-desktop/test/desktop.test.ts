import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopBridge } from '../src/bridge.js';
import { createDesktopServices } from '../src/client.js';
import { parseRequest, type BridgeEvent, type Transport } from '../src/protocol.js';
import type { RunningAgentService } from '@forgon/agent-service';
import type { AgentEvent } from '@forgon/project-schema';

async function harness(agent?: RunningAgentService) {
  const root = await mkdtemp(join(tmpdir(), 'forgon-desktop-'));
  const listeners = new Set<(event: BridgeEvent) => void>();
  const bridge = await createDesktopBridge({ dataDir: join(root, 'state'), emit: event => { for (const listener of listeners) listener(event); }, ...(agent ? { agent } : {}) });
  let sequence = 0;
  const dispatch = (method: string, args: Record<string, unknown> = {}, native = false) => bridge.dispatch({ v: 1, id: String(++sequence), method, args }, native);
  const transport: Transport = {
    request: async <T>(method: string, args: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(await dispatch(method, args) ?? null)) as T,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const services = await createDesktopServices(transport);
  return { root, bridge, dispatch, services, listeners, async close() { services.dispose(); await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}

test('protocol refuses bad versions, malformed arguments and native privilege escalation', async () => {
  assert.throws(() => parseRequest({ v: 2, id: '1', method: 'x', args: {} }));
  assert.throws(() => parseRequest({ v: 1, id: '1', method: 'x', args: [] }));
  const h = await harness();
  try {
    await assert.rejects(h.dispatch('native:grant', { root: h.root }), /Native-only/);
    await assert.rejects(h.services.project.open(h.root), /not selected/);
    await assert.rejects(h.services.project.create(join(h.root, 'unplanned')), /creation plan/);
    await assert.rejects(h.dispatch('asset:read', { session: 'guessed', assetId: 'x' }), /another window/);
    assert.ok(h.services.agent.providers.every(p => p.readiness === 'not-ready' && p.models.length === 0 && p.permissionModes.length === 0));
    await assert.rejects(h.services.agent.service.cancel('guessed'), /No isolated/);
  } finally { await h.close(); }
});

test('script compilation crosses only an owned project session and never executes project code', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.dispatch('scripts:compile', { session: 'guessed' }), /another window/);
    const result = await h.services.project.openExample();
    assert.equal(result.status, 'opened'); if (result.status !== 'opened') return;
    const session = result.session;
    await mkdir(join(session.root, 'scripts'), { recursive: true });
    await writeFile(join(session.root, 'scripts', 'test.ts'), `import {defineScript, prop} from '@forgon/game-runtime/scripting';\nthrow new Error('PROJECT SCRIPT EXECUTED');\nexport default defineScript({props:{speed:prop.number(90)}});`);
    const catalog = await session.compileScripts();
    assert.deepEqual(catalog.diagnostics, []); assert.equal(catalog.scripts.length, 1);
    assert.equal(catalog.scripts[0]!.props.speed!.default, 90);
    assert.match(catalog.scripts[0]!.code, /export function load/);
    await writeFile(join(session.root, 'scripts', 'test.ts'), `import {defineScript} from '@forgon/game-runtime/scripting';\nexport default defineScript({props:{}, update( { });`);
    const broken = await session.compileScripts();
    assert.ok(broken.diagnostics.length); assert.equal(broken.diagnostics[0]!.line, 2);
    session.close(); await assert.rejects(session.compileScripts(), /closed/);
  } finally { await h.close(); }
});

test('real IO through renderer proxy: create, save, conflict, watch, close and persistent reopen', async () => {
  const h = await harness();
  try {
    const parent = await h.dispatch('native:grant', { root: h.root }, true) as string;
    for (const name of ['..', 'CON', 'x/y', 'trailing.', 'bad:name']) await assert.rejects(h.services.project.planCreateChild(parent, name), /safe/);
    const plan = await h.services.project.planCreateChild(parent, 'Game');
    assert.equal(plan.blockedReason, undefined);
    const result = await h.services.project.create(plan.root);
    assert.equal(result.status, 'opened');
    if (result.status !== 'opened') return;
    const s = result.session, path = s.manifest.scenes[0]!.path;
    const before = await s.sceneIO.readScene(path);
    const next = structuredClone(before.document); next.entities[0]!.transform.position[0] += 2;
    assert.equal((await s.sceneIO.saveScene({ path, document: next, expectedRevision: before.revision })).status, 'saved');
    assert.equal((await s.sceneIO.saveScene({ path, document: before.document, expectedRevision: before.revision })).status, 'conflict');
    await assert.rejects(s.sceneIO.readScene('../outside'), /registered/);
    await assert.rejects(h.dispatch('asset:import', { session: 'guessed', source: 'anything', license: 'MIT' }));
    const external = structuredClone(next); external.entities[0]!.transform.position[0] += 3;
    let stop = () => {};
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Watcher did not deliver external bytes')), 4000);
      stop = s.sceneIO.watchScene(path, event => {
        if (event.type === 'changed' && event.value.document.entities[0]!.transform.position[0] === external.entities[0]!.transform.position[0]) { clearTimeout(timeout); resolve(); }
      });
    });
    await writeFile(join(s.root, path), JSON.stringify(external));
    await changed; stop();
    s.close(); s.close();
    await assert.rejects(s.sceneIO.readScene(path), /closed/);
    const reopened = await createDesktopBridge({ dataDir: join(h.root, 'state'), emit() {} });
    try {
      const recent = await reopened.dispatch({ v: 1, id: 'r', method: 'project:recent', args: {} }) as { path: string }[];
      assert.equal(recent[0]!.path, plan.root);
      const value = await reopened.dispatch({ v: 1, id: 'o', method: 'project:open', args: { root: plan.root } }) as { status: string };
      assert.equal(value.status, 'opened');
      assert.deepEqual(JSON.parse(await readFile(join(plan.root, path), 'utf8')).entities[0].transform, external.entities[0]!.transform);
      await reopened.dispatch({ v: 1, id: 'f', method: 'project:forget', args: { root: plan.root } });
      assert.deepEqual(await reopened.dispatch({ v: 1, id: 'r2', method: 'project:recent', args: {} }), []);
    } finally { await reopened.close(); }
    const fresh = await createDesktopBridge({ dataDir: join(h.root, 'state'), emit() {} });
    try {
      assert.deepEqual(await fresh.dispatch({ v: 1, id: 'r3', method: 'project:recent', args: {} }), [], 'forgetting persists');
      await assert.rejects(fresh.dispatch({ v: 1, id: 'o2', method: 'project:open', args: { root: plan.root } }), /not selected/, 'a forgotten root needs a fresh native pick');
      assert.ok(JSON.parse(await readFile(join(plan.root, path), 'utf8')), 'project files are untouched');
    } finally { await fresh.close(); }
  } finally { await h.close(); }
});

test('examples are independent copies; assets carry actual bytes; import is native-only', async () => {
  const h = await harness();
  try {
    const first = await h.services.project.openExample(), second = await h.services.project.openExample();
    assert.equal(first.status, 'opened'); assert.equal(second.status, 'opened');
    if (first.status !== 'opened' || second.status !== 'opened') return;
    assert.notEqual(first.session.root, second.session.root);
    const catalog = await first.session.readCatalog();
    for (const asset of catalog.assets.assets) {
      const value = await first.session.readAsset(asset.id);
      assert.ok(value.bytes instanceof Uint8Array);
      assert.deepEqual(Buffer.from(value.bytes), await readFile(join(first.session.root, asset.path)));
    }
    // The renderer cannot smuggle an arbitrary import source path into the Node bridge.
    const raw = await h.dispatch('project:open', { root: first.session.root }) as { session: { id: string } };
    await assert.rejects(h.dispatch('asset:import', { session: raw.session.id, source: join(h.root, 'private'), license: 'MIT' }), /native file selection/);
    const source = join(h.root, 'material.json');
    await writeFile(source, '{"diffuse":[1,0,0]}');
    await assert.rejects(h.dispatch('asset:import', { session: raw.session.id, source, license: 'MIT' }, true));
    const audio = catalog.assets.assets.find(asset => asset.kind === 'audio');
    assert.ok(audio);
    await h.dispatch('asset:import', { session: raw.session.id, source: join(first.session.root, audio.path), license: 'Original fixture, MIT' }, true);
    const imported = await first.session.readCatalog();
    assert.equal(imported.assets.assets.length, catalog.assets.assets.length + 1);
  } finally { await h.close(); }
});

test('unsubscribe before registration completes is ordered; disconnect tears down subscriptions', async () => {
  const h = await harness();
  try {
    const opened = await h.services.project.openExample();
    if (opened.status !== 'opened') throw new Error('Fixture open failed');
    const path = opened.session.manifest.scenes[0]!.path;
    const stop = opened.session.sceneIO.watchScene(path, () => assert.fail('Unsubscribed listener was called'));
    stop(); stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const listener of [...h.listeners]) listener({ kind: 'closed', value: 'test disconnect' });
    await assert.rejects(opened.session.readCatalog(), /closed/);
    h.services.dispose();
    assert.equal(h.listeners.size, 0);
  } finally { await h.close(); }
});

test('renderer reconnect invalidates old sessions, watches and unconfirmed destination plans', async () => {
  const h = await harness();
  try {
    const parent = await h.dispatch('native:grant', { root: h.root }, true) as string;
    const plan = await h.services.project.planCreateChild(parent, 'Pending');
    const opened = await h.dispatch('project:example') as { session: { id: string; manifest: { scenes: { path: string }[] } } };
    await h.dispatch('scene:watch', { session: opened.session.id, path: opened.session.manifest.scenes[0]!.path, watch: 'old' });
    await h.dispatch('bridge:reset');
    await assert.rejects(h.dispatch('catalog:read', { session: opened.session.id }), /closed/);
    await assert.rejects(h.services.project.create(plan.root), /creation plan/);
    await assert.rejects(h.services.project.planCreateChild(parent, 'New'), /not selected/);
  } finally { await h.close(); }
});

test('agent proxy preserves early events and binds cancellation and approval to owned runs', async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  let stopped = 0;
  const calls: string[] = [];
  const agent = { service: {
    refreshProviders: async () => [],
    subscribe: (value: typeof listener) => { listener = value; return () => { listener = undefined; }; },
    start: async () => { listener?.({ type: 'started', runId: 'run', threadId: 'thread', provider: 'codex', sequence: 1, timestamp: new Date().toISOString() }); return { runId: 'run' }; },
    cancel: async (id: string) => { calls.push(`cancel:${id}`); },
    approve: async (id: string, request: string, allow: boolean) => { calls.push(`approve:${id}:${request}:${allow}`); },
  }, stop: async () => { stopped++; } } as unknown as RunningAgentService;
  const h = await harness(agent);
  try {
    const opened = await h.services.project.openExample();
    if (opened.status !== 'opened') throw new Error('Fixture open failed');
    const events: AgentEvent[] = [];
    h.services.agent.service.subscribe(event => events.push(event));
    await h.services.agent.service.start({ threadId: 'thread', projectRoot: opened.session.root, provider: 'codex', permissionMode: 'supervised', prompt: 'Inspect', context: { files: [], entityIds: [], assetIds: [] } });
    assert.equal(events[0]?.type, 'started');
    await assert.rejects(h.services.agent.service.cancel('guessed'), /not owned/);
    await h.services.agent.service.approve('run', 'request', false);
    await h.services.agent.service.cancel('run');
    assert.deepEqual(calls, ['approve:run:request:false', 'cancel:run']);
    await h.bridge.close(); await h.bridge.close();
    assert.equal(stopped, 1); assert.equal(listener, undefined);
  } finally { await h.close(); }
});


test('project services work before agent attachment and late services are stopped after close', async () => {
  const h = await harness();
  let stopped = 0;
  let subscriptions = 0;
  const agent = { service: {
    subscribe: () => { subscriptions++; return () => { subscriptions--; }; },
    refreshProviders: async () => [],
  }, stop: async () => { stopped++; } } as unknown as RunningAgentService;
  try {
    assert.equal((await h.services.project.openExample()).status, 'opened');
    assert.ok(h.services.agent.providers.every(p => p.readiness === 'not-ready'));
    let providerChanges = 0;
    h.services.agent.onProvidersChanged(() => { providerChanges++; });
    await h.bridge.attachAgent(agent);
    assert.equal(providerChanges, 1, 'a late agent start must tell the renderer to re-read providers');
    assert.equal(subscriptions, 1);
    assert.deepEqual(await h.services.agent.refreshProviders(), []);
    await h.bridge.close();
    assert.equal(subscriptions, 0);
    assert.equal(stopped, 1);
    await h.bridge.attachAgent(agent);
    assert.equal(stopped, 2, 'an agent finishing startup after close must stop');
    assert.equal(subscriptions, 0);
  } finally { await h.close(); }
});
