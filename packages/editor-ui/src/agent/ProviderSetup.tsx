import { useState } from 'react';
import type { AgentProviderInfo } from '../services.js';
import { Button, EmptyState, StatusText, type Tone } from '../primitives/primitives.js';
import { permissionDescriptions, permissionLabels, providerLimitsNote } from './permissions.js';

const readinessWords: Record<AgentProviderInfo['readiness'], { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'success' },
  'not-ready': { label: 'Not ready', tone: 'danger' },
  unknown: { label: 'Not checked', tone: 'neutral' },
};

export function ProviderSetup({ providers, onClose, onRefresh }: { providers: readonly AgentProviderInfo[]; onClose?: (() => void) | undefined; onRefresh?: (() => Promise<void>) | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    if (!onRefresh) return;
    setBusy(true); setError(null);
    try { await onRefresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <section className="fg-provider-setup" aria-labelledby="provider-setup-title">
      <header className="fg-toolbar">
        <h3 id="provider-setup-title" className="fg-section-title">Providers</h3>
        {onClose ? <Button variant="ghost" onClick={onClose}>Close</Button> : null}
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {providers.length === 0 ? (
        <EmptyState title="No provider is configured">The editor works without an agent. Connect a provider to use the composer.</EmptyState>
      ) : (
        <div className="fg-table-wrap">
          <table className="fg-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">State</th>
                <th scope="col">Permission modes</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {providers.map(provider => {
                const word = readinessWords[provider.readiness];
                return (
                  <tr key={provider.id}>
                    <td>{provider.name}</td>
                    <td>
                      <StatusText tone={word.tone}>{word.label}</StatusText>
                      {provider.message ? <div className="fg-muted fg-small">{provider.message}</div> : null}
                    </td>
                    <td>
                      {provider.permissionModes.length === 0
                        ? <span className="fg-muted">Not reported</span>
                        : provider.permissionModes.map(mode => (
                          <span key={mode} className="fg-chip" title={permissionDescriptions[mode]}>{permissionLabels[mode]}</span>
                        ))}
                      <div className="fg-muted fg-small">{providerLimitsNote(provider)}</div>
                    </td>
                    <td>
                      <Button disabled={!onRefresh || busy} title={onRefresh ? 'Check provider readiness again.' : 'No readiness probe is connected in this build.'} onClick={() => { void refresh(); }}>Check again</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fg-muted fg-small">Forgon never reads or copies provider tokens. Sign in through the provider's own CLI.</p>
    </section>
  );
}
