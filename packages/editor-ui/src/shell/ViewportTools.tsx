import { Focus, MousePointer2, Move, RotateCw, Scaling, type LucideIcon } from 'lucide-react';
import { IconButton } from '../primitives/primitives.js';
import type { ViewportHandle, ViewportTool } from '../services.js';

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
}
export function ViewportTools({ tool, space, handle, canEdit, canFrame, onTool, onSpace }: ViewportToolsProps) {
  const canTool = !!handle?.setTool && canEdit;
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
    <IconButton label="Frame" disabled={!canFrame} title={canFrame ? 'Frame selection (F)' : 'Select an object and connect the viewport runtime to frame it.'}
      onClick={() => { if (canFrame) handle?.frameSelection?.(); }}><Focus size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
  </div>;
}
