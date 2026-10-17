import { ArrowDownToLine, Focus, Magnet, MousePointer2, Move, RotateCw, Scaling, type LucideIcon } from 'lucide-react';
import { IconButton } from '../primitives/primitives.js';
import type { SnapSettings, ViewportHandle, ViewportTool } from '../services.js';
import { defaultSnap, snapSteps } from '../model/layout.js';

export const toolButtons: ReadonlyArray<{ id: ViewportTool; label: string; key: string; icon: LucideIcon }> = [
  { id: 'select', label: 'Select', key: 'Q', icon: MousePointer2 },
  { id: 'translate', label: 'Move', key: 'W', icon: Move },
  { id: 'rotate', label: 'Rotate', key: 'E', icon: RotateCw },
  { id: 'scale', label: 'Scale', key: 'R', icon: Scaling },
];
export interface ViewportToolsProps {
  tool: ViewportTool;
  space: 'local' | 'world';
  handle: ViewportHandle | null;
  canEdit: boolean;
  canFrame: boolean;
  onTool(tool: ViewportTool): void;
  onSpace(space: 'local' | 'world'): void;
  snap?: SnapSettings;
  onSnap?(snap: SnapSettings): void;
  alignToSurface?: boolean;
  onAlignToSurface?(enabled: boolean): void;
}
export function ViewportTools({ tool, space, handle, canEdit, canFrame, onTool, onSpace, snap = defaultSnap, onSnap, alignToSurface = false, onAlignToSurface }: ViewportToolsProps) {
  const canTool = !!handle?.setTool && canEdit;
  const canSnap = !!handle?.setSnap && !!onSnap && canEdit;
  const changeSnap = (next: SnapSettings): void => {
    if (!canSnap) return;
    handle?.setSnap?.(next); onSnap?.(next);
  };
  return <div className="fg-viewport-toolbar fg-float" role="toolbar" aria-label="Viewport tools">
    {toolButtons.map(item => <IconButton key={item.id} label={item.label} aria-pressed={tool === item.id} disabled={!canTool}
      title={canTool ? `${item.label} (${item.key})` : 'Gizmos need an editable scene and the viewport runtime.'}
      onClick={() => { if (canTool) { handle?.setTool?.(item.id); onTool(item.id); } }}>
      <item.icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </IconButton>)}
    <span className="fg-toolbar-sep" aria-hidden="true" />
    <select className="fg-select fg-select-quiet" aria-label="Transform space" title="Transform space" value={space} disabled={!canEdit || !handle?.setSpace}
      onChange={event => {
        const next = event.currentTarget.value;
        if (canEdit && handle?.setSpace && (next === 'local' || next === 'world')) { handle.setSpace(next); onSpace(next); }
      }}><option value="world">World</option><option value="local">Local</option></select>
    <span className="fg-toolbar-sep" aria-hidden="true" />
    <IconButton label="Snap" aria-pressed={snap.enabled} disabled={!canSnap} title={canSnap ? 'Snap transforms. Hold Ctrl to invert while dragging.' : 'Snapping needs an editable scene and the viewport runtime.'}
      onClick={() => changeSnap({ ...snap, enabled: !snap.enabled })}><Magnet size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
    {([
      ['translate', 'Translation snap step', ' m'], ['rotateDeg', 'Rotation snap step', '°'], ['scale', 'Scale snap step', ''],
    ] as const).map(([key, label, unit]) => <select key={key} className="fg-select fg-select-quiet" aria-label={label} title={label}
      value={snap[key]} disabled={!canSnap} onChange={event => {
        const step = Number(event.currentTarget.value);
        if ((snapSteps[key] as readonly number[]).includes(step)) changeSnap({ ...snap, [key]: step });
      }}>{snapSteps[key].map(step => <option key={step} value={step}>{step}{unit}</option>)}</select>)}
    <IconButton label="Align to surface" aria-pressed={alignToSurface} disabled={!canEdit || !handle?.surfaceAt || !onAlignToSurface}
      title="Align the object's up axis to the surface when placing"
      onClick={() => { if (canEdit && handle?.surfaceAt) onAlignToSurface?.(!alignToSurface); }}><ArrowDownToLine size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
    <IconButton label="Frame" disabled={!canFrame} title={canFrame ? 'Frame selection (F)' : 'Select an object and connect the viewport runtime to frame it.'}
      onClick={() => { if (canFrame) handle?.frameSelection?.(); }}><Focus size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
  </div>;
}
