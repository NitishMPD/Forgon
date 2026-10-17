import { useState } from 'react';
import type { AssetRecord } from '@forgon/project-schema';
import { Banner, Button, EmptyState } from '../../primitives/primitives.js';

export interface AssetsPanelProps {
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  onRefresh?: (() => Promise<void>) | undefined;
  onImport?: ((license: string) => Promise<void>) | undefined;
}

export function AssetsPanel({ assets, projectOpen, onRefresh, onImport }: AssetsPanelProps) {
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!projectOpen) {
    return (
      <section className="fg-dock-panel" aria-label="Assets">
        <EmptyState title="No project open">Assets come from the project's asset registry. The in-memory sample has none.</EmptyState>
      </section>
    );
  }
  return (
    <section className="fg-dock-panel" aria-label="Assets">
      <div className="fg-toolbar">
        <span className="fg-muted fg-small">{assets.length} registered</span>
        <Button disabled={!onRefresh || busy} title={onRefresh ? 'Read the registered asset metadata from disk.' : 'The host does not expose catalog refresh.'} onClick={() => { if (onRefresh) void run(onRefresh); }}>Refresh</Button>
        <Button disabled={!onImport || !license.trim() || busy} title={onImport ? 'Choose a source file using the native file picker.' : 'The host does not expose asset import.'} onClick={() => { if (onImport) void run(() => onImport(license.trim())); }}>Choose file and import</Button>
      </div>
      {onImport ? <label className="fg-field">Source license declaration
        <input className="fg-input" value={license} disabled={busy} placeholder="License or ownership declaration" onChange={event => setLicense(event.currentTarget.value)} />
      </label> : null}
      {busy ? <p role="status">Reading asset metadata or importing...</p> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {assets.length === 0 ? (
        <EmptyState title="No assets registered">The project's asset registry is empty.</EmptyState>
      ) : (
        <div className="fg-table-wrap">
          <table className="fg-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Path</th>
                <th scope="col">Source and license</th>
              </tr>
            </thead>
            <tbody>
              {assets.map(asset => (
                <tr key={asset.id}>
                  <td>{asset.name}</td>
                  <td>{asset.kind}</td>
                  <td className="fg-mono">{asset.path}</td>
                  <td>{asset.provenance ? `${asset.provenance.source} · ${asset.provenance.license}` : <span className="fg-muted">Not recorded</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
