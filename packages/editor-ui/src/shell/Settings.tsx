import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Copy, Keyboard, LayoutDashboard, RefreshCw, RotateCcw } from 'lucide-react';
import type { ProviderId } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';
import { permissionDescriptions, permissionLabels } from '../agent/permissions.js';
import { Button, IconButton, StatusText, cx, type Tone } from '../primitives/primitives.js';

// Sign-in runs in the provider's own CLI; Forgon only shows the command (design.md provider setup).
const signInCommands: Record<ProviderId, string> = {
  codex: 'codex login',
  'claude-code': 'claude auth login',
  opencode: 'opencode auth login',
};

const readiness: Record<AgentProviderInfo['readiness'], { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'success' },
  'not-ready': { label: 'Not ready', tone: 'danger' },
  unknown: { label: 'Not checked', tone: 'neutral' },
};

export const shortcuts: ReadonlyArray<[string, string]> = [
  ['Ctrl+S', 'Save'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Q W E R', 'Select, move, rotate, scale'],
  ['F', 'Frame selection'],
  ['Ctrl+L', 'Focus composer'],
  ['Ctrl+Shift+L', 'Add selection to message'],
  ['Ctrl+I', 'Inspector'],
  ['Ctrl+Enter', 'Send message'],
  ['Alt+Arrow', 'Move tab to next group'],
  ['Delete', 'Close focused tab'],
];

type Section = 'providers' | 'layout' | 'shortcuts';

const sections: ReadonlyArray<{ id: Section; label: string; icon: typeof Bot }> = [
  { id: 'providers', label: 'Providers', icon: Bot },
  { id: 'layout', label: 'Layout', icon: LayoutDashboard },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

function ProviderCard({ provider, onRefresh, busy }: { provider: AgentProviderInfo; onRefresh?: (() => void) | undefined; busy: boolean }) {
  const [open, setOpen] = useState(provider.readiness !== 'ready');
  const [copied, setCopied] = useState(false);
  const state = readiness[provider.readiness];
  const command = signInCommands[provider.id];
  const copy = (): void => {
    void globalThis.navigator?.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <section className="fg-provider-card" aria-labelledby={`provider-${provider.id}`}>
      <div className="fg-provider-head">
        <span className="fg-thread-avatar" aria-hidden="true">{provider.name.slice(0, 1)}</span>
        <h3 id={`provider-${provider.id}`} className="fg-provider-name">{provider.name}</h3>
        <StatusText tone={state.tone}>{state.label}</StatusText>
        <span className="fg-composer-spacer" />
        <IconButton label={`Check ${provider.name} again`} disabled={!onRefresh || busy} onClick={onRefresh}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" className={cx(busy && 'fg-spin')} />
        </IconButton>
        <IconButton label={open ? `Hide ${provider.name} details` : `Show ${provider.name} details`} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
        </IconButton>
      </div>
      {open ? (
        <dl className="fg-provider-body">
          {provider.message ? <><dt>Status</dt><dd className="fg-muted">{provider.message}</dd></> : null}
          <dt>Sign in</dt>
          <dd className="fg-provider-command">
            <code>{command}</code>
            <IconButton label={copied ? 'Copied' : 'Copy command'} onClick={copy}><Copy size={12} strokeWidth={1.75} aria-hidden="true" /></IconButton>
          </dd>
          <dt>Models</dt>
          <dd>{provider.models.length === 0 ? <span className="fg-muted">Not reported</span> : provider.models.map(model => <span key={model} className="fg-chip">{model}</span>)}</dd>
          <dt>Modes</dt>
          <dd>{provider.permissionModes.length === 0 ? <span className="fg-muted">Not reported</span> : provider.permissionModes.map(mode => <span key={mode} className="fg-chip" title={permissionDescriptions[mode]}>{permissionLabels[mode]}</span>)}</dd>
        </dl>
      ) : null}
    </section>
  );
}

export interface SettingsProps {
  providers: readonly AgentProviderInfo[] | null;
  onRefreshProviders?: (() => Promise<void>) | undefined;
  onResetLayout(): void;
}

export function Settings({ providers, onRefreshProviders, onResetLayout }: SettingsProps) {
  const [section, setSection] = useState<Section>('providers');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = onRefreshProviders ? (): void => {
    setBusy(true); setError(null);
    onRefreshProviders().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false));
  } : undefined;
  return (
    <div className="fg-settings">
      <nav className="fg-settings-nav" aria-label="Settings">
        <h2 className="fg-settings-title">Settings</h2>
        {sections.map(item => (
          <button key={item.id} type="button" className={cx('fg-settings-link', section === item.id && 'is-active')} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
            <item.icon size={14} strokeWidth={1.75} aria-hidden="true" />{item.label}
          </button>
        ))}
      </nav>
      <div className="fg-settings-page">
        {section === 'providers' ? (
          <>
            <header className="fg-settings-head"><h3>Providers</h3><span className="fg-muted">Local agent CLIs. Tokens stay with each CLI.</span></header>
            {error ? <p role="alert" className="fg-tone-danger">{error}</p> : null}
            {providers === null ? <p className="fg-muted">Agent service not connected</p>
              : providers.length === 0 ? <p className="fg-muted">No providers configured</p>
              : providers.map(provider => <ProviderCard key={provider.id} provider={provider} onRefresh={refresh} busy={busy} />)}
          </>
        ) : null}
        {section === 'layout' ? (
          <>
            <header className="fg-settings-head"><h3>Layout</h3><span className="fg-muted">Saved per project.</span></header>
            <div className="fg-provider-card fg-settings-row">
              <span>Panel layout</span>
              <Button onClick={onResetLayout}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Reset to default</Button>
            </div>
          </>
        ) : null}
        {section === 'shortcuts' ? (
          <>
            <header className="fg-settings-head"><h3>Shortcuts</h3></header>
            <dl className="fg-provider-card fg-shortcuts">
              {shortcuts.map(([keys, action]) => <div key={keys}><dt>{action}</dt><dd><kbd>{keys}</kbd></dd></div>)}
            </dl>
          </>
        ) : null}
      </div>
    </div>
  );
}
