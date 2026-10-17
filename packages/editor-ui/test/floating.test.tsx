import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorStore } from '@forgon/editor-core';
import { createEntity, createScene } from '@forgon/project-schema';
import { ViewportTools } from '../src/shell/ViewportTools.js';
import { Workspace, type WorkspaceProps } from '../src/shell/Workspace.js';
import { AgentDock } from '../src/agent/AgentDock.js';
import { newThread, threadStatus } from '../src/agent/threadState.js';
import type { AgentController } from '../src/agent/useAgentSessions.js';
import { readEditorSnapshot } from '../src/hooks/useEditorSnapshot.js';
import { defaultLayout, toggleCard, cardIds, type LayoutState } from '../src/model/layout.js';
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
    connection: { providers: [provider], service: { start: async () => ({ runId: 'run_1' }), cancel: async () => {}, approve: async () => {}, subscribe: () => () => {} } }, state: { threads: [thread], activeThreadId: thread.id },
    activeThread: thread, activeProvider: provider, draft: 'Make a cube', setDraft: action('draft'), chips: [{ id: 'selection:cube', kind: 'entity', ref: 'cube', label: 'Cube' }],
    addChip: action('add'), removeChip: action('remove'), blockers: [], canSend: true, send: action('send'), cancel: action('cancel'), approve: action('approve'),
    newThread: action('new'), selectThread: action('thread'), setProvider: action('provider'), setModel: action('model'), setPermissionMode: action('mode'), refreshProviders: async () => {},
  };
  return { agent, calls, thread };
}
function composer(agent: AgentController) {
  return probe(() => {
    const dock = AgentDock({ agent, scene: null, assets: [], projectOpen: true, focusToken: 0, transcriptOpen: true });
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
    { key: 'Enter', ctrlKey: false }, { key: 'Enter', ctrlKey: true, isComposing: true },
    { key: 'Enter', ctrlKey: true, keyCode: 229 }, { key: 'Enter', ctrlKey: true, shiftKey: true },
  ]) input.props.onKeyDown({ nativeEvent, preventDefault() { assert.fail('newline/IME must not be consumed'); } });
  let prevented = false;
  input.props.onKeyDown({ nativeEvent: { key: 'Enter', ctrlKey: true }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  control(tree, 'Remove Cube').props.onClick();
  control(tree, 'Provider').props.onChange({ currentTarget: { value: 'codex' } });
  control(tree, 'Model').props.onChange({ currentTarget: { value: 'model-a' } });
  control(tree, 'Permission mode').props.onChange({ currentTarget: { value: 'inspect' } });
  assert.deepEqual(calls, [['send'], ['remove', 'selection:cube'], ['provider', 'codex'], ['model', 'model-a'], ['mode', 'inspect']]);
  assert.match(html, /<details class="fg-agent-options"/);
  assert.match(html, /aria-label="Send"/);
  assert.match(html, /rows="1"/);
});

test('running composer retains Queue/Stop, approvals stay inline, and completed runs say Done', () => {
  const { agent, calls, thread } = agentFixture();
  thread.activeRunId = 'run_1';
  thread.transcript = [{ id: 'approval_1', kind: 'approval', runId: 'run_1', requestId: 'request_1', description: 'Change files?', state: 'pending' }];
  const { tree } = composer(agent);
  control(tree, 'Stop').props.onClick();
  assert.equal(control(tree, 'Provider').props.disabled, true);
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
