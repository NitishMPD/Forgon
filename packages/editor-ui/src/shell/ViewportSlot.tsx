import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Transform } from '@forgon/project-schema';
import type { SurfacePoint, ViewportHandle, ViewportMount, ViewportView } from '../services.js';
import { parsePlacement, placementMime, type PlacementTarget } from '../model/placement.js';

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
  placementEnabled?: boolean;
  onPlace?(target: PlacementTarget, surface: SurfacePoint): void;
  children?: ReactNode;
}

// The canvas container is rendered once in the same tree position for the life of the workspace,
// so dock and panel layout changes never remount the viewport.
export function ViewportSlot({ mount, view, updatesEnabled, visible, onPick, onFault, onTransform, onTransforms, onHandle, placementEnabled = false, onPlace, children }: ViewportSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ViewportHandle | null>(null);
  const [dropPoint, setDropPoint] = useState<SurfacePoint | null>(null);
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

  const surface = (event: DragEvent): SurfacePoint | null => {
    if (!placementEnabled || !updatesEnabled) return null;
    try { return handleRef.current?.surfaceAt?.(event.clientX, event.clientY) ?? null; }
    catch (error) { onFault(`Could not find a placement surface: ${String(error)}`); return null; }
  };

  return (
    <div className="fg-viewport" style={{ visibility: visible ? 'visible' : 'hidden' }}>
      <div ref={containerRef} className="fg-viewport-canvas" data-slot="scene-viewport"
        onDragOver={event => {
          if (!event.dataTransfer.types.includes(placementMime)) return;
          const point = surface(event);
          setDropPoint(point);
          if (point) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPoint(null); }}
        onDrop={event => {
          setDropPoint(null);
          if (!event.dataTransfer.types.includes(placementMime)) return;
          event.preventDefault();
          const target = parsePlacement(event.dataTransfer.getData(placementMime));
          const point = surface(event);
          if (target && point) onPlace?.(target, point);
        }} />
      {dropPoint && placementEnabled ? <div className="fg-placement-preview" role="status">Drop to place at {dropPoint.position.map(value => value.toFixed(2)).join(', ')} m</div> : null}
      {children}
    </div>
  );
}
