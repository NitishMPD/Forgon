import { canonicalRoot, boundaryError, missing, readBytes } from './files.js';
import { openProject, createProject, planCreate } from './index.js';
import { readProject } from './read-project.js';
import type { NodeProjectHost, NodeProjectSession, ProjectOpenResult, RecentProject } from './types.js';

/** The native shell owns folder selection; recents here last for this host's lifetime. */
export function createNodeProjectHost(pickFolder: () => Promise<string | null>): NodeProjectHost {
  const recents = new Map<string, RecentProject>();
  const run = async (root: string, action: () => Promise<NodeProjectSession>): Promise<ProjectOpenResult> => {
    try {
      const session = await action();
      recents.delete(session.root);
      recents.set(session.root, { path: session.root, name: session.manifest.name, lastOpened: new Date().toISOString(), status: 'ready' });
      return { status: 'opened', session };
    } catch (error) {
      const failure = boundaryError(error);
      let reason: 'not-project' | 'invalid' | 'unreadable' = failure.code === 'IO_ERROR' || failure.code === 'NOT_FOUND' ? 'unreadable' : 'invalid';
      if (failure.code === 'NOT_FOUND') {
        try { const canonical = await canonicalRoot(root); await readBytes(canonical, 'game.project.json'); }
        catch (manifestError) {
          // A missing root is unreadable; only an existing folder without a manifest is not a project.
          try { await canonicalRoot(root); if (missing(manifestError)) reason = 'not-project'; } catch { /* Keep unreadable. */ }
        }
      }
      return { status: 'failed', reason, message: failure.message, diagnostics: [{ path: root, message: failure.message }] };
    }
  };
  return {
    pickFolder,
    planCreate,
    open: root => run(root, () => openProject(root)),
    create: root => run(root, () => createProject(root)),
    async listRecent() {
      return Promise.all([...recents.values()].reverse().map(async recent => {
        try { await readProject(recent.path); return { ...recent }; }
        catch (error) { return { ...recent, status: missing(error) ? 'unavailable' as const : 'needs_attention' as const }; }
      }));
    },
  };
}
