import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorStore } from '@forgon/editor-core';
import { createEntity, createScene, parseScene } from '@forgon/project-schema';
import { Launcher } from '../src/launcher/Launcher.js';
import { ForgonMark } from '../src/brand/ForgonMark.js';
import { Hierarchy } from '../src/panels/hierarchy/Hierarchy.js';
import { Inspector } from '../src/panels/inspector/Inspector.js';
import { ConsolePanel } from '../src/panels/console/ConsolePanel.js';
import { ProviderSetup } from '../src/agent/ProviderSetup.js';
import { AgentDock } from '../src/agent/AgentDock.js';
import { Workspace } from '../src/shell/Workspace.js';
import { readEditorSnapshot } from '../src/hooks/useEditorSnapshot.js';
import { emptyLog } from '../src/model/consoleLog.js';
import { defaultLayout } from '../src/model/layout.js';
import { noSelection, selectOne } from '../src/model/selection.js';

function fixtureScene() {
  const root = createEntity('Lobby');
  const desk = createEntity('Reception', root.id);
  return parseScene({ ...createScene('Lobby scene'), entities: [root, desk] });
}

test('brand mark has a product name alone and is decorative beside the launcher wordmark', () => {
  const mark = renderToStaticMarkup(<ForgonMark />);
  assert.match(mark, /alt="Forgon Engine"/);
  assert.match(mark, /forgon\.svg/);
  const launcher = renderToStaticMarkup(<Launcher host={null} onOpened={() => {}} onSample={() => {}} />);
  assert.match(launcher, /alt=""/);
  assert.match(launcher, /Forgon <span>Engine<\/span>/);
  assert.match(launcher, /Local-first game studio/);
});

test('launcher without a desktop host says so, disables project actions, and still offers the sample', () => {
  const html = renderToStaticMarkup(<Launcher host={null} onOpened={() => {}} onSample={() => {}} />);
  assert.match(html, /desktop host is not connected/);
  assert.match(html, /Recent projects unavailable/);
  assert.match(html, /<button(?=[^>]*disabled="")[^>]*>(?:(?!<\/button>).)*Open folder…/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>(?:(?!<\/button>).)*In-memory sample/);
  assert.doesNotMatch(html, /Opening a project does not run code from it/);
});

test('hierarchy is an ARIA tree with selected and expanded state', () => {
  const scene = fixtureScene();
  const html = renderToStaticMarkup(
    <Hierarchy
      sceneName="Lobby scene"
      entities={scene.entities}
      selection={selectOne(scene.entities[0]!.id)}
      locked={false}
      onSelect={() => {}}
      onCreate={() => {}}
      onDelete={() => {}}
      onRename={() => {}}
      onCommand={() => true}
      onNotice={() => {}}
    />,
  );
  assert.match(html, /role="tree"/);
  assert.match(html, /aria-describedby="hierarchy-help"/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /role="treeitem"[^>]*aria-selected="true"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Reception/);
});

test('inspector with nothing selected explains how to select, and shows a conflict-free scene as read-only when locked', () => {
  const scene = fixtureScene();
  const empty = renderToStaticMarkup(
    <Inspector scene={scene} selection={noSelection} sourcePath={null} readOnlyReason={null} conflict={null} onCommand={() => true} onResolveConflict={() => {}} onAddToAgent={null} />,
  );
  assert.match(empty, /Nothing selected/);
  const locked = renderToStaticMarkup(
    <Inspector scene={scene} selection={selectOne(scene.entities[1]!.id)} sourcePath="scenes/lobby.scene.json" readOnlyReason="Stop to edit." conflict={null} onCommand={() => true} onResolveConflict={() => {}} onAddToAgent={null} />,
  );
  assert.match(locked, /Stop to edit\./);
  assert.match(locked, /disabled=""/);
});

test('provider setup shows unknown readiness honestly and disables Check again with a reason', () => {
  const html = renderToStaticMarkup(
    <ProviderSetup
      providers={[{ id: 'opencode', name: 'OpenCode', readiness: 'unknown', models: [], permissionModes: ['inspect'] }]}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Not checked/);
  assert.match(html, />Inspect</);
  assert.match(html, /disabled=""[^>]*>Check again/);
  assert.doesNotMatch(html, />Ready</);
  assert.match(html, /did not report its limits/);
});

test('provider setup lists only the limits the adapter reported', () => {
  const html = renderToStaticMarkup(
    <ProviderSetup
      providers={[{ id: 'codex', name: 'Codex', readiness: 'ready', models: [], permissionModes: ['supervised'], limits: ['Edits cannot be rolled back by Forgon.'] }]}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Edits cannot be rolled back by Forgon\./);
  assert.doesNotMatch(html, /did not report its limits/);
});

test('agent dock without a service says the capability is missing and offers no send action', () => {
  const html = renderToStaticMarkup(
    <AgentDock agent={null} scene={null} assets={[]} projectOpen={false} focusToken={0} />,
  );
  assert.match(html, /Agent service not connected/);
  assert.doesNotMatch(html, /aria-label="Send"/);
});

test('console empty state names what appears there', () => {
  const html = renderToStaticMarkup(<ConsolePanel log={emptyLog} />);
  assert.match(html, /No messages/);
  assert.match(html, /Errors from validation, saves and agent runs/);
});

