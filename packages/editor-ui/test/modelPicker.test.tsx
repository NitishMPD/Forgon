import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPicker, ModelPickerPanel } from '../src/agent/ModelPicker.js';
import { ProviderModels } from '../src/agent/ProviderModels.js';
import { matchesModel, modelLabel, modelOptions, modelRenderCap } from '../src/agent/modelPickerModel.js';
import { defaultAgentThread, modelSelectionAction } from '../src/agent/useAgentSessions.js';
import { agentReducer, canChangeProvider, newThread, type AgentState } from '../src/agent/threadState.js';
import type { AgentProviderInfo } from '../src/services.js';
import { PermissionPicker, PermissionPickerPanel } from '../src/agent/PermissionPicker.js';
import { defaultAppearance, readPreferences, rememberModel } from '../src/model/preferences.js';
import { AppearanceSettings } from '../src/theme/AppearanceSettings.js';
import { Settings } from '../src/shell/Settings.js';

const providers: AgentProviderInfo[] = [
  { id: 'codex', name: 'Codex', readiness: 'ready', models: ['gpt-6.1-sol'], permissionModes: ['inspect', 'supervised'] },
  { id: 'claude-code', name: 'Claude Code', readiness: 'ready', models: ['claude-opus-4.7'], permissionModes: ['supervised'] },
  { id: 'opencode', name: 'OpenCode', readiness: 'ready', models: ['openrouter/anthropic/claude-opus-4.7', 'opencode/gpt-6.1-sol', 'deepinfra/Qwen/Qwen3', 'nvidia/nemotron', 'anthropic/claude-sonnet'], permissionModes: ['full-local'] },
];
type Element = ReactElement<Record<string, any>>;
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, any>>(child)) continue;
    if (predicate(child)) return child;
    const nested = find(child.props.children, predicate);
    if (nested) return nested;
  }
  return undefined;
}
function control(node: ReactNode, predicate: (element: Element) => boolean): Element {
  const element = find(node, predicate); assert.ok(element); return element;
}

test('model search matches full IDs and friendly labels across word boundaries, case and punctuation', () => {
  assert.equal(matchesModel('openrouter/anthropic/claude-opus-4.7', 'CLAUDE opus'), true);
  assert.equal(matchesModel('deepinfra/Qwen/Qwen3', 'deepinfra qwen3'), true);
  assert.equal(matchesModel('gpt-6.1-sol', 'gpt 6.1'), true);
  assert.equal(matchesModel('claude-opus-4.7', 'gpt'), false);
  assert.deepEqual(modelLabel('openrouter/anthropic/claude-opus-4.7', 'opencode'), { label: 'anthropic/Claude Opus 4.7', vendor: 'openrouter' });
  const matches = modelOptions(providers, [], 'claude opus').options;
  assert.equal(matches.length, 2);
  assert.ok(matches.every(option => option.model?.includes('claude-opus')));
});

test('catalog groups providers and OpenCode vendors, puts valid recents first, and supplies defaults', () => {
  const { options } = modelOptions(providers, [
    { provider: 'opencode', model: 'deepinfra/Qwen/Qwen3' },
    { provider: 'codex', model: 'no-longer-reported' },
  ], '');
  assert.equal(options[0]?.group, 'Recent');
  assert.equal(options[0]?.model, 'deepinfra/Qwen/Qwen3');
  assert.equal(options.filter(option => option.model === 'deepinfra/Qwen/Qwen3').length, 1);
  for (const group of ['Codex', 'Claude Code', 'OpenCode', 'OpenCode / openrouter', 'OpenCode / opencode', 'OpenCode / nvidia', 'OpenCode / anthropic']) {
    assert.ok(options.some(option => option.group === group), group);
  }
  assert.equal(options.filter(option => option.model === null).length, 3);
  assert.equal(new Set(options.map(option => option.key)).size, options.length);
});

