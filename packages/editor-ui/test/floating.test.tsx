import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorStore } from '@forgon/editor-core';
import { createEntity, createScene } from '@forgon/project-schema';
import { ViewportTools } from '../src/shell/ViewportTools.js';
import { Workspace, type WorkspaceProps } from '../src/shell/Workspace.js';
import { AgentDock, type AgentDockProps } from '../src/agent/AgentDock.js';
import { PermissionPicker } from '../src/agent/PermissionPicker.js';
import { ModelPicker } from '../src/agent/ModelPicker.js';
import { ConsolePanel } from '../src/panels/console/ConsolePanel.js';
import { newThread, threadStatus } from '../src/agent/threadState.js';
import type { AgentController } from '../src/agent/useAgentSessions.js';
import { readEditorSnapshot } from '../src/hooks/useEditorSnapshot.js';
import { defaultLayout, defaultSnap, toggleCard, cardIds, readLayout, writeLayout, parseLayout, type LayoutState } from '../src/model/layout.js';
import { emptyLog } from '../src/model/consoleLog.js';
import type { ViewportHandle } from '../src/services.js';

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
function control(tree: ReactNode, name: string): Element {
  const found = find(tree, element => element.props.label === name || element.props['aria-label'] === name || element.props.id === name);
  assert.ok(found, name);
  return found;
}
function probe(render: () => ReactElement): { tree: ReactElement; html: string } {
  let tree!: ReactElement;
  function Probe() { tree = render(); return tree; }
  return { html: renderToStaticMarkup(<Probe />), get tree() { return tree; } };
}
function workspace(overrides: Partial<WorkspaceProps> = {}) {
  const scene = { ...createScene('Test'), entities: [createEntity('Cube')] };
  const props: WorkspaceProps = {
    projectName: 'Test', source: 'project', sourcePath: 'scene.json', snapshot: readEditorSnapshot(new EditorStore(scene, 'r1')),
    selection: { entityIds: [], primaryId: null }, onSelect() {}, onCommand: () => true, onUndo() {}, onRedo() {},
    onSave: async () => true, saveStatus: 'idle', saveDisabledReason: null, banner: null, onDismissBanner() {}, onResolveConflict() {},
    scenes: [], onSwitchScene() {}, notice: null, onDismissNotice() {}, assets: [], log: emptyLog, onLog() {}, agent: null,
    viewport: null, layout: defaultLayout, onLayoutChange() {}, onClose() {}, ...overrides,
  };
  return probe(() => Workspace(props));
}

test('logo and project close share the dirty and saving guards', () => {
  for (const label of ['Back to projects', 'Close project']) {
    let closed = 0;
    const clean = workspace({ onClose: () => { closed++; } });
    control(clean.tree, label).props.onClick();
    assert.equal(closed, 1);
    assert.match(clean.html, /<button[^>]*aria-label="Back to projects"/);
    assert.match(clean.html, /lucide-folder-x/);
    assert.doesNotMatch(clean.html, /lucide-log-out/);
    const dirty = workspace({ snapshot: { ...readEditorSnapshot(new EditorStore(createScene('Dirty'), 'r1')), dirty: true }, onClose: () => { closed++; } });
    control(dirty.tree, label).props.onClick();
    control(dirty.tree, label).props.onClick();
    assert.equal(closed, 1, 'repeated navigation must not discard unsaved edits');
    const saving = workspace({ saveStatus: 'saving', onClose: () => { closed++; } });
    assert.equal(control(saving.tree, label).props.disabled, true);
    control(saving.tree, label).props.onClick();
    assert.equal(closed, 1);
  }
});

