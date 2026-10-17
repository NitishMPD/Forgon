import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ProviderId } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';
import { readPreferences, rememberModel } from '../model/preferences.js';
import { canChangeProvider, type AgentThread } from './threadState.js';
import { modelLabel, modelOptions, type ModelOption } from './modelPickerModel.js';

interface PanelProps {
  id: string;
  options: readonly ModelOption[];
  remaining: number;
  query: string;
  active: number;
  thread: AgentThread;
  triggerRef: RefObject<HTMLButtonElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery(query: string): void;
  onActive(index: number): void;
  onSelect(option: ModelOption): void;
  onClose(): void;
  children?: ReactNode;
}

// Kept controlled so keyboard behavior and focus return can be checked without launching the editor.
export function ModelPickerPanel({ id, options, remaining, query, active, thread, triggerRef, searchRef, onQuery, onActive, onSelect, onClose, children }: PanelProps) {
  const close = (): void => { onClose(); triggerRef.current?.focus(); };
  const choose = (option: ModelOption): void => { onSelect(option); close(); };
  const groups: { name: string; items: { option: ModelOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    let group = groups.at(-1);
    if (!group || group.name !== option.group) { group = { name: option.group, items: [] }; groups.push(group); }
    group.items.push({ option, index });
  });
  return <div className="fg-model-popover" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <input ref={searchRef} className="fg-input" role="combobox" aria-label="Search models" aria-autocomplete="list"
      aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={options[active] ? `${id}-option-${active}` : undefined}
      placeholder="Search models…" value={query} onChange={event => onQuery(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (options.length) onActive((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (event.key === 'Home' || event.key === 'End') {
          if (event.ctrlKey && options.length) { event.preventDefault(); onActive(event.key === 'Home' ? 0 : options.length - 1); }
        } else if (event.key === 'Enter' && options[active]) { event.preventDefault(); choose(options[active]); }
      }} />
    {!canChangeProvider(thread) ? <p className="fg-small fg-muted">Provider is fixed after a thread starts. Start a new thread to switch.</p> : null}
    <div id={`${id}-list`} role="listbox" aria-label="Models" className="fg-model-list">
      {groups.map((group, groupIndex) => <div role="group" aria-label={group.name} key={`${group.name}-${groupIndex}`}>
        <div className="fg-model-group" aria-hidden="true">{group.name}</div>
        {group.items.map(({ option, index }) => <div key={option.key} id={`${id}-option-${index}`} role="option"
          aria-selected={thread.provider === option.provider && thread.model === option.model}
          className={`fg-model-option${index === active ? ' is-active' : ''}`} title={option.model ?? 'Provider default'}
          onPointerMove={() => onActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
          <span className="fg-model-name">{option.label}</span>
          {option.vendor ? <span className="fg-model-vendor">{option.vendor}</span> : null}
          {group.name === 'Recent' ? <span className="fg-model-vendor">{option.provider === 'claude-code' ? 'Claude' : option.provider}</span> : null}
          {thread.provider === option.provider && thread.model === option.model ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : null}
        </div>)}
      </div>)}
    </div>
    {options.length === 0 ? <p className="fg-small fg-muted" role="status">No models match. Try a different search.</p> : null}
    {remaining > 0 ? <p className="fg-small fg-muted" role="status">{remaining} more — refine search</p> : null}
    {children ? <div className="fg-model-permissions">{children}</div> : null}
  </div>;
}

export function ModelPicker({ providers, thread, onSelect, children }: {
  providers: readonly AgentProviderInfo[];
  thread: AgentThread;
  onSelect(model: string | null, provider: ProviderId): void;
  children?: ReactNode;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(() => readPreferences().recentModels);
  const locked = !canChangeProvider(thread);
  const disabled = thread.starting || thread.activeRunId !== null;
  const result = useMemo(() => modelOptions(locked ? providers.filter(provider => provider.id === thread.provider) : providers, recent, query), [providers, locked, thread.provider, recent, query]);
  const activeIndex = Math.min(active, Math.max(0, result.options.length - 1));
  const provider = providers.find(provider => provider.id === thread.provider);
  const display = modelLabel(thread.model, thread.provider);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, id]);
  useEffect(() => { setOpen(false); }, [thread.id, disabled]);
  return <div className="fg-model-picker" ref={rootRef} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" ref={triggerRef} className="fg-model-trigger" aria-label="Model and agent settings"
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      disabled={disabled} title={`${provider?.name ?? thread.provider} · ${thread.model ?? 'Default model'} · Permissions`}
      onClick={() => { setOpen(value => !value); setQuery(''); setActive(0); }}>
      <span className="fg-model-vendor">{provider?.name ?? thread.provider}</span><span className="fg-model-name">{display.label}</span>
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {open && !disabled ? <ModelPickerPanel id={id} options={result.options} remaining={result.remaining} query={query} active={activeIndex}
      thread={thread} triggerRef={triggerRef} searchRef={searchRef} onQuery={value => { setQuery(value); setActive(0); }} onActive={setActive}
      onSelect={option => { onSelect(option.model, option.provider); if (option.model !== null) setRecent(rememberModel({ provider: option.provider, model: option.model })); }}
      onClose={() => setOpen(false)}>{children}</ModelPickerPanel> : null}
  </div>;
}
