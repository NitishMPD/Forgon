import { useMemo, useState } from 'react';
import { Box, FileCode, FileQuestion, Folder, FolderOpen, Image, Import, Palette, RefreshCw, Search, Volume2, type LucideIcon } from 'lucide-react';
import type { AssetRecord } from '@forgon/project-schema';
import { Banner, Button, EmptyState, IconButton, cx } from '../../primitives/primitives.js';

export interface AssetsPanelProps {
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  onRefresh?: (() => Promise<void>) | undefined;
  onImport?: ((license: string) => Promise<void>) | undefined;
}

const kindIcons: Record<AssetRecord['kind'], LucideIcon> = {
  model: Box,
  texture: Image,
  audio: Volume2,
  material: Palette,
  script: FileCode,
  other: FileQuestion,
};

const dirOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// Every folder that holds an asset, plus its ancestors, sorted so parents come first.
function folderList(assets: readonly AssetRecord[]): string[] {
  const folders = new Set<string>(['']);
  for (const asset of assets) {
    let dir = dirOf(asset.path);
    while (dir !== '') { folders.add(dir); dir = dirOf(dir); }
  }
  return [...folders].sort();
}

export function AssetsPanel({ assets, projectOpen, onRefresh, onImport }: AssetsPanelProps) {
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const folders = useMemo(() => folderList(assets), [assets]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!projectOpen) {
    return (
      <section className="fg-dock-panel" aria-label="Assets">
        <EmptyState title="No project open" />
      </section>
    );
  }
  const needle = query.trim().toLowerCase();
  // Searching looks across all folders; browsing shows the current folder's files and subfolders.
  const files = needle
    ? assets.filter(asset => asset.name.toLowerCase().includes(needle) || asset.path.toLowerCase().includes(needle))
    : assets.filter(asset => dirOf(asset.path) === folder);
  const subfolders = needle ? [] : folders.filter(item => item !== '' && dirOf(item) === folder);
  const selected = assets.find(asset => asset.id === selectedId) ?? null;
  const depth = (path: string): number => (path === '' ? 0 : path.split('/').length);

  return (
    <section className="fg-dock-panel fg-assets" aria-label="Assets">
      <div className="fg-assets-bar">
        <label className="fg-search">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="fg-sr-only">Search assets</span>
          <input value={query} placeholder="Search" onChange={event => setQuery(event.currentTarget.value)} />
        </label>
        <span className="fg-muted fg-small">{assets.length}</span>
        <span className="fg-composer-spacer" />
        <IconButton label="Refresh" title={onRefresh ? 'Reload asset metadata' : 'Refresh is not available in this host'} disabled={!onRefresh || busy} onClick={() => { if (onRefresh) void run(onRefresh); }}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <IconButton label="Import" title={onImport ? 'Import a file' : 'Import is not available in this host'} disabled={!onImport} aria-expanded={importing} onClick={() => setImporting(open => !open)}>
          <Import size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>
      {importing && onImport ? (
        <div className="fg-import" role="group" aria-label="Import asset">
          <label className="fg-sr-only" htmlFor="asset-license">Source license declaration</label>
          <input id="asset-license" className="fg-input" value={license} disabled={busy} placeholder="License or ownership (required)" onChange={event => setLicense(event.currentTarget.value)} />
          <Button variant="primary" disabled={!license.trim() || busy} onClick={() => { void run(() => onImport(license.trim())).then(() => setImporting(false)); }}>Choose file</Button>
        </div>
      ) : null}
      {busy ? <p className="fg-sr-only" role="status">Working…</p> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {assets.length === 0 ? <EmptyState title="No assets" /> : (
        <div className="fg-assets-body">
          <ul className="fg-folder-tree" aria-label="Folders">
            {folders.map(item => (
              <li key={item || 'root'}>
                <button type="button" className={cx('fg-folder', item === folder && !needle && 'is-selected')} style={{ paddingLeft: 8 + depth(item) * 12 }} aria-current={item === folder ? 'true' : undefined} onClick={() => { setFolder(item); setQuery(''); }}>
                  {item === folder ? <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" /> : <Folder size={14} strokeWidth={1.75} aria-hidden="true" />}
                  <span>{item === '' ? 'Project' : baseName(item)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="fg-assets-main">
            <ul className="fg-asset-grid" aria-label={needle ? 'Search results' : `Files in ${folder || 'project'}`}>
              {subfolders.map(item => (
                <li key={item}>
                  <button type="button" className="fg-asset-tile" title={item} onDoubleClick={() => setFolder(item)} onClick={() => setFolder(item)}>
                    <span className="fg-asset-thumb"><Folder size={22} strokeWidth={1.5} aria-hidden="true" /></span>
                    <span className="fg-asset-name">{baseName(item)}</span>
                  </button>
                </li>
              ))}
              {files.map(asset => {
                const Icon = kindIcons[asset.kind];
                return (
                  <li key={asset.id}>
                    <button type="button" className={cx('fg-asset-tile', asset.id === selectedId && 'is-selected')} aria-pressed={asset.id === selectedId} title={`${asset.name} · ${asset.path}`} onClick={() => setSelectedId(asset.id)}>
                      <span className="fg-asset-thumb"><Icon size={22} strokeWidth={1.5} aria-hidden="true" /></span>
                      <span className="fg-asset-name">{baseName(asset.path)}</span>
                    </button>
                  </li>
                );
              })}
              {subfolders.length === 0 && files.length === 0 ? <li className="fg-muted fg-small">{needle ? 'No matches' : 'Empty folder'}</li> : null}
            </ul>
            {selected ? (
              <dl className="fg-asset-detail">
                <div><dt>Name</dt><dd>{selected.name}</dd></div>
                <div><dt>Kind</dt><dd>{selected.kind}</dd></div>
                <div><dt>Path</dt><dd className="fg-mono">{selected.path}</dd></div>
                <div><dt>License</dt><dd title={selected.provenance?.source}>{selected.provenance ? selected.provenance.license : 'Not recorded'}</dd></div>
              </dl>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