test('tool pill calls the runtime and controlled state, exposes pressed tools, and frames selection', () => {
  const calls: string[] = [];
  const handle: ViewportHandle = { update() {}, dispose() {}, setTool: tool => calls.push(tool), setSpace: space => calls.push(space), frameSelection: () => calls.push('frame') };
  const props = { tool: 'rotate' as const, space: 'world' as const, handle, canEdit: true, canFrame: true, onTool: (tool: string) => calls.push(`state:${tool}`), onSpace: (space: string) => calls.push(`state:${space}`) };
  const tree = ViewportTools(props);
  control(tree, 'Move').props.onClick();
  control(tree, 'Transform space').props.onChange({ currentTarget: { value: 'local' } });
  control(tree, 'Frame').props.onClick();
  assert.deepEqual(calls, ['translate', 'state:translate', 'local', 'state:local', 'frame']);
  assert.equal(control(tree, 'Rotate').props['aria-pressed'], true);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /role="toolbar" aria-label="Viewport tools"/);
  for (const name of ['Select', 'Move', 'Rotate', 'Scale', 'Frame']) assert.match(html, new RegExp(`aria-label="${name}"`));
  const unavailable = ViewportTools({ ...props, handle: { update() {}, dispose() {} }, canFrame: false });
  assert.equal(control(unavailable, 'Transform space').props.disabled, true);
  assert.doesNotThrow(() => control(unavailable, 'Transform space').props.onChange({ currentTarget: { value: 'local' } }));
  const locked = ViewportTools({ ...props, canEdit: false });
  control(locked, 'Move').props.onClick();
  control(locked, 'Transform space').props.onChange({ currentTarget: { value: 'local' } });
  assert.equal(calls.length, 5);
});

test('snap controls use labelled native keyboard controls and persist through the layout storage', () => {
  let settings = defaultSnap;
  const calls: unknown[] = [];
  const handle: ViewportHandle = { update() {}, dispose() {}, setSnap: value => calls.push(value) };
  const render = () => ViewportTools({ tool: 'translate', space: 'world', handle, canEdit: true, canFrame: false,
    onTool() {}, onSpace() {}, snap: settings, onSnap: next => { settings = next; } });
  assert.equal(control(render(), 'Snap').props['aria-pressed'], false);
  control(render(), 'Snap').props.onClick();
  assert.equal(settings.enabled, true);
  for (const [label, key, value] of [
    ['Translation snap step', 'translate', '2'], ['Rotation snap step', 'rotateDeg', '90'], ['Scale snap step', 'scale', '0.25'],
  ] as const) {
    const select = control(render(), label);
    assert.equal(select.type, 'select', 'native select supports Tab, arrows and keyboard selection');
    assert.equal(select.props.disabled, false);
    select.props.onChange({ currentTarget: { value } });
    assert.equal(settings[key], Number(value));
  }
  assert.equal(calls.length, 4);
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  writeLayout(storage, 'project', { ...defaultLayout, snap: settings });
  assert.deepEqual(readLayout(storage, 'project').layout.snap, settings);
  assert.deepEqual(parseLayout(defaultLayout), { layout: defaultLayout, recovered: false }, 'existing v3 layouts remain valid');
  assert.deepEqual(parseLayout({ ...defaultLayout, snap: { ...settings, translate: -1 } }), { layout: defaultLayout, recovered: true });
  const locked = ViewportTools({ tool: 'translate', space: 'world', handle, canEdit: false, canFrame: false, onTool() {}, onSpace() {}, onSnap() {} });
  control(locked, 'Snap').props.onClick();
  assert.equal(control(locked, 'Snap').props.disabled, true);
  assert.equal(calls.length, 4);
});

test('workspace Ctrl+D selects the copies, uses the saved step and commits one undo entry', () => {
  const parent = createEntity('Parent'); const rock = createEntity('Rock', parent.id); const child = createEntity('Child', rock.id);
  const scene = { ...createScene('Test'), entities: [parent, rock, child] };
  const store = new EditorStore(scene, 'r1');
  let selected: unknown;
  const { tree } = workspace({ snapshot: readEditorSnapshot(store), selection: { entityIds: [rock.id, child.id], primaryId: rock.id },
    layout: { ...defaultLayout, snap: { ...defaultSnap, translate: 2 } },
    onCommand: command => { store.execute(command); return true; }, onSelect: next => { selected = next; } });
  (tree as Element).props.onKeyDown({ key: 'd', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} });
  const copy = store.scene.entities[3]!;
  assert.deepEqual(selected, { entityIds: [copy.id], primaryId: copy.id });
  assert.equal(copy.transform.position[0], 2);
  assert.equal(copy.parentId, parent.id);
  assert.equal(store.scene.entities[4]!.parentId, copy.id);
  assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
  const locked = workspace({ snapshot: readEditorSnapshot(store), selection: { entityIds: [rock.id], primaryId: rock.id },
    banner: { kind: 'invalid', diagnostics: [] }, onCommand() { assert.fail('must not edit'); } });
  (locked.tree as Element).props.onKeyDown({ key: 'd', ctrlKey: true, target: null, preventDefault() {} });
});

