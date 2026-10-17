import { useEffect, useRef, type ReactNode } from 'react';
import type { Transform } from '@forgon/project-schema';
import type { ViewportHandle, ViewportMount, ViewportView } from '../services.js';

export interface ViewportSlotProps {
  mount: ViewportMount | null;
  view: ViewportView;
  // While playing, the runtime owns the simulation; scene updates resume when play stops.
  updatesEnabled: boolean;
  // Hidden (not unmounted) when a fullscreen dock covers the centre column.
  visible: boolean;
  onPick(entityId: string | null): void;
  onFault(message: string): void;
  onTransform(entityId: string, transform: Transform): void;
  onTransforms(changes: readonly { entityId: string; transform: Transform }[]): void;
  onHandle(handle: ViewportHandle | null): void;
  children?: ReactNode;
}

// The canvas container is rendered once in the same tree position for the life of the workspace,
// so dock and panel layout changes never remount the viewport.
export function ViewportSlot({ mount, view, updatesEnabled, visible, onPick, onFault, onTransform, onTransforms, onHandle, children }: ViewportSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ViewportHandle | null>(null);
  const callbacks = useRef({ onPick, onFault, onTransform, onTransforms, onHandle });
  callbacks.current = { onPick, onFault, onTransform, onTransforms, onHandle };
  const latestView = useRef(view);
  latestView.current = view;

  useEffect(() => {
    const container = containerRef.current;
    if (!mount || !container) return;
    let handle: ViewportHandle;
    try { handle = mount(container, {
      onPick: entityId => callbacks.current.onPick(entityId),
      onFault: message => callbacks.current.onFault(message),
      onTransform: (entityId, transform) => callbacks.current.onTransform(entityId, transform),
      onTransforms: changes => callbacks.current.onTransforms(changes),
    }, {
      context: {
        get assets() { return [...latestView.current.assets ?? []]; },
        get prefabs() { return [...latestView.current.prefabs ?? []]; },
      },
      loadAssetBytes: async id => await latestView.current.resolveAsset?.(id) ?? null,
    }); } catch (error) { callbacks.current.onFault(String(error)); return; }
    handleRef.current = handle;
    callbacks.current.onHandle(handle);
    return () => {
      handleRef.current = null;
      callbacks.current.onHandle(null);
      handle.dispose();
    };
  }, [mount]);

  useEffect(() => {
    if (updatesEnabled) handleRef.current?.update(view);
  }, [view, updatesEnabled, mount]);

  return (
    <div className="fg-viewport" style={{ visibility: visible ? 'visible' : 'hidden' }}>
      <div ref={containerRef} className="fg-viewport-canvas" data-slot="scene-viewport" />
      {children}
    </div>
  );
}
