import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Check, Lock, LockOpen, Pencil, ShieldCheck, Sparkles } from 'lucide-react';
import type { PermissionMode } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';
import { enforcementNote, permissionDescriptions, permissionLabels, providerLimitsNote } from './permissions.js';

const modeIcons = { inspect: Lock, supervised: ShieldCheck, 'auto-edits': Pencil, auto: Sparkles, 'full-local': LockOpen };

export function PermissionPickerPanel({ id, provider, value, triggerRef, onSelect, onClose }: {
  id: string;
  provider: AgentProviderInfo;
  value: PermissionMode | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect(mode: PermissionMode): void;
  onClose(): void;
}) {
  const close = (): void => { onClose(); triggerRef.current?.focus(); };
  return <div id={id} role="dialog" aria-label="Permission mode" className="fg-model-popover fg-permission-popover" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[aria-pressed]'));
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    {provider.permissionModes.map(mode => {
      const Icon = modeIcons[mode];
      return <button key={mode} type="button" className="fg-permission-option" aria-pressed={mode === value}
        onClick={() => { onSelect(mode); close(); }}>
        <span className="fg-permission-label"><Icon size={14} strokeWidth={1.75} aria-hidden="true" />{permissionLabels[mode]}
          {mode === value ? <Check size={14} aria-hidden="true" /> : null}</span>
        <span className="fg-small fg-muted">{permissionDescriptions[mode]}</span>
      </button>;
    })}
    <details className="fg-small fg-muted"><summary>Provider details</summary><p>{enforcementNote(value ?? 'supervised')}</p><p>{providerLimitsNote(provider)}</p></details>
    <p className="fg-small fg-muted">Applies to your next message</p>
  </div>;
}

export function PermissionPicker({ provider, value, starting, onSelect }: {
  provider: AgentProviderInfo | null;
  value: PermissionMode | null;
  starting: boolean;
  onSelect(mode: PermissionMode): void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const disabled = starting || !provider?.permissionModes.length;
  const label = value ? permissionLabels[value] : 'Choose permissions';
  const explanation = !provider?.permissionModes.length ? 'The provider did not report supported permission modes.'
    : starting ? 'Wait for the message to start before changing permissions.'
    : value ? permissionDescriptions[value] : 'Choose a permission mode before sending.';
  const Icon = value ? modeIcons[value] : ShieldCheck;
  useEffect(() => { setOpen(false); }, [provider?.id, disabled]);
  useEffect(() => {
    if (!open) return;
    (rootRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? rootRef.current?.querySelector<HTMLButtonElement>('[aria-pressed]'))?.focus();
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="fg-model-picker fg-permission-picker" ref={rootRef} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" ref={triggerRef} className="fg-model-trigger"
      aria-label={`Permissions: ${label}`} aria-describedby={`${id}-help`} title={explanation} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" /><span>{value ? permissionLabels[value] : 'Permissions'}</span>
    </button>
    <span id={`${id}-help`} className="fg-sr-only">{explanation}</span>
    {open && !disabled && provider ? <PermissionPickerPanel id={`${id}-panel`} provider={provider} value={value} triggerRef={triggerRef}
      onSelect={onSelect} onClose={() => setOpen(false)} /> : null}
  </div>;
}