test('workspace Delete, clipboard, select-all, rename and create shortcuts work outside Hierarchy', () => {
  const parent = createEntity('Parent'); const child = createEntity('Child', parent.id);
  const scene = { ...createScene('Shortcuts'), entities: [parent, child] };
  const store = new EditorStore(scene, 'r1');
  let selection: unknown;
  let layout = defaultLayout;
  const { tree } = workspace({ snapshot: readEditorSnapshot(store), selection: { entityIds: [parent.id, child.id], primaryId: parent.id },
    onCommand: command => { store.execute(command); return true; }, onSelect: next => { selection = next; }, onLayoutChange: next => { layout = next; } });
  const key = (name: string, ctrlKey = false, shiftKey = false) => (tree as Element).props.onKeyDown({ key: name, ctrlKey, shiftKey, altKey: false, metaKey: false, target: null, preventDefault() {} });
  key('Delete'); assert.equal(store.scene.entities.length, 0);
  assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
  key('Backspace'); assert.equal(store.scene.entities.length, 0); store.undo();
  key('c', true); key('v', true);
  assert.equal(store.scene.entities.length, 4);
  assert.equal(store.scene.entities[3]!.parentId, store.scene.entities[2]!.id);
  store.undo(); assert.deepEqual(store.scene, scene);
  key('x', true); assert.equal(store.scene.entities.length, 0);
  key('v', true); assert.equal(store.scene.entities.length, 2);
  store.undo(); store.undo();
  key('a', true); assert.deepEqual(selection, { entityIds: [parent.id, child.id], primaryId: parent.id });
  key('Escape'); assert.deepEqual(selection, { entityIds: [], primaryId: null });
  key('F2'); assert.equal(layout.inspector, true);
  key('n', true, true); assert.equal(store.scene.entities.at(-1)!.parentId, parent.id);
  store.undo();
  const locked = workspace({ snapshot: readEditorSnapshot(store), selection: { entityIds: [parent.id], primaryId: parent.id }, banner: { kind: 'invalid', diagnostics: [] }, onCommand: () => assert.fail('editing is locked') });
  (locked.tree as Element).props.onKeyDown({ key: 'Delete', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, target: null, preventDefault() {} });
});

test('console Clear delegates to its owner and is disabled for an empty log', () => {
  let cleared = false;
  const log = { entries: [{ id: 1, time: '12:00', source: 'editor' as const, severity: 'error' as const, message: 'Error', file: null, line: null }], nextId: 2, droppedCount: 3 };
  const rendered = probe(() => ConsolePanel({ log, onClear: () => { cleared = true; } }));
  const clear = find(rendered.tree, element => element.props.title === 'Clear all console messages')!;
  assert.equal(clear.props.disabled, false);
  clear.props.onClick(); assert.equal(cleared, true);
  const empty = probe(() => ConsolePanel({ log: emptyLog, onClear() {} }));
  assert.equal(find(empty.tree, element => element.props.title === 'Clear all console messages')!.props.disabled, true);
  const dropped = probe(() => ConsolePanel({ log: { ...emptyLog, droppedCount: 1 }, onClear() {} }));
  assert.equal(find(dropped.tree, element => element.props.title === 'Clear all console messages')!.props.disabled, false);
});

test('surface alignment is a labelled keyboard button and survives preference storage', () => {
  let enabled = false;
  const tree = ViewportTools({ tool: 'select', space: 'world', handle: { update() {}, dispose() {}, surfaceAt: () => null }, canEdit: true,
    canFrame: false, onTool() {}, onSpace() {}, alignToSurface: false, onAlignToSurface: value => { enabled = value; } });
  const button = control(tree, 'Align to surface');
  assert.equal(button.props['aria-pressed'], false);
  button.props.onClick(); assert.equal(enabled, true);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /<button[^>]*aria-label="Align to surface"/);
  const layout = { ...defaultLayout, alignToSurface: enabled };
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(layout))), { layout, recovered: false });
  assert.deepEqual(parseLayout({ ...defaultLayout, alignToSurface: 'yes' }), { layout: defaultLayout, recovered: true });
});