test('600+ models render at most 100 options and search reaches models beyond the cap', () => {
  const provider = { ...providers[2]!, models: Array.from({ length: 601 }, (_, index) => `vendor/model-${index}`) };
  const result = modelOptions([provider], [], '');
  assert.equal(result.options.length, modelRenderCap);
  assert.equal(result.remaining, 502);
  assert.equal(modelOptions([provider], [], 'model-600').options[0]?.model, 'vendor/model-600');
  const html = renderToStaticMarkup(ModelPickerPanel({ id: 'test', providers: [provider], providerId: 'opencode', recent: [], onProvider() {}, query: '', active: 0, thread: newThread('t', 'opencode', null, null), triggerRef: { current: null }, searchRef: { current: null }, onQuery() {}, onActive() {}, onSelect() {}, onClose() {} }));
  assert.equal((html.match(/role="option"/g) ?? []).length, 100);
  assert.match(html, /502 more — refine search/);
});

test('picker keyboard navigation wraps, Enter selects, IME is ignored, and Escape restores trigger focus', () => {
  const result = modelOptions([providers[0]!], [], '');
  const thread = newThread('t', 'codex', 'supervised', null);
  let active = 0, query = '', closed = 0, focused = 0;
  const selected: unknown[] = [];
  const triggerRef = { current: { focus() { focused++; } } as HTMLButtonElement };
  const render = () => ModelPickerPanel({ id: 'test', providers, providerId: 'codex', recent: [], onProvider() {}, query, active, thread, triggerRef, searchRef: { current: null },
    onQuery: value => { query = value; }, onActive: value => { active = value; }, onSelect: option => { selected.push(option); }, onClose: () => { closed++; } });
  const input = () => control(render(), element => element.props.role === 'combobox');
  const key = (name: string, composing = false) => input().props.onKeyDown({ key: name, nativeEvent: { isComposing: composing }, preventDefault() {} });
  key('ArrowUp'); assert.equal(active, result.options.length - 1);
  key('ArrowDown'); assert.equal(active, 0);
  key('ArrowDown'); assert.equal(active, 1);
  key('Enter', true); assert.equal(selected.length, 0);
  key('Enter'); assert.deepEqual(selected, [result.options[1]]); assert.equal(closed, 1); assert.equal(focused, 1);
  input().props.onChange({ currentTarget: { value: 'opus' } }); assert.equal(query, 'opus');
  let stopped = false;
  render().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal(closed, 2); assert.equal(focused, 2);
  assert.equal(input().props['aria-controls'], 'test-list');
  input().props.onChange({ currentTarget: { value: '' } });
  assert.equal(input().props['aria-activedescendant'], 'test-option-1');
  const option = control(render(), element => element.props.id === 'test-option-0');
  assert.equal(option.props['aria-selected'], true);
  option.props.onClick(); assert.equal(focused, 3);
});

test('empty search results have no active descendant or keyboard selection', () => {
  const panel = ModelPickerPanel({ id: 'empty', providers, providerId: 'codex', recent: [], onProvider() {}, query: 'missing', active: 0, thread: newThread('t', 'codex', null, null),
    triggerRef: { current: null }, searchRef: { current: null }, onQuery() {}, onActive() { assert.fail(); }, onSelect() { assert.fail(); }, onClose() {} });
  const input = control(panel, element => element.props.role === 'combobox');
  assert.equal(input.props['aria-activedescendant'], undefined);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) input.props.onKeyDown({ key, nativeEvent: {}, preventDefault() {} });
  assert.match(renderToStaticMarkup(panel), /No models match/);
});