test('workspace renders from a real store with the viewport slot, honest capability copy and no play', () => {
  const scene = fixtureScene();
  const store = new EditorStore(scene, 'r1');
  const html = renderToStaticMarkup(
    <Workspace
      projectName="Hotel"
      source="project"
      sourcePath="scenes/lobby.scene.json"
      snapshot={readEditorSnapshot(store)}
      selection={noSelection}
      onSelect={() => {}}
      onCommand={() => true}
      onUndo={() => {}}
      onRedo={() => {}}
      onSave={async () => true}
      saveStatus="idle"
      saveDisabledReason={null}
      banner={null}
      onDismissBanner={() => {}}
      onResolveConflict={() => {}}
      scenes={[{ id: 'scene_lobby', path: 'scenes/lobby.scene.json' }]}
      onSwitchScene={() => {}}
      notice={null}
      onDismissNotice={() => {}}
      assets={[]}
      log={emptyLog}
      onLog={() => {}}
      agent={null}
      viewport={null}
      layout={defaultLayout}
      onLayoutChange={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Viewport not connected/);
  assert.match(html, /data-slot="scene-viewport"/);
  assert.match(html, /Scripts do not run on open/);
  assert.match(html, /Saved/);
  assert.match(html, /Watching scenes\/lobby\.scene\.json/);
  assert.match(html, /data-layout="floating"/);
  assert.doesNotMatch(html, /Showing last valid scene/);
  assert.match(html, /aria-label="Scene"/);
  assert.match(html, /aria-label="Viewport tools"/);
  assert.match(html, /<button(?=[^>]*aria-label="Move")(?=[^>]*disabled="")/);
  assert.match(html, /<button(?=[^>]*aria-label="Frame")(?=[^>]*disabled="")/);
});

test('floating workspace keeps its viewport and panels mounted with named command controls', () => {
  const store = new EditorStore(fixtureScene(), 'r1');
  const html = renderToStaticMarkup(
    <Workspace
      projectName="Hotel"
      source="project"
      sourcePath="scenes/lobby.scene.json"
      snapshot={readEditorSnapshot(store)}
      selection={noSelection}
      onSelect={() => {}}
      onCommand={() => true}
      onUndo={() => {}}
      onRedo={() => {}}
      onSave={async () => true}
      saveStatus="idle"
      saveDisabledReason={null}
      banner={null}
      onDismissBanner={() => {}}
      onResolveConflict={() => {}}
      scenes={[]}
      onSwitchScene={() => {}}
      notice={null}
      onDismissNotice={() => {}}
      assets={[]}
      log={emptyLog}
      onLog={() => {}}
      agent={null}
      viewport={null}
      layout={{ ...defaultLayout, hierarchy: false }}
      onLayoutChange={() => {}}
      onClose={() => {}}
    />,
  );
  for (const label of ['Assets', 'Console', 'Review', 'Agents', 'Stats', 'Chat']) {
    assert.match(html, new RegExp(`<span>${label}</span>`));
  }
  assert.match(html, /id="panel-hierarchy"[^>]*hidden=""/);
  assert.match(html, /aria-label="Toggle Hierarchy"/);
  assert.match(html, /aria-label="Toggle Inspector"/);
  assert.match(html, /aria-label="Transform space"/);
  assert.match(html, /aria-label="Search inspector"/);
  assert.doesNotMatch(html, /role="tab"|Resize columns|Add panel/);
  assert.equal(html.match(/data-slot="scene-viewport"/g)?.length, 1);

});

test('inspector renders typed editors for each property kind and a whole-component summary', () => {
  const root = createEntity('Guest');
  const waypoint = createEntity('Waypoint');
  const entity = { ...root, components: [{
    id: 'component_queue',
    type: 'guestQueue',
    enabled: true,
    properties: { speed: 1.2, loop: true, label: 'Queue', color: [0.1, 0.2, 0.3], waypoints: [waypoint.id] },
    entityRefs: [waypoint.id],
    assetRefs: [],
  }] };
  const scene = parseScene({ ...createScene('Lobby'), entities: [entity, waypoint] });
  const html = renderToStaticMarkup(
    <Inspector scene={scene} selection={selectOne(entity.id)} sourcePath={null} readOnlyReason={null} conflict={null} onCommand={() => true} onResolveConflict={() => {}} onAddToAgent={null} />,
  );
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /inputMode="decimal"/);
  assert.match(html, /<textarea[^>]*fg-code-input/);
  assert.match(html, /JSON\. Applies when you leave the field\./);
  assert.match(html, /legend class="fg-vector-title">color</);
  assert.doesNotMatch(html, /properties \(read-only\)/);
});

test('entity enabled and whole-properties controls are editable, and provider refresh is capability driven', () => {
  const scene = fixtureScene();
  const html = renderToStaticMarkup(<Inspector scene={scene} selection={selectOne(scene.entities[0]!.id)} sourcePath="scene.json" readOnlyReason={null} conflict={null} onCommand={() => true} onResolveConflict={() => {}} onAddToAgent={null} />);
  assert.match(html, /aria-label="Entity enabled"/);
  assert.doesNotMatch(html, /\(read-only\)/);
  const setup = renderToStaticMarkup(<ProviderSetup providers={[{ id: 'codex', name: 'Codex', readiness: 'unknown', models: [], permissionModes: [] }]} onRefresh={async () => {}} onClose={() => {}} />);
  assert.match(setup, />Check again</);
  assert.doesNotMatch(setup, /disabled=""/);
});
