import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Transform } from '@forgon/project-schema';
import type { SurfacePoint, ViewportHandle, ViewportMount, ViewportView } from '../services.js';
import { parsePlacement, placementMime, type PlacementTarget } from '../model/placement.js';
import { QuickAdd } from './QuickAdd.js';

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
  const [quickAdd, setQuickAdd] = useState<{ x: number; y: number; surface: SurfacePoint } | null>(null);
  const quickDown = useRef<{ x: number; y: number } | null>(null);
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

  useEffect(() => { setQuickAdd(null); quickDown.current = null; }, [view.scene.sceneId, placementEnabled, updatesEnabled, visible]);

  const surface = (event: { clientX: number; clientY: number }): SurfacePoint | null => {
    if (!placementEnabled || !updatesEnabled) return null;
    try { return handleRef.current?.surfaceAt?.(event.clientX, event.clientY) ?? null; }
    catch (error) { onFault(`Could not find a placement surface: ${String(error)}`); return null; }
  };
  const closeQuickAdd = (restoreFocus: boolean): void => {
    setQuickAdd(null);
    if (restoreFocus) containerRef.current?.querySelector('canvas')?.focus();
  };
  const openQuickAdd = (clientX: number, clientY: number): void => {
    const point = surface({ clientX, clientY });
    const rect = containerRef.current?.getBoundingClientRect();
    if (!point || !rect) return;
    setQuickAdd({ x: Math.max(8, Math.min(clientX - rect.left, rect.width - 308)), y: Math.max(8, Math.min(clientY - rect.top, rect.height - 328)), surface: point });
  };

  return (
    <div className="fg-viewport" style={{ visibility: visible ? 'visible' : 'hidden' }}>
      <div ref={containerRef} className="fg-viewport-canvas" data-slot="scene-viewport"
        onPointerDownCapture={event => {
          quickDown.current = null;
          if (event.button !== 0 || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || !placementEnabled || !updatesEnabled) return;
          event.preventDefault(); event.stopPropagation();
          quickDown.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUpCapture={event => {
          const start = quickDown.current;
          quickDown.current = null;
          if (!start) return;
          event.preventDefault(); event.stopPropagation();
          if (event.button === 0 && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) openQuickAdd(event.clientX, event.clientY);
        }}
        onPointerCancel={() => { quickDown.current = null; }}
        onKeyDownCapture={event => {
          if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'a' && placementEnabled && updatesEnabled) {
            event.preventDefault(); event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openQuickAdd(rect.left + rect.width / 2, rect.top + rect.height / 2);
          }
        }}
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
      {quickAdd && placementEnabled && updatesEnabled && visible ? <QuickAdd key={`${quickAdd.x}:${quickAdd.y}`} x={quickAdd.x} y={quickAdd.y} assets={view.assets ?? []} prefabs={view.prefabs ?? []}
        onClose={closeQuickAdd} onPlace={target => { onPlace?.(target, quickAdd.surface); closeQuickAdd(true); }} /> : null}
    </div>
  );
}