test('cross-provider selection is atomic, validates model membership, and never silently picks full-local', () => {
  const thread = newThread('t', 'codex', 'supervised', null);
  const state: AgentState = { threads: [thread], activeThreadId: thread.id };
  const action = modelSelectionAction(thread, providers, 'openrouter/anthropic/claude-opus-4.7', 'opencode');
  assert.ok(action);
  const switched = agentReducer(state, action).threads[0]!;
  assert.equal(switched.provider, 'opencode'); assert.equal(switched.model, 'openrouter/anthropic/claude-opus-4.7'); assert.equal(switched.permissionMode, null);
  const claude = modelSelectionAction(thread, providers, 'claude-opus-4.7', 'claude-code');
  assert.ok(claude); assert.equal(agentReducer(state, claude).threads[0]?.permissionMode, 'supervised');
  assert.equal(modelSelectionAction(thread, providers, 'not-reported'), null);
  assert.equal(modelSelectionAction(thread, [], null), null);
  assert.ok(modelSelectionAction(thread, providers, null, 'opencode'));
});

test('started, failed and running threads keep provider identity; idle same-provider model changes work', () => {
  const fresh = newThread('t', 'codex', 'supervised', null);
  assert.equal(canChangeProvider(fresh), true);
  for (const thread of [
    { ...fresh, starting: true }, { ...fresh, activeRunId: 'run' },
    { ...fresh, transcript: [{ id: 'u', kind: 'user' as const, text: 'hello' }] },
    { ...fresh, outcome: 'failed' as const }, { ...fresh, sequences: { run: 1 } },
  ]) {
    assert.equal(canChangeProvider(thread), false);
    assert.equal(modelSelectionAction(thread, providers, null, 'opencode'), null);
    const state: AgentState = { threads: [thread], activeThreadId: thread.id };
    assert.equal(agentReducer(state, { type: 'thread/settings', threadId: thread.id, provider: 'opencode', model: 'opencode/gpt-6.1-sol' }).threads[0], thread);
    const action = modelSelectionAction(thread, providers, 'gpt-6.1-sol');
    if (thread.starting) assert.equal(action, null);
    else { assert.ok(action); assert.equal(agentReducer(state, action).threads[0]?.model, 'gpt-6.1-sol'); }
  }
});

test('locked picker explains provider restriction, trigger shows model and stays enabled during runs', () => {
  const thread = newThread('t', 'codex', 'supervised', 'gpt-6.1-sol');
  thread.transcript.push({ id: 'u', kind: 'user', text: 'hello' });
  const html = renderToStaticMarkup(ModelPickerPanel({ id: 'locked', providers, providerId: 'codex', recent: [], onProvider() {}, query: '', active: 0, thread, triggerRef: { current: null }, searchRef: { current: null }, onQuery() {}, onActive() {}, onSelect() {}, onClose() {} }));
  assert.match(html, /Provider is fixed after a thread starts/); assert.match(html, /role="tab"[^>]*disabled=""/);
  thread.activeRunId = 'run';
  const runningPanel = renderToStaticMarkup(ModelPickerPanel({ id: 'running', providers, providerId: 'codex', recent: [], onProvider() {}, query: '', active: 0, thread, triggerRef: { current: null }, searchRef: { current: null }, onQuery() {}, onActive() {}, onSelect() {}, onClose() {} }));
  assert.match(runningPanel, /Applies to your next message/);
  const trigger = renderToStaticMarkup(<ModelPicker providers={providers} thread={thread} onSelect={() => {}} />);
  assert.match(trigger, /GPT 6.1 Sol/); assert.match(trigger, /aria-haspopup="dialog"/); assert.doesNotMatch(trigger, /disabled=""/);
  thread.starting = true;
  assert.match(renderToStaticMarkup(<ModelPicker providers={providers} thread={thread} onSelect={() => {}} />), /disabled=""/);
});

test('provider catalog starts collapsed with count, search and only twelve rows instead of pills', () => {
  const provider = { ...providers[2]!, readiness: 'not-ready' as const, models: Array.from({ length: 601 }, (_, index) => `vendor/model-${index}`) };
  const html = renderToStaticMarkup(<ProviderModels provider={provider} />);
  assert.match(html, /<details class="fg-provider-models"><summary>601 models<\/summary>/);
  assert.match(html, /aria-label="Search OpenCode models"/); assert.match(html, /Show all/);
  assert.equal((html.match(/<li /g) ?? []).length, 12); assert.doesNotMatch(html, /fg-chip/);
  const settings = renderToStaticMarkup(<Settings providers={[provider]} onResetLayout={() => {}} />);
  assert.match(settings, /601 models/); assert.match(settings, /opencode auth login/); assert.match(settings, /Full local/);
});

