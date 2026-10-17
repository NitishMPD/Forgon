import { useEffect, useState } from 'react';
import { projectDestination } from '../model/projectDestination.js';
import type { Diagnostic } from '@forgon/project-schema';
import type { CreatePlan, ProjectHost, ProjectOpenResult, ProjectSession, RecentProject } from '../services.js';
import { Box, Building2, Copy, Diamond, FolderOpen, Plus, Search, ShieldCheck, X } from 'lucide-react';
import { Banner, Button, IconButton, StatusText, type Tone } from '../primitives/primitives.js';

export interface LauncherProps {
  host: ProjectHost | null;
  onOpened(session: ProjectSession): void;
  onSample(): void;
}

type Failure = Extract<ProjectOpenResult, { status: 'failed' }> & { root: string | null };

const recentWords: Record<RecentProject['status'], { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'success' },
  needs_attention: { label: 'Needs attention', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'danger' },
};

const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// Short relative time for the recent list; the exact timestamp stays in the tooltip.
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function DiagnosticList({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="fg-diagnostics" aria-label="Validation problems">
      {diagnostics.map((item, index) => (
        <li key={`${item.path}:${index}`}>
          <span className="fg-mono">{item.path}</span> {item.message}
        </li>
      ))}
    </ul>
  );
}

