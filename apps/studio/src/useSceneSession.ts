import { useEffect, useState, useSyncExternalStore } from 'react';
import { SceneHost, type LogInput, type ProjectSession, type SceneSession } from '@forgon/editor-ui';
import type { EditorStore } from '@forgon/editor-core';
import { sampleScene } from './sample.js';

export type OpenTarget = { kind: 'project'; session: ProjectSession } | { kind: 'sample' };

export type SceneLoad =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; session: SceneSession; store: EditorStore; notice: string | null; dismissNotice(): void };

const noopSubscribe = (): (() => void) => () => {};

// Thin React binding over SceneHost. The lifecycle (load, watch, save, stale loads) lives in
// @forgon/editor-ui so it can be tested without a DOM. A scene switch keeps the current scene on
// screen until the next one has loaded.
export function useSceneSession(target: OpenTarget, scenePath: string | null, addLog: (entry: LogInput) => void, requestVersion = 0): SceneLoad {
  const [host, setHost] = useState<SceneHost | null>(null);

  useEffect(() => {
    const created = target.kind === 'sample'
      ? new SceneHost({ io: null, context: {}, log: addLog })
      : new SceneHost({
          io: target.session.sceneIO,
          context: { assets: target.session.assets, prefabs: target.session.prefabs },
          log: addLog,
        });
    if (target.kind === 'sample') created.showMemory(sampleScene());
    setHost(created);
    return () => { created.dispose(); };
  }, [target, addLog]);

  useEffect(() => {
    if (host && scenePath !== null) {
      if (target.kind === 'project') host.updateContext({ assets: target.session.assets, prefabs: target.session.prefabs });
      host.open(scenePath);
    }
  }, [host, scenePath, target, requestVersion]);

  useSyncExternalStore(host?.subscribe ?? noopSubscribe, () => host?.version ?? 0);

  if (host === null) return { phase: 'loading' };
  const shown = host.shown;
  if (shown?.store) {
    return { phase: 'ready', session: shown, store: shown.store, notice: host.notice, dismissNotice: () => host.dismissNotice() };
  }
  if (host.notice !== null) return { phase: 'failed', message: host.notice };
  return { phase: 'loading' };
}