test('command cards toggle exclusively, collapse on Escape from inputs, and keep viewport mounted', () => {
  let layout = defaultLayout;
  const render = () => workspace({ layout, onLayoutChange: next => { layout = next; } });
  for (const card of cardIds) {
    const before = render();
    control(before.tree, `command-${card}`).props.onClick();
    assert.equal(layout.expandedCard, card);
    const after = render();
    assert.equal(control(after.tree, `command-${card}`).props['aria-expanded'], true);
    const key = (after.tree as Element).props.onKeyDown;
    let prevented = false;
    key({ key: 'Escape', ctrlKey: false, target: {}, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(layout.expandedCard, null);
    assert.equal(render().html.match(/data-slot="scene-viewport"/g)?.length, 1);
  }
  layout = toggleCard(toggleCard(layout, 'console'), 'stats');
  assert.equal(layout.expandedCard, 'stats');
  control(render().tree, 'command-stats').props.onClick();
  assert.equal(layout.expandedCard, null);
});

test('Hierarchy and Inspector visibility controls and shortcuts preserve each other', () => {
  let layout: LayoutState = defaultLayout;
  const render = () => workspace({ layout, onLayoutChange: next => { layout = next; } });
  control(render().tree, 'Toggle Hierarchy').props.onClick();
  assert.equal(layout.hierarchy, false);
  assert.equal(layout.inspector, true);
  assert.equal(control(render().tree, 'panel-hierarchy').props.hidden, true);
  const key = (render().tree as Element).props.onKeyDown;
  key({ key: '2', ctrlKey: true, altKey: false, metaKey: false, preventDefault() {} });
  assert.equal(layout.inspector, false);
  const nextKey = (render().tree as Element).props.onKeyDown;
  nextKey({ key: '1', ctrlKey: true, altKey: false, metaKey: false, preventDefault() {} });
  assert.equal(layout.hierarchy, true);
  assert.equal(layout.inspector, false);
});

function agentFixture() {
  const calls: unknown[][] = [];
  const thread = newThread('thread_1', 'codex', 'supervised', null);
  const provider = { id: 'codex' as const, name: 'Codex', readiness: 'ready' as const, models: ['model-a'], permissionModes: ['inspect' as const, 'supervised' as const] };
  const action = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const agent: AgentController = {
    progressiveDesign: false, setProgressiveDesign: action('progressive'), progressivePromptId: null, progressiveBuilding: false,
    connection: { providers: [provider], service: { start: async () => ({ runId: 'run_1' }), cancel: async () => {}, approve: async () => {}, answer: async () => {}, subscribe: () => () => {} } }, state: { threads: [thread], activeThreadId: thread.id },
    activeThread: thread, activeProvider: provider, draft: 'Make a cube', setDraft: action('draft'), chips: [{ id: 'selection:cube', kind: 'entity', ref: 'cube', label: 'Cube' }],
    addChip: action('add'), removeChip: action('remove'), blockers: [], canSend: true, send: action('send'), cancel: action('cancel'), approve: action('approve'), answer: async () => {},
    newThread: action('new'), selectThread: action('thread'), setProvider: action('provider'), setModel: action('model'), setModelOption: action('modelOption'), setPermissionMode: action('mode'), refreshProviders: async () => {},
  };
  return { agent, calls, thread };
}
function composer(agent: AgentController, overrides: Partial<AgentDockProps> = {}) {
  return probe(() => {
    const dock = AgentDock({ agent, scene: null, assets: [], projectOpen: true, focusToken: 0, transcriptOpen: true, ...overrides });
    const child = find(dock, element => typeof element.type === 'function' && element.type.name === 'Composer');
    assert.ok(child);
    return (child.type as (props: any) => ReactElement)(child.props);
  });
}

test('composer preserves Enter/IME rules, removable context, and provider/model/permission actions', () => {
  const { agent, calls } = agentFixture();
  const { tree, html } = composer(agent);
  const input = control(tree, 'agent-composer');
  for (const nativeEvent of [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 }, { key: 'Enter', shiftKey: true },
  ]) input.props.onKeyDown({ nativeEvent, preventDefault() { assert.fail('newline/IME must not be consumed'); } });
  let prevented = false;
  input.props.onKeyDown({ nativeEvent: { key: 'Enter' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  control(tree, 'Remove Cube').props.onClick();
  const picker = find(tree, element => element.type === ModelPicker);
  assert.ok(picker);
  picker.props.onSelect('model-a', 'codex');
  const permissions = find(tree, element => element.type === PermissionPicker);
  assert.ok(permissions); permissions.props.onSelect('inspect');
  assert.deepEqual(calls, [['send'], ['remove', 'selection:cube'], ['model', 'model-a', 'codex'], ['mode', 'inspect']]);
  assert.match(html, /aria-label="Model: Default model"/);
  assert.match(html, /aria-label="Send"/);
  assert.match(html, /rows="1"/);
});

test('Ctrl+Enter inserts an actual newline at the selection without sending, and empty drafts never send', () => {
  const { agent, calls } = agentFixture();
  const input = control(composer(agent).tree, 'agent-composer');
  let prevented = 0;
  input.props.onKeyDown({ nativeEvent: { key: 'Enter', ctrlKey: true }, currentTarget: { selectionStart: 4, selectionEnd: 6 }, preventDefault() { prevented++; } });
  assert.deepEqual(calls, [['draft', 'Make\n cube']]);
  assert.equal(prevented, 1);
  calls.length = 0;
  for (const draft of ['', '  \n\t']) {
    agent.draft = draft;
    control(composer(agent).tree, 'agent-composer').props.onKeyDown({ nativeEvent: { key: 'Enter' }, preventDefault() {} });
  }
  assert.deepEqual(calls, []);
});

test('paste, drop and file picker add project file chips; chips are removable and plain text paste is untouched', () => {
  const { agent, calls } = agentFixture();
  const assets = [{ id: 'tex', name: 'Brick', kind: 'texture' as const, path: 'assets/brick.png' }];
  const file = new File(['bytes are not uploaded'], 'brick.png', { type: 'image/png' });
  const tree = composer(agent, { assets }).tree;
  const input = control(tree, 'agent-composer');
  let prevented = 0;
  input.props.onPaste({ clipboardData: { files: [file], items: [] }, preventDefault() { prevented++; } });
  const chip = { id: 'file:assets/brick.png', kind: 'file' as const, ref: 'assets/brick.png', label: 'assets/brick.png' };
  assert.deepEqual(calls, [['add', chip]]);
  assert.equal(prevented, 1);
  input.props.onPaste({ clipboardData: { files: [], items: [] }, preventDefault() { assert.fail('keep native text paste'); } });
  (tree as Element).props.onDrop({ dataTransfer: { files: [file] }, preventDefault() { prevented++; }, stopPropagation() {} });
  const picker = find(tree, element => element.type === 'input' && element.props.type === 'file');
  assert.ok(picker);
  picker.props.onChange({ currentTarget: { files: [file], value: 'brick.png' } });
  assert.equal(calls.filter(call => call[0] === 'add').length, 3);
  agent.chips = [chip];
  control(composer(agent, { assets }).tree, 'Remove assets/brick.png').props.onClick();
  assert.deepEqual(calls.at(-1), ['remove', chip.id]);
  calls.length = 0;
  input.props.onPaste({ clipboardData: { files: [new File(['x'], 'outside.png')], items: [] }, preventDefault() {} });
  assert.deepEqual(calls, [], 'unknown files are never represented as uploaded attachments');
});

test('@ context selection consumes only its query and inserts a chip via keyboard or click', () => {
  const { agent, calls } = agentFixture();
  const entity = createEntity('Cube');
  const scene = { ...createScene('Test'), entities: [entity] };
  agent.draft = 'Change @cub';
  const { tree, html } = composer(agent, { scene });
  const input = control(tree, 'agent-composer');
  assert.equal(input.props['aria-expanded'], true);
  assert.match(html, /role="listbox" aria-label="Context suggestions"/);
  for (const nativeEvent of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }]) {
    input.props.onKeyDown({ nativeEvent, preventDefault() { assert.fail('IME must not choose a mention'); } });
  }
  assert.deepEqual(calls, []);
  for (const key of ['Enter', 'Tab']) {
    calls.length = 0;
    input.props.onKeyDown({ nativeEvent: { key }, preventDefault() {} });
    assert.deepEqual(calls, [['add', { id: `entity:${entity.id}`, kind: 'entity', ref: entity.id, label: 'Cube' }], ['draft', 'Change ']]);
  }
  calls.length = 0;
  control(tree, 'agent-mention-0').props.onClick();
  assert.equal(calls[0]?.[0], 'add');
  assert.equal(calls.some(call => call[0] === 'send'), false);
  let stopped = false;
  input.props.onKeyDown({ nativeEvent: { key: 'Escape' }, preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

test('history recalls this thread including queued prompts and leaves edited drafts alone', () => {
  const { agent, calls, thread } = agentFixture();
  agent.draft = '';
  thread.transcript = [{ id: 'u1', kind: 'user', text: 'First prompt' }, { id: 'a1', kind: 'assistant', runId: 'r', text: 'Reply' }];
  const input = control(composer(agent).tree, 'agent-composer');
  input.props.onKeyDown({ nativeEvent: { key: 'ArrowUp' }, currentTarget: { selectionStart: 0, selectionEnd: 0 }, preventDefault() {} });
  assert.deepEqual(calls, [['draft', 'First prompt']]);
  calls.length = 0; agent.draft = 'Editing my prompt';
  control(composer(agent).tree, 'agent-composer').props.onKeyDown({ nativeEvent: { key: 'ArrowUp' }, currentTarget: { selectionStart: 0, selectionEnd: 0 }, preventDefault() { assert.fail('leave editing alone'); } });
  assert.deepEqual(calls, []);
});

test('assistant messages render markdown while user messages remain plain text', () => {
  const { agent, thread } = agentFixture();
  thread.transcript = [{ id: 'u', kind: 'user', text: '**plain**' }, { id: 'a', kind: 'assistant', runId: 'r', text: '**formatted**\n\n- list' }];
  const html = renderToStaticMarkup(<AgentDock agent={agent} scene={null} assets={[]} projectOpen focusToken={0} />);
  assert.match(html, /<p>\*\*plain\*\*<\/p>/);
  assert.match(html, /<strong>.*formatted.*<\/strong>/);
  assert.match(html, /fg-message-final/);
  assert.match(html, /<ul><li>/);
});

test('command bar, composer and expanded cards inherit one responsive column width', () => {
  const css = readFileSync(new URL('../src/theme/studio.css', import.meta.url), 'utf8');
  assert.match(css, /--command-column-width: 680px/);
  assert.match(css, /\.fg-command-home \{[^}]*width: min\(var\(--command-column-width\), calc\(100% - 32px\)\)/);
  assert.match(css, /\.fg-command-home \.fg-composer, \.fg-expanded-card, \.fg-conversation \{ width: 100%; \}/);
  // Closed: a compact pill. Open: the bar spans the shared column like the composer and card.
  assert.match(css, /\.fg-command-bar \{[^}]*width: fit-content/);
  assert.match(css, /\.fg-command-bar:has\(button\[aria-expanded="true"\]\) \{[^}]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);[^}]*width: 100%/);
});

test('running composer retains Queue/Stop, approvals stay inline, and completed runs say Done', () => {
  const { agent, calls, thread } = agentFixture();
  thread.activeRunId = 'run_1';
  thread.transcript = [{ id: 'approval_1', kind: 'approval', runId: 'run_1', requestId: 'request_1', description: 'Change files?', state: 'pending' }];
  const { tree } = composer(agent);
  control(tree, 'Stop').props.onClick();
  assert.match(renderToStaticMarkup(tree), /aria-label="Model: Default model"/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /aria-label="Model: Default model"[^>]*disabled/);
  // Permissions stay editable while running (they apply to the next message); only a launch in flight locks them.
  const permissions = (node: ReactNode) => find(node, element => element.type === PermissionPicker);
  assert.equal(permissions(tree)?.props.starting, false);
  thread.starting = true;
  assert.equal(permissions(composer(agent).tree)?.props.starting, true);
  thread.starting = false;
  const queue = find(tree, element => element.props.children === 'Queue');
  assert.ok(queue); queue.props.onClick();
  const html = renderToStaticMarkup(<AgentDock agent={agent} scene={null} assets={[]} projectOpen focusToken={0} />);
  assert.match(html, /Approval request/);
  assert.match(html, /Approve once/);
  assert.deepEqual(calls, [['cancel'], ['send']]);
  thread.activeRunId = null; thread.outcome = 'succeeded';
  assert.equal(threadStatus(thread), 'done');
  assert.match(renderToStaticMarkup(<AgentDock agent={agent} scene={null} assets={[]} projectOpen focusToken={0} />), />Done</);
});

test('Progressive design is an accessible icon toggle beside composer controls', () => {
  const { agent, calls } = agentFixture();
  const off = composer(agent);
  const toggle = control(off.tree, 'Progressive design');
  assert.equal(toggle.props['aria-pressed'], false);
  assert.match(toggle.props.title, /next prompt/);
  toggle.props.onClick();
  assert.deepEqual(calls, [['progressive', true]]);
  agent.progressiveDesign = true;
  assert.match(composer(agent).html, /aria-label="Progressive design"[^>]*aria-pressed="true"/);
});
