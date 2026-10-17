import { useEffect, useState } from 'react';
import { projectDestination } from '../model/projectDestination.js';
import type { Diagnostic } from '@forgon/project-schema';
import type { CreatePlan, ProjectHost, ProjectOpenResult, ProjectSession, RecentProject } from '../services.js';
import { Banner, Button, EmptyState, StatusText, type Tone } from '../primitives/primitives.js';

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

  const confirmCreate = async (): Promise<void> => {
    if (!host || !plan) return;
    const root = plan.root;
    setPlan(null);
    await run(root, () => host.create(root));
  };

  return (
    <main className="fg-launcher" aria-labelledby="launcher-title">
      <header className="fg-launcher-header">
        <h1 id="launcher-title" className="fg-launcher-title">Forgon Engine</h1>
        <p className="fg-muted">Local, file-based game projects. Open a project folder or start from a template.</p>
      </header>
      {!host ? (
        <Banner tone="warning">
          The desktop host is not connected in this build. Projects cannot be opened, created or saved. You can still open the in-memory sample.
        </Banner>
      ) : null}
      {notice ? <Banner tone="warning">{notice}</Banner> : null}
      {failure ? (
        <section className="fg-launch-failure" role="alert" aria-labelledby="failure-title">
          <h2 id="failure-title" className="fg-section-title">
            {failure.reason === 'not-project' ? 'This folder is not a Forgon project' : failure.reason === 'invalid' ? 'The project has validation errors' : "Can't read this folder"}
          </h2>
          <p className="fg-small">{failure.message}</p>
          {failure.reason === 'not-project' ? (
            <p className="fg-small fg-muted">Forgon does not import Unity, Godot, or PlayCanvas Editor projects in V1.</p>
          ) : null}
          <DiagnosticList diagnostics={failure.diagnostics} />
          <div className="fg-toolbar">
            {failure.reason === 'not-project' && failure.root !== null ? (
              <Button variant="primary" disabled={busy} onClick={() => { setParent(failure.root); setPlan(null); }}>Create a project in a new child folder</Button>
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
            <Button disabled={busy} onClick={() => { void planChild(); }}>Review files and destination</Button>
            <Button disabled={busy} onClick={() => setParent(null)}>Cancel</Button>
          </div>
        </section>
      ) : null}
      {plan ? (
        <section className="fg-launch-failure" aria-labelledby="create-title">
          <h2 id="create-title" className="fg-section-title">Create this project?</h2>
          {plan.blockedReason ? <Banner tone="danger">{plan.blockedReason}</Banner> : null}
          <p className="fg-small fg-mono">{plan.root}</p>
          <p className="fg-small">These files will be added. Existing files are never overwritten.</p>
          <ul className="fg-list-plain fg-mono">
            {plan.files.map(file => <li key={file}>{file}</li>)}
          </ul>
          <div className="fg-toolbar">
            <Button variant="primary" disabled={busy || plan.blockedReason !== undefined} onClick={confirmCreate}>Create project</Button>
            <Button variant="ghost" onClick={() => { setPlan(null); setParent(null); }}>Cancel</Button>
          </div>
        </section>
      ) : null}
      <div className="fg-launcher-grid">
        <section className="fg-launcher-recents" aria-labelledby="recent-title">
          <h2 id="recent-title" className="fg-section-title">Recent projects</h2>
          {!host ? (
            <EmptyState title="Recent projects unavailable">They are listed by the desktop host.</EmptyState>
          ) : recents === null ? (
            <p className="fg-muted">Loading recent projects…</p>
          ) : recents.length === 0 ? (
            <EmptyState title="No recent projects">Create one or open a folder.</EmptyState>
          ) : (
            <ul className="fg-recent-list">
              {recents.map(item => {
                const word = recentWords[item.status];
                return (
                  <li key={item.path} className="fg-recent-row">
                    <button
                      type="button"
                      className="fg-recent-open"
                      disabled={busy || item.status === 'unavailable'}
                      onClick={() => openRoot(item.path)}
                    >
                      <span className="fg-recent-name">{item.name}</span>
                      <span className="fg-mono fg-muted fg-recent-path" title={item.path}>{item.path}</span>
                    </button>
                    <StatusText tone={word.tone}>{word.label}</StatusText>
                    <span className="fg-muted fg-small">{item.lastOpened}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="fg-launcher-actions" aria-labelledby="actions-title">
          <h2 id="actions-title" className="fg-section-title">Start</h2>
          <div className="fg-action-list">
            <div className="fg-action">
              <Button variant="primary" disabled={!host || busy} onClick={openFolder}>Open folder…</Button>
              <p className="fg-small fg-muted">Choose a folder that contains game.project.json.</p>
            </div>
            <div className="fg-action">
              <Button disabled={!host || busy} onClick={newProject}>New project…</Button>
              <p className="fg-small fg-muted">Empty 3D template. Creates files only after you confirm the list.</p>
            </div>
            {host?.openExample ? (
              <div className="fg-action">
                <Button disabled={busy} onClick={() => run(null, () => host.openExample!())}>Open example</Button>
                <p className="fg-small fg-muted">Opens a copy of the hotel fixture. The original is never changed.</p>
              </div>
            ) : null}
            <div className="fg-action">
              <Button disabled={busy} onClick={onSample}>Open in-memory sample</Button>
              <p className="fg-small fg-muted">Not saved to disk. No project folder, no agent, no export.</p>
            </div>
          </div>
          <p className="fg-small fg-muted">Opening a project does not run code from it. Project scripts run only when you press Play.</p>
        </section>
      </div>
    </main>
  );
}
