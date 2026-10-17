import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import * as three from 'three';
import { Group, Object3D } from 'three';
import { fileURLToPath } from 'node:url';
import { createEntity, createScene, type Component, type ScriptModules } from '@forgon/project-schema';
import { defineScript, loadScriptModule, prop, type ScriptContext } from '../src/scripting/index.js';
import { createScriptHost } from '../src/scripting/host.js';
import { createPlaySession } from '../src/runtime/play-session.js';
import { createInputState } from '../src/runtime/parkour.js';
import type { RuntimeEvent } from '../src/core/types.js';
import { createInputSource } from '../src/runtime/input.js';
import { compileProjectScripts } from '../../project-io/src/scripting.js';
import { createSectorFixture } from '../../test-fixtures/src/index.js';
import { projectScene } from '../src/core/reconcile.js';
import { disposeGraph } from '../src/core/projection.js';

function script(id: string, src = `scripts/${id}.ts`, params: Record<string, number> = {}): Component {
  return { id, type: 'script', enabled: true, properties: { src, params }, entityRefs: [], assetRefs: [] };
}
const emptyInput = { down: () => false, pressed: () => false };
test('checked-in Sector scripts compile, load against the real authoring API, and animate their visible attachment', async () => {
  const catalog = await compileProjectScripts(fileURLToPath(new URL('../../../examples/sector', import.meta.url)));
  assert.deepEqual(catalog.diagnostics, []); assert.equal(catalog.scripts.length, 2);
  const modules: Record<string, { default: unknown }> = {};
  for (const script of catalog.scripts) {
    const compiled = await import(`data:text/javascript;base64,${Buffer.from(script.code).toString('base64')}`);
    modules[script.src] = compiled.load({ three, '@forgon/game-runtime/scripting': { defineScript, prop } });
  }
  const scene = createSectorFixture().scenes[0]!;
  const root = new Group(); const projection = projectScene(root, scene, true);
  const attachment = scene.entities.find(entity => entity.components.some(component => component.properties.src === 'scripts/spinner.ts'))!;
  const object = projection.registry.byId.get(attachment.id)!;
  const baseline = object.position.y; const orientation = object.quaternion.clone();
  const host = createScriptHost({ scene, entities: projection.registry.byId, scripts: modules, input: emptyInput, onFault: message => assert.fail(message) });
  try {
    host.update(0.25);
    assert.ok(orientation.angleTo(object.quaternion) > 0.3);
    assert.ok(Math.abs(object.position.y - (baseline + Math.sin(0.25 * 0.8 * Math.PI * 2) * 0.25)) < 1e-9);
    assert.equal(attachment.transform.position[1], baseline, 'authoring data is untouched');
  } finally { host.stop(); disposeGraph(root); projection.materials.dispose(); }
});
test('module loading injects the exact runtime Three.js instance and aborts stale Play requests before project execution', async t => {
  const source = `export function load(modules) { return { default: { Object3D: modules.three.Object3D, defineScript: modules['@forgon/game-runtime/scripting'].defineScript } }; }`;
  const create = t.mock.method(URL, 'createObjectURL', () => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  const loaded = await loadScriptModule('compiled ESM factory');
  assert.equal((loaded.default as { Object3D: unknown }).Object3D, Object3D);
  assert.equal((loaded.default as { defineScript: unknown }).defineScript, defineScript);
  assert.equal(revoke.mock.calls.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadScriptModule('never evaluate', controller.signal), /abort/i);
  assert.equal(create.mock.calls.length, 1);
  const pending = new AbortController();
  const promise = loadScriptModule('never evaluate stale code', pending.signal); pending.abort();
  await assert.rejects(promise, /abort/i);
  assert.equal(revoke.mock.calls.length, 2, 'cancelled module URLs are also released');
});
test('runtime keyboard source snapshots raw key down/pressed edges without a second input listener', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const windowEvents = new EventTarget(); const documentEvents = new EventTarget(); const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { value: windowEvents, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: documentEvents, configurable: true });
  const send = (type: string, code: string) => windowEvents.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  const input = createInputSource(target as HTMLElement);
  try {
    send('keydown', 'KeyE'); send('keydown', 'KeyE');
    let sample = input.sample(0.1); assert.deepEqual(sample.keysDown, ['KeyE']); assert.deepEqual(sample.keysPressed, ['KeyE']);
    sample = input.sample(0.1); assert.deepEqual(sample.keysDown, ['KeyE']); assert.deepEqual(sample.keysPressed, []);
    send('keyup', 'KeyE'); assert.deepEqual(input.sample(0.1).keysDown, []);
    send('keydown', 'KeyE'); assert.deepEqual(input.sample(0.1).keysPressed, ['KeyE']);
    windowEvents.dispatchEvent(new Event('blur')); assert.deepEqual(input.sample(0.1).keysDown, []);
    input.dispose(); send('keydown', 'KeyW'); assert.deepEqual(input.sample(0.1).keysDown, []);
  } finally {
    input.dispose();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
test('scripts instantiate in scene and component order, apply typed defaults, isolate mutable params and find stable entities', () => {
  const scene = createScene('Scripts');
  const a = createEntity('A'); const b = createEntity('B');
  a.components = [script('a'), script('b', 'scripts/a.ts', { speed: 2 })];
  b.components = [script('c')]; scene.entities = [a, b];
  const oa = new Object3D(); oa.name = 'A'; const ob = new Object3D(); ob.name = 'B';
  const calls: string[] = []; const contexts: ScriptContext[] = [];
  const definition = defineScript({ props: { speed: prop.number(90), offset: prop.vec3([1, 2, 3]), target: prop.entity(), mode: prop.enum('walk', ['walk', 'run']) },
    start(ctx) {
      calls.push(`start:${ctx.entity.name}:${ctx.params.speed.toFixed(0)}`);
      assert.equal(ctx.find(b.id), ob); assert.equal(ctx.findByName('B'), ob); assert.equal(ctx.find('missing'), undefined);
      assert.equal(ctx.params.target, null); assert.equal(ctx.params.mode, 'walk');
      contexts.push(ctx as unknown as ScriptContext); ctx.params.offset[0] = ctx.params.speed;
    },
    update(ctx, dt) { calls.push(`update:${ctx.entity.name}:${dt}`); assert.equal(ctx.time.dt, dt); assert.equal(ctx.time.elapsed, dt); },
    destroy(ctx) { calls.push(`destroy:${ctx.entity.name}`); },
  });
  const host = createScriptHost({ scene, entities: new Map([[b.id, ob], [a.id, oa]]), scripts: { 'scripts/a.ts': { default: definition }, 'scripts/c.ts': { default: definition } }, input: emptyInput, onFault: message => assert.fail(message) });
  assert.deepEqual(calls, ['start:A:90', 'start:A:2', 'start:B:90']);
  assert.notEqual(contexts[0]!.params.offset, contexts[1]!.params.offset);
  assert.deepEqual(definition.props.offset.default, [1, 2, 3]);
  host.update(0.5); host.stop(); host.stop(); host.update(1);
  assert.deepEqual(calls.slice(3), ['update:A:0.5', 'update:A:0.5', 'update:B:0.5', 'destroy:A', 'destroy:A', 'destroy:B']);
});
test('throwing hooks and event listeners disable only the failing attachment and all subscriptions are removed on Stop', () => {
  const scene = createScene('Faults'); const entity = createEntity('A');
  entity.components = ['start', 'update', 'listener', 'healthy', 'missing'].map(id => script(id)); scene.entities = [entity];
  const calls: string[] = []; const faults: string[] = []; let retained: ScriptContext | undefined;
  const scripts: ScriptModules = {
    'scripts/start.ts': { default: defineScript({ props: {}, start() { throw new Error('start failed'); }, update() { assert.fail('disabled start'); }, destroy() { calls.push('destroy start'); } }) },
    'scripts/update.ts': { default: defineScript({ props: {}, update() { calls.push('bad update'); throw new Error('update failed'); }, destroy() { throw new Error('destroy failed'); } }) },
    'scripts/listener.ts': { default: defineScript({ props: {}, start(ctx) { ctx.on('ping', () => { calls.push('listener'); throw new Error('listener failed'); }); }, update() { calls.push('listener update'); } }) },
    'scripts/healthy.ts': { default: defineScript({ props: {}, start(ctx) { retained = ctx; ctx.on('ping', () => calls.push('healthy listener')); }, update(ctx) { calls.push('healthy update'); ctx.emit('ping', 1); }, destroy() { calls.push('destroy healthy'); } }) },
  };
  const host = createScriptHost({ scene, entities: new Map([[entity.id, new Object3D()]]), scripts, input: emptyInput, onFault: message => faults.push(message) });
  host.update(0.1); host.update(0.1); host.stop();
  assert.equal(calls.filter(call => call === 'bad update').length, 1);
  assert.equal(calls.filter(call => call === 'listener').length, 1);
  assert.equal(calls.filter(call => call === 'healthy update').length, 2);
  assert.equal(calls.filter(call => call === 'healthy listener').length, 2);
  assert.equal(faults.length, 5);
  for (const fault of faults) assert.ok(fault.includes(entity.id) && fault.includes('scripts/'));
  const before = [...calls]; retained!.emit('ping'); host.update(1);
  assert.deepEqual(calls, before);
});
test('host shares input and scene events, supports unsubscribe and skips disabled entities/components/ancestors', () => {
  const scene = createScene('Input'); const entity = createEntity('A'); const child = createEntity('Child', entity.id);
  const disabled = createEntity('Disabled'); disabled.enabled = false;
  entity.components = [script('a'), { ...script('disabled'), enabled: false }]; child.components = [script('child')]; disabled.components = [script('hidden')];
  scene.entities = [entity, child, disabled];
  const object = new Object3D(); const childObject = new Object3D(); const hiddenParent = new Object3D(); hiddenParent.visible = false; hiddenParent.add(childObject);
  let received = 0; let context: ScriptContext | undefined; const logs: string[] = [];
  const host = createScriptHost({ scene, entities: new Map([[entity.id, object], [child.id, childObject], [disabled.id, new Object3D()]]), input: { down: key => key === 'KeyW', pressed: key => key === 'jump' },
    scripts: { 'scripts/a.ts': { default: defineScript({ props: {}, start(ctx) { context = ctx; assert.ok(ctx.input.down('KeyW')); assert.ok(ctx.input.pressed('jump')); ctx.log('hello', 3); } }) } }, onFault: message => assert.fail(message), log: message => logs.push(message) });
  const unsubscribe = context!.on('event', value => { received += Number(value); });
  context!.emit('event', 2); unsubscribe(); context!.emit('event', 3);
  assert.equal(received, 2); assert.match(logs[0]!, /hello 3/); host.stop();
});

async function bootAmmo(): Promise<void> {
  const require = createRequire(import.meta.url);
  const source = await readFile(new URL('../vendor/ammo.wasm.js', import.meta.url), 'utf8');
  const module = { exports: {} as unknown };
  const factory = new Function('module', 'exports', 'require', '__dirname', source + '\nreturn module.exports;')(module, module.exports, require, new URL('../vendor/', import.meta.url).pathname);
  (globalThis as typeof globalThis & { Ammo: unknown }).Ammo = await factory({ wasmBinary: await readFile(new URL('../vendor/ammo.wasm.wasm', import.meta.url)) });
}
test('Play runs scripts on detached objects, samples existing input once, reports faults, and Stop tears down before the graph', async () => {
  await bootAmmo();
  const scene = createScene('Play scripts'); const entity = createEntity('Cube'); const camera = createEntity('Camera');
  entity.components = [script('spin')]; camera.components = [{ id: 'camera', type: 'camera', enabled: true, properties: {}, entityRefs: [], assetRefs: [] }];
  scene.entities = [entity, camera];
  let samples = 0; let started = 0; let destroyed = 0; let object: Object3D | undefined;
  const events: RuntimeEvent[] = []; const world = new Group(); const editRoot = new Group(); world.add(editRoot);
  const session = createPlaySession({ world, editRoot, onRuntimeEvent: event => events.push(event), input: { sample() { samples++; return { state: { ...createInputState(), jump: samples === 1, jumpHeld: true }, yaw: 0, pitch: 0, manual: false, restart: false, keysDown: ['KeyW'], keysPressed: samples === 1 ? ['KeyW'] : [] }; } },
    scripts: { 'scripts/spin.ts': { default: defineScript({ props: { speed: prop.number(2) }, start(ctx) { object = ctx.entity; started++; assert.equal(ctx.time.elapsed, 0); }, update(ctx, dt) { ctx.entity.rotation.y += ctx.params.speed * dt; assert.equal(ctx.input.pressed('KeyW'), samples === 1); assert.equal(ctx.input.pressed('jump'), samples === 1); assert.ok(ctx.input.down('KeyW')); }, destroy(ctx) { assert.ok(ctx.entity.parent, 'destroy runs while scene is still attached'); destroyed++; } }) } },
  });
  assert.equal(started, 0); session.start(scene); assert.equal(started, 1);
  session.update(0.25); session.update(0.25);
  assert.equal(samples, 2); assert.equal(object!.rotation.y, 1); assert.deepEqual(entity.transform.rotationEuler, [0, 0, 0]);
  session.stop(); session.stop(); session.update(1);
  assert.equal(destroyed, 1); assert.equal(samples, 2); assert.equal(session.isPlaying, false); assert.ok(editRoot.visible);
  assert.deepEqual(events.map(event => event.type), ['play-started', 'play-stopped']); session.dispose();
});