test('Appearance is discoverable in Settings with labelled theme, accent, density and size controls', () => {
  const html = renderToStaticMarkup(<AppearanceSettings />);
  for (const label of ['Theme', 'Accent color', 'UI density', 'Font size']) assert.match(html, new RegExp(`<label[^>]*><span>${label}<\\/span><select`));
  for (const choice of ['Darker / OLED', 'Light', 'Ember', 'Blue', 'Violet', 'Green', 'Rose', 'Amber', 'Comfortable', 'Compact', 'Small', 'Default', 'Large']) assert.match(html, new RegExp(choice));
  assert.match(renderToStaticMarkup(<Settings providers={[]} onResetLayout={() => {}} />), />Appearance<\/button>/);
});


test('provider tabs switch the displayed catalog, reset search, and support roving arrow keys', () => {
  const thread = newThread('t', 'codex', 'supervised', null);
  let providerId = thread.provider, query = '', active = 0, focused = '';
  const render = () => ModelPickerPanel({ id: 'tabs', providers, providerId, recent: [], query, active, thread,
    triggerRef: { current: null }, searchRef: { current: null }, onProvider(value) { providerId = value; query = ''; active = 0; },
    onQuery(value) { query = value; active = 0; }, onActive(value) { active = value; }, onSelect() {}, onClose() {} });
  const tab = (name: string) => control(render(), element => element.props.id === `tabs-tab-${name}`);
  const html = () => renderToStaticMarkup(render());
  assert.match(html(), /gpt-6.1-sol/); assert.doesNotMatch(html(), /claude-opus-4.7/);
  tab('claude-code').props.onClick();
  assert.equal(providerId, 'claude-code'); assert.match(html(), /claude-opus-4.7/); assert.doesNotMatch(html(), /gpt-6.1-sol/);
  const key = (name: string) => tab(providerId).props.onKeyDown({ key: name, preventDefault() {}, currentTarget: {
    parentElement: { querySelector(selector: string) { return { focus() { focused = selector; } }; } },
  } });
  key('ArrowRight'); assert.equal(providerId, 'opencode'); assert.match(focused, /tab-opencode/);
  key('ArrowRight'); assert.equal(providerId, 'codex');
  key('ArrowLeft'); assert.equal(providerId, 'opencode');
  control(render(), element => element.props.role === 'combobox').props.onChange({ currentTarget: { value: 'claude opus' } });
  assert.match(html(), /openrouter\/anthropic\/claude-opus-4.7/); assert.doesNotMatch(html(), /opencode\/gpt-6.1-sol/);
  tab('claude-code').props.onClick(); assert.equal(query, '');
  assert.equal(tab('claude-code').props.tabIndex, 0); assert.equal(tab('codex').props.tabIndex, -1);
  key('Home'); assert.equal(providerId, 'codex'); key('End'); assert.equal(providerId, 'opencode');
});

test('unavailable providers show their readiness message instead of selectable models', () => {
  const provider = { ...providers[1]!, readiness: 'not-ready' as const, message: 'Sign in with claude first.' };
  const panel = ModelPickerPanel({ id: 'unavailable', providers: [provider], providerId: provider.id, recent: [], query: '', active: 0,
    thread: newThread('t', 'codex', null, null), triggerRef: { current: null }, searchRef: { current: null },
    onProvider() {}, onQuery() {}, onActive() {}, onSelect() { assert.fail(); }, onClose() {} });
  const html = renderToStaticMarkup(panel);
  assert.match(html, /Sign in with claude first/); assert.doesNotMatch(html, /role="option"/);
});

