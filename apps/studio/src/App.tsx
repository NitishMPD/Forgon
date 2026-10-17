import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Launcher,
  Workspace,
  appendLog,
  emptyLog,
  noSelection,
  pruneSelection,
  readLayout,
  useAgentSessions,
  useEditorSnapshot,
  writeLayout,
  type ConsoleLog,
  type LayoutState,
  type LogInput,
  type ProjectSession,
  type SceneSession,
  type Selection,
  type StudioServices,
} from '@forgon/editor-ui';
import type { EditorStore } from '@forgon/editor-core';
import { useSceneSession, type OpenTarget } from './useSceneSession.js';

function timeNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function startScenePath(session: ProjectSession): string | null {
  return session.manifest.scenes.find(item => item.id === session.manifest.startScene)?.path ?? null;
}

export function App({ services }: { services: StudioServices }) {
  const [target, setTarget] = useState<OpenTarget | null>(null);
  const [generation, setGeneration] = useState(0);
  const [log, setLog] = useState<ConsoleLog>(emptyLog);
  const addLog = useCallback((input: LogInput) => {
    setLog(current => appendLog(current, input, timeNow()));
  }, []);

  const open = (next: OpenTarget): void => {
    setLog(emptyLog);
    setGeneration(value => value + 1);
    setTarget(next);
  };

  const close = (): void => {
    if (target?.kind === 'project') target.session.close();
    setTarget(null);
  };

  if (!target) {
    return (
      <Launcher
        host={services.project}
        onOpened={(session: ProjectSession) => open({ kind: 'project', session })}
        onSample={() => open({ kind: 'sample' })}
      />
    );
  }
  return (
    <SceneScreen
      key={generation}
      target={target}
      services={services}
      log={log}
      addLog={addLog}
      onClose={close}
    />
  );
}

function SceneScreen({ target, services, log, addLog, onClose }: {
  target: OpenTarget;
  services: StudioServices;
  log: ConsoleLog;
  addLog(entry: LogInput): void;
  onClose(): void;
}) {
  const initialPath = target.kind === 'project' ? startScenePath(target.session) : null;
  const [sceneRequest, setSceneRequest] = useState({ path: initialPath, version: 0 });
  const load = useSceneSession(target, sceneRequest.path, addLog, sceneRequest.version);
  if (target.kind === 'project' && initialPath === null) {
    return (
      <main className="fg-launcher">
        <Banner tone="danger" actions={<Button onClick={onClose}>Back to launcher</Button>}>The project does not register its start scene.</Banner>
      </main>
    );
  }
  if (load.phase === 'loading') {
    return (
      <main className="fg-launcher">
        <p className="fg-muted">Loading scene…</p>
      </main>
    );
  }
  if (load.phase === 'failed') {
    return (
      <main className="fg-launcher">
        <Banner tone="danger" actions={<Button onClick={onClose}>Back to launcher</Button>}>{load.message}</Banner>
      </main>
    );
  }
  return (
    <ReadyWorkspace
      target={target}
      session={load.session}
      store={load.store}
      notice={load.notice}
      onDismissNotice={load.dismissNotice}
      services={services}
      log={log}
      addLog={addLog}
      onSwitchScene={path => setSceneRequest(current => ({ path, version: current.version + 1 }))}
      onClose={onClose}
    />
  );
}

function ReadyWorkspace({ target, session, store, notice, onDismissNotice, services, log, addLog, onSwitchScene, onClose }: {
  target: OpenTarget;
  session: SceneSession;
  store: EditorStore;
  notice: string | null;
  onDismissNotice(): void;
  services: StudioServices;
  log: ConsoleLog;
  addLog(entry: LogInput): void;
  onSwitchScene(path: string): void;
  onClose(): void;
}) {
  const snapshot = useEditorSnapshot(store);
  const project = target.kind === 'project' ? target.session : null;
  const [catalog, setCatalog] = useState(() => ({ assets: project?.assets ?? [], prefabs: project?.prefabs ?? [] }));
  const refreshAssets = project?.readCatalog ? async (): Promise<void> => {
    const next = await project.readCatalog!();
    session.updateContext({ assets: next.assets.assets, prefabs: next.prefabs });
    setCatalog({ assets: next.assets.assets, prefabs: next.prefabs });
  } : undefined;
  const importAsset = project?.importAsset ? async (license: string): Promise<void> => {
    await project.importAsset!(license);
    await refreshAssets?.();
  } : undefined;
  const viewportContext = useMemo(() => ({
    assets: catalog.assets, prefabs: catalog.prefabs,
    ...(project?.readAsset ? { resolveAsset: async (id: string) => (await project.readAsset!(id)).bytes } : {}),
  }), [catalog, project]);
  const [selection, setSelection] = useState<Selection>(noSelection);
  const projectId = target.kind === 'project' ? target.session.manifest.projectId : 'sample';
  // Keep the storage key so the v3 reader can recover old dock layouts in place.
  const storageKey = `forgon.layout.v2:${projectId}`;
  const [storage] = useState(browserStorage);
  const [layoutRead] = useState(() => readLayout(storage, storageKey));
  const [layout, setLayout] = useState<LayoutState>(layoutRead.layout);

  useEffect(() => {
    if (layoutRead.recovered) {
      writeLayout(storage, storageKey, layoutRead.layout);
      addLog({ source: 'editor', severity: 'info', message: 'Saved layout was not valid. Default layout restored.' });
    }
  }, []);

  // Selection belongs to one scene. A different store means different objects, so it is cleared.
  useEffect(() => {
    setSelection(noSelection);
  }, [store]);

  useEffect(() => {
    const ids = new Set(snapshot.scene.entities.map(entity => entity.id));
    setSelection(current => pruneSelection(current, ids));
  }, [snapshot.scene]);

  const agent = useAgentSessions({
    connection: services.agent,
    projectRoot: target.kind === 'project' ? target.session.root : null,
    scene: snapshot.scene,
    assets: catalog.assets,
    onLog: addLog,
  });

  const changeLayout = (next: LayoutState): void => {
    setLayout(next);
    writeLayout(storage, storageKey, next);
  };

  return (
    <Workspace
      projectName={target.kind === 'project' ? target.session.manifest.name : 'In-memory sample'}
      source={target.kind}
      sourcePath={session.path}
      snapshot={snapshot}
      selection={selection}
      onSelect={setSelection}
      onCommand={command => session.execute(command)}
      onUndo={() => session.undo()}
      onRedo={() => session.redo()}
      onSave={() => session.save()}
      saveStatus={session.saveStatus}
      saveDisabledReason={session.saveDisabledReason}
      banner={session.banner}
      onDismissBanner={() => session.dismissBanner()}
      onResolveConflict={choice => session.resolveConflict(choice)}
      scenes={target.kind === 'project' ? target.session.manifest.scenes : []}
      onSwitchScene={onSwitchScene}
      notice={notice}
      onDismissNotice={onDismissNotice}
      assets={catalog.assets}
      viewportContext={viewportContext}
      onRefreshAssets={refreshAssets}
      onImportAsset={importAsset}
      saveError={session.saveError}
      log={log}
      onLog={addLog}
      agent={agent}
      viewport={services.viewport}
      layout={layout}
      onLayoutChange={changeLayout}
      onClose={onClose}
    />
  );
}
