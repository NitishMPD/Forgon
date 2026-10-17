import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SceneCommand } from '@forgon/editor-core';
import { createEntity, createScene, parseScene } from '@forgon/project-schema';
import { Workspace, type WorkspaceProps } from '../src/shell/Workspace.js';
import { ViewportSlot, type ViewportSlotProps } from '../src/shell/ViewportSlot.js';
import { readEditorSnapshot } from '../src/hooks/useEditorSnapshot.js';
import { emptyLog, type LogInput } from '../src/model/consoleLog.js';
import { defaultLayout } from '../src/model/layout.js';
import { SceneSession } from '../src/session/sceneSession.js';
import { placementMime, primitives } from '../src/model/placement.js';
import { AssetsPanel } from '../src/panels/assets/AssetsPanel.js';

function viewportProps(node: ReactNode): ViewportSlotProps | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === ViewportSlot) return child.props as ViewportSlotProps;
    const found = viewportProps(child.props.children);
    if (found) return found;
  }
  return undefined;
}

function fixture() {
  const scene = parseScene({ ...createScene('Gizmo test'), entities: [createEntity('First'), createEntity('Second')] });
  const log: LogInput[] = [];
  const session = SceneSession.memory(scene, entry => log.push(entry));
  const store = session.store!;
  const commands: SceneCommand[] = [];
  const selection = { entityIds: scene.entities.map(entity => entity.id), primaryId: scene.entities[1]!.id };
  const render = (overrides: Partial<WorkspaceProps> = {}): ViewportSlotProps => {
    let slot: ViewportSlotProps | undefined;
    // Capture the real Workspace callbacks inside a server render, where its hooks are active.
    function Probe() {
      const tree = Workspace({
        projectName: 'Test', source: 'sample', sourcePath: null,
        snapshot: readEditorSnapshot(store), selection, onSelect: () => {},
        onCommand: command => { commands.push(command); return session.execute(command); },
        onUndo: () => session.undo(), onRedo: () => session.redo(), onSave: async () => false,
        saveStatus: 'idle', saveDisabledReason: null, banner: null,
        onDismissBanner: () => {}, onResolveConflict: () => {}, scenes: [], onSwitchScene: () => {},
        notice: null, onDismissNotice: () => {}, assets: [], log: emptyLog, onLog: entry => log.push(entry),
        agent: null, viewport: null, layout: defaultLayout, onLayoutChange: () => {}, onClose: () => {},
        ...overrides,
      });
      slot = viewportProps(tree);
      return tree;
    }
    renderToStaticMarkup(<Probe />);
    assert.ok(slot);
    return slot;
  };
  const changes = scene.entities.map((entity, index) => ({
    entityId: entity.id,
    transform: { ...entity.transform, position: [index + 3, 2, 1] as [number, number, number] },
  }));
  return { scene, store, log, commands, selection, changes, render };
}

test('a multi-selection viewport gesture edits both objects with one command and one undo', () => {
  const { scene, store, commands, selection, changes, render } = fixture();
  const slot = render();
  assert.deepEqual(slot.view.selectedIds, selection.entityIds);
  slot.onTransforms(changes);
  assert.deepEqual(commands, [{ type: 'batch', commands: changes.map(change => ({ type: 'transform', ...change })) }]);
  assert.deepEqual(store.scene.entities.map(entity => entity.transform), changes.map(change => change.transform));
  assert.equal(store.undo(), true);
  assert.deepEqual(store.scene, scene);
  assert.equal(store.undo(), false, 'the gesture has no second undo entry');
  assert.equal(store.redo(), true);
  assert.deepEqual(store.scene.entities.map(entity => entity.transform), changes.map(change => change.transform));
});

test('empty and unchanged gestures preserve undo and redo history; singular callbacks still work', () => {
  const { scene, store, commands, changes, render } = fixture();
  const slot = render();
  slot.onTransforms([]);
  assert.equal(commands.length, 0);
  slot.onTransforms(scene.entities.map(entity => ({ entityId: entity.id, transform: entity.transform })));
  assert.equal(store.canUndo, false);
  slot.onTransform(changes[0]!.entityId, changes[0]!.transform);
  assert.equal(commands.at(-1)?.type, 'transform');
  assert.deepEqual(store.scene.entities[0]!.transform, changes[0]!.transform);
  assert.deepEqual(store.scene.entities[1], scene.entities[1]);
  assert.equal(store.undo(), true);
  slot.onTransforms([]);
  slot.onTransforms(scene.entities.map(entity => ({ entityId: entity.id, transform: entity.transform })));
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, true);
});

test('an invalid or stale transform rejects the whole gesture and reports the failure', () => {
  for (const invalid of ['non-finite', 'missing'] as const) {
    const { scene, store, log, changes, render } = fixture();
    const bad = structuredClone(changes);
    if (invalid === 'non-finite') bad[1]!.transform.position[0] = Number.NaN;
    else bad[1]!.entityId = 'entity_missing';
    render().onTransforms(bad);
    assert.deepEqual(store.scene, scene, 'the first valid transform must not leak through');
    assert.equal(store.canUndo, false);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.severity, 'error');
    assert.ok(log[0]!.message.length > 0);
  }
});

test('batch and singular viewport callbacks obey the invalid-file and conflict edit guards', () => {
  const { scene, store, commands, changes, render } = fixture();
  const snapshot = readEditorSnapshot(store);
  for (const overrides of [
    { banner: { kind: 'invalid' as const, path: 'scene.json', diagnostics: [] } },
    { snapshot: { ...snapshot, conflict: { base: scene, ours: scene, theirs: scene, revision: 'external' } } },
  ]) {
    const slot = render(overrides);
    slot.onTransforms(changes);
    slot.onTransform(changes[0]!.entityId, changes[0]!.transform);
  }
  assert.equal(commands.length, 0);
  assert.deepEqual(store.scene, scene);
  assert.equal(store.canUndo, false);
});

test('viewport placement selects the new object and respects the shared edit guard', () => {
  const { scene, store, commands, render } = fixture();
  let selected: unknown;
  const surface = { position: [4, 1, 2] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };
  const slot = render({ onSelect: next => { selected = next; } });
  slot.onPlace!({ kind: 'primitive', primitive: 'box' }, surface);
  const entity = store.scene.entities.at(-1)!;
  assert.deepEqual(entity.transform.position, surface.position);
  assert.deepEqual(selected, { entityIds: [entity.id], primaryId: entity.id });
  assert.equal(commands.length, 1);
  assert.equal(store.undo(), true); assert.deepEqual(store.scene, scene); assert.equal(store.undo(), false);
  const locked = render({ banner: { kind: 'invalid', diagnostics: [] } });
  locked.onPlace!({ kind: 'primitive', primitive: 'box' }, surface);
  assert.equal(commands.length, 1);
  assert.equal(locked.placementEnabled, false);
});

test('Assets exposes keyboard-reachable primitive and prefab groups even for an empty project', () => {
  const html = renderToStaticMarkup(<AssetsPanel assets={[]} projectOpen />);
  assert.match(html, /<button[^>]*>[\s\S]*?<span>Primitives<\/span>/);
  assert.match(html, /<span>Prefabs<\/span>/);
  assert.match(html, new RegExp(`<span class="fg-muted">${primitives.length}</span>`));
  assert.equal(placementMime, 'application/x-forgon-placement');
});
