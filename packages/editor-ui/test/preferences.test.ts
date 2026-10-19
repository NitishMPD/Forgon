import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyAppearance, defaultAppearance, preferencesKey, readPreferences, saveProgressiveDesign, rememberModel, rememberPermission, saveAppearance, type Appearance } from '../src/model/preferences.js';
import type { KeyValueStorage } from '../src/model/layout.js';

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test('appearance and last five distinct models persist without overwriting each other', () => {
  const storage = memoryStorage();
  const appearance: Appearance = { theme: 'light', accent: 'violet', density: 'compact', fontSize: 'large' };
  saveAppearance(appearance, storage);
  for (let index = 0; index < 7; index++) rememberModel({ provider: 'opencode', model: `vendor/model-${index}` }, storage);
  rememberModel({ provider: 'opencode', model: 'vendor/model-4' }, storage);
  assert.deepEqual(readPreferences(storage), {
    appearance,
    lastModel: { provider: 'opencode', model: 'vendor/model-4' },
    recentModels: [4, 6, 5, 3, 2].map(index => ({ provider: 'opencode', model: `vendor/model-${index}` })),
  });
  saveAppearance(defaultAppearance, storage);
  assert.equal(readPreferences(storage).recentModels.length, 5);
  assert.deepEqual(readPreferences(storage).appearance, defaultAppearance);
});

test('preferences validate persisted values, deduplicate recent models and recover from denied storage', () => {
  const storage = memoryStorage();
  for (const raw of ['broken', 'null', '[]', '{"version":2}', '{"appearance":{"theme":"light"}}']) {
    storage.setItem(preferencesKey, raw);
    assert.deepEqual(readPreferences(storage), { appearance: defaultAppearance, recentModels: [] });
  }
  storage.setItem(preferencesKey, JSON.stringify({ version: 1, appearance: { theme: 'light', accent: 'bogus', density: 4, fontSize: 'large' },
    recentModels: [null, { provider: 'bad', model: 'x' }, { provider: 'codex', model: '' }, { provider: 'codex', model: 'm' }, { provider: 'codex', model: 'm' }, { provider: 'opencode', model: 'm' }] }));
  assert.deepEqual(readPreferences(storage), { appearance: { ...defaultAppearance, theme: 'light', fontSize: 'large' }, recentModels: [{ provider: 'codex', model: 'm' }, { provider: 'opencode', model: 'm' }] });
  const denied: KeyValueStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.deepEqual(readPreferences(denied), { appearance: defaultAppearance, recentModels: [] });
  assert.doesNotThrow(() => saveAppearance(defaultAppearance, denied));
  assert.deepEqual(rememberModel({ provider: 'codex', model: 'm' }, denied), [{ provider: 'codex', model: 'm' }]);
});

test('every appearance preference applies to root attributes and is restored before Studio renders', () => {
  const storage = memoryStorage();
  const appearance: Appearance = { theme: 'oled', accent: 'blue', density: 'compact', fontSize: 'small' };
  saveAppearance(appearance, storage);
  const attributes = new Map<string, string>();
  applyAppearance(readPreferences(storage).appearance, { setAttribute: (name, value) => { attributes.set(name, value); } });
  assert.deepEqual(Object.fromEntries(attributes), { 'data-theme': 'oled', 'data-accent': 'blue', 'data-density': 'compact', 'data-font-size': 'small' });
  const startup = readFileSync(new URL('../../../apps/studio/src/main.tsx', import.meta.url), 'utf8');
  assert.ok(startup.indexOf('applyAppearance(readPreferences().appearance') < startup.indexOf("root.textContent = 'Connecting"));
  assert.ok(startup.indexOf('applyAppearance(readPreferences().appearance') < startup.indexOf('createRoot(root)'));
});

test('head script restores appearance before CSS/modules and tolerates missing or corrupt storage', () => {
  const html = readFileSync(new URL('../../../apps/studio/index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.ok(html.indexOf('<script>') < html.indexOf('<link'));
  assert.ok(html.indexOf('<script>') < html.indexOf('type="module"'));
  const storage = memoryStorage();
  const appearance: Appearance = { theme: 'light', accent: 'rose', density: 'compact', fontSize: 'large' };
  saveAppearance(appearance, storage);
  const attributes: Record<string, string> = {};
  runInNewContext(script, { localStorage: storage, document: { documentElement: { setAttribute(name: string, value: string) { attributes[name] = value; } } } });
  assert.deepEqual(attributes, { 'data-theme': 'light', 'data-accent': 'rose', 'data-density': 'compact', 'data-font-size': 'large' });
  for (const raw of [null, 'broken', '[]', '{"version":2,"appearance":{"theme":"light"}}']) {
    assert.doesNotThrow(() => runInNewContext(script, { localStorage: { getItem: () => raw }, document: { documentElement: { setAttribute() { assert.fail('invalid payload'); } } } }));
  }
  assert.doesNotThrow(() => runInNewContext(script, { localStorage: { getItem() { throw new Error('denied'); } } }));
});


test('remembering provider default preserves recents and validates stored choices', () => {
  const storage = memoryStorage();
  rememberModel({ provider: 'codex', model: 'gpt-6.1-sol' }, storage);
  const recent = readPreferences(storage).recentModels;
  rememberModel({ provider: 'claude-code', model: null }, storage);
  saveAppearance(defaultAppearance, storage);
  assert.deepEqual(readPreferences(storage).lastModel, { provider: 'claude-code', model: null });
  assert.deepEqual(readPreferences(storage).recentModels, recent);
  for (const lastModel of [null, [], { provider: 'bad', model: 'm' }, { provider: 'codex', model: '' }, { provider: 'codex', model: 3 }]) {
    storage.setItem(preferencesKey, JSON.stringify({ version: 1, lastModel }));
    assert.equal(readPreferences(storage).lastModel, undefined);
  }
});

test('model, reasoning and explicit permissions survive reload without overwriting appearance or each other', () => {
  const storage = memoryStorage();
  saveAppearance({ ...defaultAppearance, accent: 'blue' }, storage);
  rememberModel({ provider: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] }, storage);
  rememberPermission('codex', 'full-local', storage);
  rememberPermission('opencode', 'auto', storage);
  const reloaded = readPreferences(storage);
  assert.deepEqual(reloaded.lastModel, { provider: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] });
  assert.deepEqual(reloaded.permissionModes, { codex: 'full-local', opencode: 'auto' });
  assert.equal(reloaded.appearance.accent, 'blue');
  rememberModel({ provider: 'codex', model: 'other' }, storage);
  assert.deepEqual(readPreferences(storage).permissionModes, reloaded.permissionModes);
  assert.equal(readPreferences(storage).lastModel?.options, undefined);
});

test('Progressive design persists independently of model, permissions and appearance', () => {
  const storage = memoryStorage();
  assert.equal(readPreferences(storage).progressiveDesign ?? false, false);
  saveProgressiveDesign(true, storage);
  rememberModel({ provider: 'codex', model: 'm' }, storage);
  rememberPermission('codex', 'full-local', storage);
  saveAppearance({ ...defaultAppearance, theme: 'light' }, storage);
  assert.equal(readPreferences(storage).progressiveDesign, true);
  saveProgressiveDesign(false, storage);
  assert.equal(readPreferences(storage).progressiveDesign, false);
  assert.equal(readPreferences(storage).lastModel?.model, 'm');
  assert.equal(readPreferences(storage).permissionModes?.codex, 'full-local');
  storage.setItem(preferencesKey, JSON.stringify({ version: 1, progressiveDesign: 'true' }));
  assert.equal(readPreferences(storage).progressiveDesign, undefined);
});