export function Launcher({ host, onOpened, onSample }: LauncherProps) {
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [plan, setPlan] = useState<CreatePlan | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('My game');
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    host.listRecent().then(
      list => { if (!cancelled) setRecents(list); },
      (error: unknown) => {
        if (!cancelled) {
          setRecents([]);
          setNotice(`Could not read recent projects: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );
    return () => { cancelled = true; };
  }, [host]);

  // root is the folder a retry targets; null for actions that have no folder (the example copy).
  const run = async (root: string | null, action: () => Promise<ProjectOpenResult>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await action();
      if (result.status === 'opened') onOpened(result.session);
      else setFailure({ ...result, root });
    } catch (error) {
      setFailure({ status: 'failed', reason: 'unreadable', message: error instanceof Error ? error.message : String(error), diagnostics: [], root });
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    if (!host) return;
    try {
      const root = await host.pickFolder();
      if (root !== null) await openRoot(root);
    } catch (error) { setNotice(String(error)); }
  };

  const openRoot = (root: string): Promise<void> => {
    if (!host) return Promise.resolve();
    return run(root, () => host.open(root));
  };

  const newProject = async (): Promise<void> => {
    if (!host) return;
    try {
      const chosen = await host.pickFolder();
      if (chosen !== null) { setParent(chosen); setPlan(null); setFailure(null); }
    } catch (error) { setNotice(String(error)); }
  };

  const planChild = async (): Promise<void> => {
    if (!host || parent === null) return;
    setBusy(true);
    try {
      const destination = projectDestination(parent, name);
      setPlan(await (host.planCreateChild ? host.planCreateChild(parent, name) : host.planCreate(destination)));
      setNotice(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const forget = async (root: string): Promise<void> => {
    if (!host?.forgetRecent) return;
    try {
      await host.forgetRecent(root);
      setRecents(list => list?.filter(item => item.path !== root) ?? null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const confirmCreate = async (): Promise<void> => {
    if (!host || !plan) return;
    const root = plan.root;
    setPlan(null);
    await run(root, () => host.create(root));
  };

  const needle = query.trim().toLowerCase();
  const shown = recents?.filter(item => !needle || item.name.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle)) ?? null;
  const actions = [
    { label: 'Open folder…', hint: 'game.project.json', icon: FolderOpen, primary: true, disabled: !host || busy, onClick: () => { void openFolder(); } },
    { label: 'New project…', hint: 'Empty 3D', icon: Plus, primary: false, disabled: !host || busy, onClick: () => { void newProject(); } },
    ...(host?.openExample ? [{ label: 'Open example', hint: 'Copy of the hotel', icon: Building2, primary: false, disabled: busy, onClick: () => { void run(null, () => host.openExample!()); } }] : []),
    { label: 'In-memory sample', hint: 'Not saved', icon: Box, primary: false, disabled: busy, onClick: onSample },
  ];

  return (
    <main className="fg-launcher" aria-labelledby="launcher-title">
      <header className="fg-launcher-header">
        <span className="fg-logo" aria-hidden="true"><Diamond size={16} strokeWidth={2} /></span>
        <h1 id="launcher-title" className="fg-launcher-title">Forgon Engine</h1>
      </header>
      {!host ? <Banner tone="warning">The desktop host is not connected in this build. Only the in-memory sample is available.</Banner> : null}
      {notice ? <Banner tone="warning">{notice}</Banner> : null}
      {failure ? (
        <section className="fg-launch-failure" role="alert" aria-labelledby="failure-title">
          <h2 id="failure-title" className="fg-section-title">
            {failure.reason === 'not-project' ? 'This folder is not a Forgon project' : failure.reason === 'invalid' ? 'The project has validation errors' : "Can't read this folder"}
          </h2>
          <p className="fg-small">{failure.message}</p>
          {failure.reason === 'not-project' ? <p className="fg-small fg-muted">Projects from other engines are not imported.</p> : null}
          <DiagnosticList diagnostics={failure.diagnostics} />
          <div className="fg-toolbar">
            {failure.reason === 'not-project' && failure.root !== null ? (
              <Button variant="primary" disabled={busy} onClick={() => { setParent(failure.root); setPlan(null); }}>Create project here</Button>
            ) : null}
            {failure.reason !== 'not-project' && failure.root !== null ? (
              <Button disabled={busy} onClick={() => openRoot(failure.root!)}>Retry</Button>
            ) : null}
            <Button variant="ghost" onClick={() => setFailure(null)}>Dismiss</Button>
          </div>
        </section>
      ) : null}
      {parent !== null && plan === null ? (
        <section className="fg-launch-failure" aria-label="New project destination">
          <p className="fg-small">Parent folder: <span className="fg-mono">{parent}</span></p>
          <label className="fg-field">Project folder name
            <input className="fg-input" value={name} onChange={event => setName(event.currentTarget.value)} disabled={busy} />
          </label>
          <div className="fg-toolbar">
            <Button disabled={busy} onClick={() => { void planChild(); }}>Review files</Button>
            <Button disabled={busy} onClick={() => setParent(null)}>Cancel</Button>
          </div>
        </section>
      ) : null}
      {plan ? (
        <section className="fg-launch-failure" aria-labelledby="create-title">
          <h2 id="create-title" className="fg-section-title">Create this project?</h2>
          {plan.blockedReason ? <Banner tone="danger">{plan.blockedReason}</Banner> : null}
          <p className="fg-small fg-mono">{plan.root}</p>
          <p className="fg-small fg-muted">Adds these files. Never overwrites.</p>
          <ul className="fg-list-plain fg-mono">
            {plan.files.map(file => <li key={file}>{file}</li>)}
          </ul>
          <div className="fg-toolbar">
            <Button variant="primary" disabled={busy || plan.blockedReason !== undefined} onClick={confirmCreate}>Create project</Button>
            <Button variant="ghost" onClick={() => { setPlan(null); setParent(null); }}>Cancel</Button>
          </div>
        </section>
      ) : null}
      <nav className="fg-launch-actions" aria-label="Start">
        {actions.map(action => (
          <button key={action.label} type="button" className={action.primary ? 'fg-launch-tile is-primary' : 'fg-launch-tile'} disabled={action.disabled} onClick={action.onClick}>
            <span className="fg-launch-icon"><action.icon size={18} strokeWidth={1.75} aria-hidden="true" /></span>
            <span className="fg-launch-label">{action.label}</span>
            <span className="fg-launch-hint">{action.hint}</span>
          </button>
        ))}
      </nav>
      <section className="fg-launcher-recents" aria-labelledby="recent-title">
        <header className="fg-launcher-list-head">
          <h2 id="recent-title" className="fg-section-title">Recent projects</h2>
          {recents && recents.length > 0 ? (
            <label className="fg-search">
              <Search size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="fg-sr-only">Search projects</span>
              <input value={query} placeholder="Search" onChange={event => setQuery(event.currentTarget.value)} />
            </label>
          ) : null}
        </header>
        {!host ? <p className="fg-muted">Recent projects unavailable</p>
          : shown === null ? <p className="fg-muted">Loading…</p>
          : recents!.length === 0 ? <p className="fg-muted">No recent projects</p>
          : shown.length === 0 ? <p className="fg-muted">No matches</p> : (
            <ul className="fg-recent-list">
              {shown.map(item => {
                const word = recentWords[item.status];
                return (
                  <li key={item.path} className="fg-recent-row">
                    <button
                      type="button"
                      className="fg-recent-open"
                      disabled={busy || item.status === 'unavailable'}
                      title={item.path}
                      onClick={() => openRoot(item.path)}
                    >
                      <span className="fg-recent-avatar" aria-hidden="true">{item.name.slice(0, 1)}</span>
                      <span className="fg-recent-text">
                        <span className="fg-recent-name">{item.name}</span>
                        <span className="fg-recent-path">{folderName(item.path)}</span>
                      </span>
                    </button>
                    {item.status === 'ready' ? null : <StatusText tone={word.tone}>{word.label}</StatusText>}
                    <span className="fg-muted fg-small" title={item.lastOpened}>{relativeTime(item.lastOpened)}</span>
                    <span className="fg-recent-actions">
                      <IconButton label={`Copy path of ${item.name}`} onClick={() => { void globalThis.navigator?.clipboard?.writeText(item.path); }}>
                        <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                      </IconButton>
                      {host.forgetRecent ? (
                        <IconButton label={`Remove ${item.name} from recents`} title="Remove from recents (files stay on disk)" disabled={busy} onClick={() => { void forget(item.path); }}>
                          <X size={14} strokeWidth={1.75} aria-hidden="true" />
                        </IconButton>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
      </section>
      <p className="fg-launcher-foot"><ShieldCheck size={12} strokeWidth={1.75} aria-hidden="true" />Opening a project does not run code from it.</p>
    </main>
  );
}
