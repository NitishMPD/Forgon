import { useEffect, useId, useRef, useState } from 'react';
import { Box, Package, Search } from 'lucide-react';
import type { AssetRecord, PrefabDocument } from '@forgon/project-schema';
import { searchPlacements, type PlacementTarget } from '../model/placement.js';

export function QuickAdd({ x, y, assets, prefabs, onPlace, onClose }: {
  x: number; y: number;
  assets: readonly AssetRecord[]; prefabs: readonly PrefabDocument[];
  onPlace(target: PlacementTarget): void;
  onClose(restoreFocus: boolean): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const matches = searchPlacements(assets, prefabs, query);
  const shown = matches.slice(0, 100);
  const index = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, query]);
  useEffect(() => {
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) onClose(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onClose]);
  return <div ref={root} className="fg-quick-add" style={{ left: x, top: y }} role="dialog" aria-label="Add object at surface"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(false); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (shown.length) setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
      } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (shown[index]) onPlace(shown[index].target);
      }
    }}>
    <label className="fg-quick-add-search"><Search size={14} aria-hidden="true" />
      <input ref={input} role="combobox" aria-label="Search objects and assets" placeholder="Search objects and assets…" value={query}
        aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={shown[index] ? `${id}-${index}` : undefined}
        onChange={event => { setQuery(event.currentTarget.value); setActive(0); }} />
    </label>
    <div id={`${id}-list`} role="listbox" aria-label="Objects and assets" className="fg-quick-add-results">
      {shown.map((choice, row) => <button key={`${choice.target.kind}:${choice.target.kind === 'primitive' ? choice.target.primitive : choice.target.kind === 'prefab' ? choice.target.prefabId : choice.target.assetId}`}
        id={`${id}-${row}`} type="button" role="option" tabIndex={-1} aria-selected={row === index} className="fg-quick-add-option"
        onPointerDown={event => event.preventDefault()} onClick={() => onPlace(choice.target)}>
        {choice.target.kind === 'prefab' ? <Package size={14} aria-hidden="true" /> : <Box size={14} aria-hidden="true" />}
        <span>{choice.name}</span><small className="fg-muted">{choice.detail}</small>
      </button>)}
    </div>
    {shown.length === 0 ? <p className="fg-muted" role="status">No placeable objects or assets</p> : null}
    {matches.length > shown.length ? <p className="fg-muted" role="status">Showing 100 of {matches.length}. Refine your search.</p> : null}
  </div>;
}
