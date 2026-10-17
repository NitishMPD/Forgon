import { useEffect, useState } from 'react';
import type { EditorStore, SceneConflict } from '@forgon/editor-core';
import type { SceneDocument } from '@forgon/project-schema';

export interface EditorSnapshot {
  scene: SceneDocument;
  revision: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  conflict: SceneConflict | null;
}

export function readEditorSnapshot(store: EditorStore): EditorSnapshot {
  return {
    scene: store.scene,
    revision: store.revision,
    dirty: store.dirty,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    conflict: store.conflict,
  };
}

// EditorStore getters return detached copies, so the snapshot is cached and replaced only on store changes.
export function useEditorSnapshot(store: EditorStore): EditorSnapshot {
  const [snapshot, setSnapshot] = useState(() => readEditorSnapshot(store));
  useEffect(() => {
    const refresh = (): void => setSnapshot(readEditorSnapshot(store));
    refresh();
    return store.subscribe(refresh);
  }, [store]);
  return snapshot;
}
