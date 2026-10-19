import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Asterisk, Check, ChevronDown, Code2, Terminal } from 'lucide-react';
import type { ProviderId } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';
import { readPreferences, type RecentModel } from '../model/preferences.js';
import { canChangeProvider, type AgentThread } from './threadState.js';
import { modelLabel, modelOptions, reasoningOptions, type ModelOption } from './modelPickerModel.js';

const providerTabs = [
  { id: 'codex', label: 'Codex', Icon: Terminal },
  { id: 'claude-code', label: 'Claude', Icon: Asterisk },
  { id: 'opencode', label: 'OpenCode', Icon: Code2 },
] as const;

interface PanelProps {
  id: string;
  providers: readonly AgentProviderInfo[];
  providerId: ProviderId;
  recent: readonly RecentModel[];
  query: string;
  active: number;
  thread: AgentThread;
  triggerRef: RefObject<HTMLButtonElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onProvider(provider: ProviderId): void;
  onQuery(query: string): void;
  onActive(index: number): void;
  onSelect(option: ModelOption): void;
  onOption?(id: string, value: string | null): void;
  onClose(): void;
}

// Controlled so keyboard behavior and focus return can be checked without launching the editor.
export function ModelPickerPanel({ id, providers, providerId, recent, query, active, thread, triggerRef, searchRef, onProvider, onQuery, onActive, onSelect, onOption, onClose }: PanelProps) {
  const provider = providers.find(item => item.id === providerId);
  const available = provider !== undefined && provider.readiness !== 'not-ready';
  const { options, remaining } = modelOptions(available ? [provider] : [], recent, query);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const locked = !canChangeProvider(thread);
  const close = (): void => { onClose(); triggerRef.current?.focus(); };
  const choose = (option: ModelOption): void => { onSelect(option); close(); };
  const groups: { name: string; items: { option: ModelOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    let group = groups.at(-1);
    if (!group || group.name !== option.group) { group = { name: option.group, items: [] }; groups.push(group); }
    group.items.push({ option, index });
  });
  return <div className="fg-model-popover" id={`${id}-popover`} role="dialog" aria-label="Choose model" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div role="tablist" aria-label="Agent providers" className="fg-model-tabs">
      {providerTabs.map(({ id: tab, label, Icon }) => <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`}
        aria-selected={providerId === tab} aria-controls={`${id}-panel`} tabIndex={providerId === tab ? 0 : -1}
        disabled={locked && tab !== thread.provider} title={locked && tab !== thread.provider ? 'Start a new thread to switch providers.' : label}
        onClick={() => { if (!locked || tab === thread.provider) onProvider(tab); }}
        onKeyDown={event => {
          const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!direction && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const tabs = locked ? providerTabs.filter(item => item.id === thread.provider) : providerTabs;
          const index = tabs.findIndex(item => item.id === tab);
          const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length];
          if (next) {
            onProvider(next.id);
            const list = event.currentTarget.parentElement;
            list?.querySelector<HTMLButtonElement>(`[id="${id}-tab-${next.id}"]`)?.focus();
          }
        }}>
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />{label}
      </button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${providerId}`} className="fg-model-panel">
      <input ref={searchRef} className="fg-input" role="combobox" aria-label="Search models" aria-autocomplete="list"
        aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
        placeholder="Search models…" value={query} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (options.length) onActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
          } else if (event.key === 'Home' || event.key === 'End') {
            if (event.ctrlKey && options.length) { event.preventDefault(); onActive(event.key === 'Home' ? 0 : options.length - 1); }
          } else if (event.key === 'Enter' && options[activeIndex]) { event.preventDefault(); choose(options[activeIndex]); }
        }} />
      {thread.activeRunId !== null ? <p className="fg-small fg-muted">Applies to your next message</p> : null}
      {locked ? <p className="fg-small fg-muted">Provider is fixed after a thread starts. Start a new thread to switch.</p> : null}
      {!available ? <p className="fg-small fg-muted" role="status">{provider?.message ?? 'Provider is unavailable. Check provider setup.'}</p> : null}
      <div id={`${id}-list`} role="listbox" aria-label="Models" className="fg-model-list">
        {groups.map((group, groupIndex) => <div role="group" aria-label={group.name} key={`${group.name}-${groupIndex}`}>
          <div className="fg-model-group" aria-hidden="true">{group.name}</div>
          {group.items.map(({ option, index }) => <div key={option.key} id={`${id}-option-${index}`} role="option"
            aria-selected={thread.provider === option.provider && thread.model === option.model}
            className={`fg-model-option${index === activeIndex ? ' is-active' : ''}`} title={option.model ?? 'Provider default'}
            onPointerMove={() => onActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
            <span className="fg-model-name">{option.label}</span>
            {option.vendor ? <span className="fg-model-vendor">{option.vendor}</span> : null}
            {thread.provider === option.provider && thread.model === option.model ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : null}
          </div>)}
        </div>)}
      </div>
      {providerId === thread.provider ? <div className="fg-model-reasoning">
        {reasoningOptions(provider, thread.model).map(descriptor => <label key={descriptor.id} className="fg-field">
          <span className="fg-field-label">{descriptor.label}</span>
          <select className="fg-select" value={thread.modelOptions?.find(option => option.id === descriptor.id)?.value ?? ''}
            disabled={!onOption || thread.starting} onChange={event => onOption?.(descriptor.id, event.currentTarget.value || null)}>
            <option value="">Provider default{descriptor.currentValue ? ` (${descriptor.options.find(option => option.id === descriptor.currentValue)?.label ?? descriptor.currentValue})` : ''}</option>
            {descriptor.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>)}
        {reasoningOptions(provider, thread.model).length === 0 ? <p className="fg-small fg-muted">This model does not report adjustable reasoning levels.</p> : null}
      </div> : null}
      {available && options.length === 0 ? <p className="fg-small fg-muted" role="status">No models match. Try a different search.</p> : null}
      {remaining > 0 ? <p className="fg-small fg-muted" role="status">{`${remaining} more — refine search`}</p> : null}
    </div>
  </div>;
}

export function ModelPicker({ providers, thread, onSelect, onOption }: {
  providers: readonly AgentProviderInfo[];
  thread: AgentThread;
  onSelect(model: string | null, provider: ProviderId): void;
  onOption?(id: string, value: string | null): void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [providerId, setProviderId] = useState(thread.provider);
  const [recent, setRecent] = useState(() => readPreferences().recentModels);
  const disabled = thread.starting;
  const tabProvider = canChangeProvider(thread) ? providerId : thread.provider;
  const display = modelLabel(thread.model, thread.provider);
  const effort = reasoningOptions(providers.find(provider => provider.id === thread.provider), thread.model).flatMap(descriptor => {
    const value = thread.modelOptions?.find(option => option.id === descriptor.id)?.value ?? descriptor.currentValue ?? descriptor.options.find(option => option.isDefault)?.id;
    return value ? [descriptor.options.find(option => option.id === value)?.label ?? value] : [];
  }).join(', ');
  const Icon = providerTabs.find(item => item.id === thread.provider)!.Icon;
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, tabProvider, query, id]);
  useEffect(() => { setOpen(false); }, [thread.id, disabled]);
  return <div className="fg-model-picker" ref={rootRef} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" ref={triggerRef} className="fg-model-trigger" aria-label={`Model: ${display.label}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-popover` : undefined}
      disabled={disabled} title={`${providers.find(provider => provider.id === thread.provider)?.name ?? thread.provider} · ${thread.model ?? 'Default model'}`}
      onClick={() => { setOpen(value => !value); setProviderId(thread.provider); setQuery(''); setActive(0); setRecent(readPreferences().recentModels); }}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" /><span className="fg-model-name">{display.label}</span>{effort ? <span className="fg-small fg-muted">{effort}</span> : null}
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {open && !disabled ? <ModelPickerPanel id={id} providers={providers} providerId={tabProvider} recent={recent} query={query} active={active}
      thread={thread} triggerRef={triggerRef} searchRef={searchRef} onProvider={value => { setProviderId(value); setQuery(''); setActive(0); }}
      onQuery={value => { setQuery(value); setActive(0); }} onActive={setActive}
      onSelect={option => onSelect(option.model, option.provider)} {...(onOption ? { onOption } : {})} onClose={() => setOpen(false)} /> : null}
  </div>;
}
