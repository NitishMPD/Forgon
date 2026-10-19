import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createScene } from '@forgon/project-schema';
import { createIsolatedPreview } from '../src/playViewport.js';

function environment() {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldKeyboardEvent = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardEvent');
  Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: class extends Event {
    key: string;
    constructor(type: string, init: KeyboardEventInit) { super(type, init); this.key = init.key ?? ''; }
  } });
  const attributes = new Map<string, string>();
  let removed = false;
  let port: MessagePort;
  let snapshot: unknown;
  const keys: string[] = [];
  const frame = {
    title: '', className: '', src: '', onload: null as (() => void) | null, onerror: null as (() => void) | null,
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    focus() {}, remove() { removed = true; },
    dispatchEvent(event: KeyboardEvent) { assert.equal(event.bubbles, true); keys.push(event.key); return true; },
    contentWindow: { postMessage(data: unknown, _origin: string, ports: MessagePort[]) { snapshot = data; port = ports[0]!; } },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => frame } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'http://127.0.0.1:5173/' }, dispatchEvent() {} } });
  const container = { appendChild() { frame.onload?.(); } } as unknown as HTMLElement;
  return { container, frame, attributes, keys, get removed() { return removed; }, get port() { return port; }, get snapshot() { return snapshot; },
    restore() {
      port?.close();
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
      if (oldKeyboardEvent) Object.defineProperty(globalThis, 'KeyboardEvent', oldKeyboardEvent); else Reflect.deleteProperty(globalThis, 'KeyboardEvent');
    },
  };
}

test('Play snapshot goes to an opaque sandbox; only snapshot assets can cross the port', async () => {
  const env = environment();
  const reads: string[] = [];
  const faults: string[] = [];
  let reportFault!: () => void;
  const reported = new Promise<void>(resolve => { reportFault = resolve; });
  const preview = createIsolatedPreview(env.container, {
    scene: createScene('Play'), catalog: { scripts: [], diagnostics: [] }, prefabs: [],
    assets: [{ id: 'model', name: 'Model', kind: 'model', path: 'assets/model.glb' }], signal: new AbortController().signal,
    readAsset: async id => { reads.push(id); return new Uint8Array([1, 2, 3]); }, onFault: message => { faults.push(message); reportFault(); },
  });
  try {
    assert.equal(env.attributes.get('sandbox'), 'allow-scripts');
    assert.equal(env.frame.src, 'http://127.0.0.1:5173/play.html');
    assert.deepEqual(Object.keys(env.snapshot as object).sort(), ['assets', 'catalog', 'prefabs', 'scene', 'type']);
    env.port.postMessage({ type: 'ready' }); await preview.ready;
    const response = () => new Promise<Record<string, any>>(resolve => { env.port.onmessage = event => resolve(event.data); });
    let received = response(); env.port.postMessage({ type: 'asset', id: 1, assetId: '../../secret' });
    assert.match(String((await received).error), /unavailable/); assert.deepEqual(reads, []);
    received = response(); env.port.postMessage({ type: 'asset', id: 2, assetId: 'model' });
    assert.deepEqual((await received).bytes, new Uint8Array([1, 2, 3])); assert.deepEqual(reads, ['model']);
    env.port.postMessage({ type: 'fault', message: 'Script update failed' });
    await reported;
    assert.deepEqual(faults, ['Script update failed']);
    env.port.postMessage({ type: 'stop' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.deepEqual(env.keys, ['F5'], 'Stop bubbles through the iframe element to the workspace shortcut handler');
  } finally { preview.dispose(); preview.dispose(); assert.equal(env.removed, true); env.restore(); }
});

test('failed startup rejects Play and removes the preview rather than reporting success', async () => {
  const env = environment();
  const preview = createIsolatedPreview(env.container, { scene: createScene('Play'), catalog: { scripts: [], diagnostics: [] }, assets: [], prefabs: [], signal: new AbortController().signal, onFault() {} });
  try {
    env.port.postMessage({ type: 'fault', message: 'Physics failed' });
    await assert.rejects(preview.ready, /Physics failed/);
    assert.equal(env.removed, true);
  } finally { preview.dispose(); env.restore(); }
});

test('Stop while preparing aborts the pending preview and removes its frame', async () => {
  const env = environment(); const controller = new AbortController();
  const preview = createIsolatedPreview(env.container, { scene: createScene('Play'), catalog: { scripts: [], diagnostics: [] }, assets: [], prefabs: [], signal: controller.signal, onFault() {} });
  try {
    controller.abort();
    await assert.rejects(preview.ready, /Play cancelled/); assert.equal(env.removed, true);
  } finally { preview.dispose(); env.restore(); }
});

test('preview entry and native packaging retain the isolation and compiler boundaries', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const entry = read('../src/play.ts');
  assert.doesNotMatch(entry, /studio-desktop|connectDesktop|loadStudioServices/);
  assert.match(entry, /event.source !== parent/);
  const html = read('../play.html');
  assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /ipc:|allow-same-origin/);
  assert.match(read('../vite.config.ts'), /play: 'play.html'/);
  assert.match(read('../../studio-desktop/scripts/bundle.mjs'), /external: \['esbuild'\]/);
  assert.match(read('../../studio-desktop/scripts/bundle.mjs'), /@esbuild\/win32-x64\/esbuild.exe/);
  assert.match(read('../../studio-desktop/src-tauri/src/main.rs'), /on_web_resource_request/);
});