test('started thread tabs cannot switch provider even if their handler is called', () => {
  const thread = { ...newThread('t', 'codex', 'supervised', null), activeRunId: 'run' };
  const panel = ModelPickerPanel({ id: 'locked', providers, providerId: 'codex', recent: [], query: '', active: 0, thread,
    triggerRef: { current: null }, searchRef: { current: null }, onProvider() { assert.fail(); }, onQuery() {}, onActive() {}, onSelect() {}, onClose() {} });
  const tab = control(panel, element => element.props.id === 'locked-tab-opencode');
  assert.equal(tab.props.disabled, true); tab.props.onClick();
});

test('remembered choice seeds new threads and catalog changes fall back safely without full-local', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  rememberModel({ provider: 'claude-code', model: 'claude-opus-4.7' }, storage);
  let thread = defaultAgentThread('new', providers, readPreferences(storage))!;
  assert.equal(thread.provider, 'claude-code'); assert.equal(thread.model, 'claude-opus-4.7'); assert.equal(thread.permissionMode, 'supervised');
  thread = defaultAgentThread('new', providers.map(provider => ({ ...provider, models: [] })), readPreferences(storage))!;
  assert.equal(thread.provider, 'claude-code'); assert.equal(thread.model, null);
  thread = defaultAgentThread('new', [providers[0]!], readPreferences(storage))!;
  assert.equal(thread.provider, 'codex'); assert.equal(thread.model, null);
  rememberModel({ provider: 'opencode', model: null }, storage);
  thread = defaultAgentThread('new', providers, readPreferences(storage))!;
  assert.equal(thread.provider, 'opencode'); assert.equal(thread.model, null); assert.equal(thread.permissionMode, null);
  thread = defaultAgentThread('new', providers.map(provider => provider.id === 'opencode' ? { ...provider, readiness: 'not-ready' } : provider), readPreferences(storage))!;
  assert.equal(thread.provider, 'codex');
  assert.equal(defaultAgentThread('empty', [], { appearance: defaultAppearance, recentModels: [] }), null);
});

test('permission picker lists only supported modes with descriptions; selection and Escape close and return focus', () => {
  let focused = 0, closed = 0;
  const selected: unknown[] = [];
  const panel = PermissionPickerPanel({ id: 'permissions', provider: providers[0]!, value: 'supervised',
    triggerRef: { current: { focus() { focused++; } } as HTMLButtonElement }, onSelect(mode) { selected.push(mode); }, onClose() { closed++; } });
  const html = renderToStaticMarkup(panel);
  assert.match(html, /Inspect/); assert.match(html, /Supervised/); assert.match(html, /not an operating-system sandbox/);
  assert.doesNotMatch(html, /Full local|Auto edits/);
  control(panel, element => element.type === 'button' && element.props['aria-pressed'] === false).props.onClick();
  assert.deepEqual(selected, ['inspect']); assert.equal(closed, 1); assert.equal(focused, 1);
  panel.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(closed, 2); assert.equal(focused, 2);
  const buttons = [0, 1].map(index => ({ focus() { focused = index; } }));
  panel.props.onKeyDown({ key: 'ArrowUp', preventDefault() {}, currentTarget: { querySelectorAll() { return buttons; } }, target: buttons[0] });
  assert.equal(focused, 1);
});

test('permission trigger explains absent modes, disables only unavailable modes or launch, and marks full-local', () => {
  const render = (permissionModes: AgentProviderInfo['permissionModes'], starting = false) => renderToStaticMarkup(<PermissionPicker provider={{ ...providers[0]!, permissionModes }} value={null} starting={starting} onSelect={() => {}} />);
  assert.match(render([]), /disabled=""/); assert.match(render([]), /did not report supported permission modes/);
  assert.doesNotMatch(render(['supervised']), /disabled=""/); assert.match(render(['supervised'], true), /disabled=""/);
  const full = renderToStaticMarkup(<PermissionPicker provider={providers[2]!} value="full-local" starting={false} onSelect={() => {}} />);
  assert.match(full, /fg-tone-warning/); assert.match(full, /No approval prompts/);
});
