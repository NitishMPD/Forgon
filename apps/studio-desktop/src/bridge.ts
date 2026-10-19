import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { compileProjectScripts } from '@forgon/project-io/scripting';
import { createNodeProjectHost, createProject, readProject } from '@forgon/project-io/node';
import type { NodeProjectSession, RecentProject } from '@forgon/project-io';
import { importAsset, readAssetRegistry } from '@forgon/asset-pipeline';
import type { SaveSceneRequest, AgentRunRequest, AgentEvent } from '@forgon/project-schema';
import type { RunningAgentService } from '@forgon/agent-service';
import { agentAnswersSchema } from '@forgon/agent-service';
import { parseRequest, string, type BridgeEvent } from './protocol.js';

export interface BridgeOptions {
  dataDir: string;
  emit(event: BridgeEvent): void;
  agent?: RunningAgentService;
  agentMessage?: string;
}

/** One bridge per native window. Paths are granted only by native dialogs or persisted recents. */
export async function createDesktopBridge(options: BridgeOptions) {
  await mkdir(options.dataDir, { recursive: true });
  const recentPath = join(options.dataDir, 'recent-projects.json');
  const recents = new Map<string, RecentProject>();
  try {
    const bytes = await readFile(recentPath);
    if (bytes.length > 128 * 1024) throw new Error('Recent projects file exceeds limit');
    const values: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(values) || values.length > 20) throw new Error('Invalid recent projects');
    for (const value of values) {
      if (!value || typeof value !== 'object') throw new Error('Invalid recent project');
      const path = string(value.path, 'recent root');
      if (!isAbsolute(path)) throw new Error('Invalid recent root');
      recents.set(path, { path, name: string(value.name, 'name'), lastOpened: string(value.lastOpened, 'date'), status: 'ready' });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt state grants no paths; preserve it for recovery instead of trusting partial data.
      recents.clear();
    }
  }
  const roots = new Set(recents.keys());
  const destinations = new Set<string>();
  const sessions = new Map<string, { session: NodeProjectSession; watches: Map<string, () => void> }>();
  const runs = new Set<string>();
  const earlyEvents: AgentEvent[] = [];
  let startingRuns = 0;
  let closed = false;
  let generation = 0;
  let persistence = Promise.resolve();
  const host = createNodeProjectHost(async () => null);
  let agentUnsubscribe: (() => void) | undefined;
  function subscribeAgent() {
    agentUnsubscribe = options.agent?.service.subscribe(value => {
      if (!closed && runs.has(value.runId)) options.emit({ kind: 'agent', value });
      else if (!closed && startingRuns && earlyEvents.length < 128) earlyEvents.push(value);
    });
  }
  subscribeAgent();
  async function remember(session: NodeProjectSession) {
    recents.delete(session.root);
    recents.set(session.root, { path: session.root, name: session.manifest.name, lastOpened: new Date().toISOString(), status: 'ready' });
    while (recents.size > 20) recents.delete(recents.keys().next().value!);
    roots.add(session.root);
    // A recent-list write failure must not turn successful project creation into a retry/overwrite.
    await persistRecents().catch(() => {});
  }
  function persistRecents() {
    persistence = persistence.catch(() => {}).then(async () => {
      const temp = `${recentPath}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify([...recents.values()]), { flag: 'wx', mode: 0o600 });
      await rename(temp, recentPath);
    });
    return persistence;
  }
  async function opened(result: Awaited<ReturnType<typeof host.open>>, owner: number) {
    if (result.status !== 'opened') return result;
    if (closed || generation !== owner) { result.session.close(); throw new Error('Bridge closed or renderer reconnected'); }
    await remember(result.session);
    if (closed || generation !== owner || sessions.size >= 16) { result.session.close(); throw new Error('Desktop session limit reached or renderer disconnected'); }
    const id = randomUUID();
    sessions.set(id, { session: result.session, watches: new Map() });
    return { status: 'opened', session: { id, root: result.session.root, manifest: result.session.manifest, assets: result.session.assets, prefabs: result.session.prefabs } };
  }
  function requireRoot(value: unknown) {
    const root = string(value, 'root');
    if (!roots.has(root) && !destinations.has(root)) throw new Error('Folder was not selected or planned by this window');
    return root;
  }
  function closeSession(id: string) {
    const entry = sessions.get(id);
    if (!entry) return;
    for (const stop of entry.watches.values()) stop();
    entry.session.close(); sessions.delete(id);
  }
  async function close() {
    if (closed) return; closed = true; generation++;
    for (const id of sessions.keys()) closeSession(id);
    agentUnsubscribe?.(); await options.agent?.stop(); await persistence.catch(() => {});
  }
  return {
    async attachAgent(agent: RunningAgentService) {
      if (closed) { await agent.stop(); return; }
      if (options.agent) throw new Error('Agent service already attached');
      options.agent = agent;
      subscribeAgent();
      // The service starts after the renderer has loaded, so tell it to re-read provider readiness.
      options.emit({ kind: 'providers', value: null });
    },
    setAgentMessage(message: string) { options.agentMessage = message; if (!closed) options.emit({ kind: 'providers', value: null }); },
    async dispatch(input: unknown, native = false): Promise<unknown> {
      if (closed) throw new Error('Bridge closed');
      const { method, args: a } = parseRequest(input);
      const owner = generation;
      if (method === 'bridge:shutdown') return close();
      if (method === 'bridge:reset') {
        generation++;
        for (const id of sessions.keys()) closeSession(id);
        const cancellations = [...runs].map(id => options.agent?.service.cancel(id));
        earlyEvents.length = 0; destinations.clear();
        roots.clear(); for (const path of recents.keys()) roots.add(path);
        const cancelled = await Promise.allSettled(cancellations);
        if (cancelled.some(value => value.status === 'rejected')) throw new Error('Could not stop previous renderer agent runs. Close and reopen the app.');
        runs.clear();
        return null;
      }
      if (method === 'native:grant') {
        if (!native) throw new Error('Native-only command');
        if (roots.size >= 128) throw new Error('Folder grant limit reached; reopen the app');
        const root = await realpath(string(a.root, 'selected folder'));
        roots.add(root); return root;
      }
      if (method === 'agent:providers') return options.agent ? options.agent.service.refreshProviders() : [
        { id: 'codex', name: 'Codex', readiness: 'not-ready', message: options.agentMessage ?? 'No isolated, verified T3 artifact configured.', models: [], permissionModes: [] },
        { id: 'opencode', name: 'OpenCode', readiness: 'not-ready', message: options.agentMessage ?? 'No isolated, verified T3 artifact configured.', models: [], permissionModes: [] },
        { id: 'claude-code', name: 'Claude Code', readiness: 'not-ready', message: options.agentMessage ?? 'No isolated, verified T3 artifact configured.', models: [], permissionModes: [] },
      ];
      if (method.startsWith('agent:')) {
        if (!options.agent) throw new Error('No isolated, verified T3 artifact configured');
        if (method === 'agent:start') {
          const request = a.request as AgentRunRequest;
          if (!request || ![...sessions.values()].some(({ session }) => session.root === request.projectRoot)) throw new Error('Agent requires an open project session');
          string(request.threadId, 'thread id'); string(request.prompt, 'prompt');
          if (!request.context || !Array.isArray(request.context.files) || !Array.isArray(request.context.entityIds) || !Array.isArray(request.context.assetIds)) throw new Error('Invalid agent context');
          for (const values of [request.context.files, request.context.entityIds, request.context.assetIds]) {
            if (values.length > 1024) throw new Error('Agent context exceeds limit');
            for (const value of values) string(value, 'context item');
          }
          startingRuns++;
          try {
            const result = await options.agent.service.start(request);
            if (closed || generation !== owner) { await options.agent.service.cancel(result.runId); throw new Error('Agent renderer disconnected'); }
            runs.add(result.runId);
            for (const value of earlyEvents.filter(value => value.runId === result.runId)) options.emit({ kind: 'agent', value });
            return result;
          } finally { startingRuns--; if (!startingRuns) earlyEvents.length = 0; }
        }
        const runId = string(a.runId, 'run id');
        if (!runs.has(runId)) throw new Error('Run is not owned by this window');
        if (method === 'agent:answer') return options.agent.service.answer(runId, string(a.requestId, 'question id'), agentAnswersSchema.parse(a.answers));
        if (method === 'agent:cancel') return options.agent.service.cancel(runId);
        if (method === 'agent:approve' && typeof a.allow === 'boolean') return options.agent.service.approve(runId, string(a.requestId, 'approval id'), a.allow);
        throw new Error('Unsupported agent method');
      }
      if (method === 'project:recent') return Promise.all([...recents.values()].reverse().map(async recent => {
        try { await readProject(recent.path); return { ...recent, status: 'ready' }; }
        catch (error) { return { ...recent, status: (error as NodeJS.ErrnoException).code === 'NOT_FOUND' ? 'unavailable' : 'needs_attention' }; }
      }));
      if (method === 'project:forget') {
        // Removes the entry only; project files are never touched. An open project keeps its grant.
        const root = string(a.root, 'root');
        if (!recents.delete(root)) return null;
        if (![...sessions.values()].some(({ session }) => session.root === root)) roots.delete(root);
        await persistRecents();
        return null;
      }
      if (method === 'project:planChild') {
        const parent = requireRoot(a.parent), name = string(a.name, 'folder name');
        if (!/^[^<>:"/\\|?*\x00-\x1f]+$/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Choose a Windows-safe single folder name');
        const plan = await host.planCreate(join(parent, name));
        if (!plan.blockedReason) destinations.add(plan.root);
        return plan;
      }
      if (method === 'project:plan') {
        const root = string(a.root, 'root');
        // The legacy UI may form a child path; its parent must still be natively granted.
        if (!roots.has(root) && !roots.has(dirname(root))) throw new Error('Choose the destination parent first');
        const plan = await host.planCreate(root);
        if (!plan.blockedReason) destinations.add(plan.root);
        return plan;
      }
      if (method === 'project:open') return opened(await host.open(requireRoot(a.root)), owner);
      if (method === 'project:create') {
        const root = string(a.root, 'root');
        if (!destinations.delete(root)) throw new Error('Confirm a fresh creation plan first');
        return opened(await host.create(root), owner);
      }
      if (method === 'project:example') {
        const root = join(options.dataDir, 'examples', `hotel-${randomUUID()}`);
        await mkdir(dirname(root), { recursive: true });
        return opened({ status: 'opened', session: await createProject(root, 'hotel') }, owner);
      }
      const id = string(a.session, 'session id');
      const entry = sessions.get(id);
      if (!entry) throw new Error('Session is closed or belongs to another window');
      const s = entry.session;
      switch (method) {
        case 'session:close': closeSession(id); return null;
        case 'scene:read': return s.sceneIO.readScene(string(a.path, 'scene path'));
        case 'scene:save': return s.sceneIO.saveScene(a.request as SaveSceneRequest);
        case 'catalog:read': return s.readCatalog();
        case 'scripts:compile': return compileProjectScripts(s.root);
        case 'asset:read': {
          const value = await s.readAsset(string(a.assetId, 'asset id'));
          return { ...value, bytes: Buffer.from(value.bytes).toString('base64') };
        }
        case 'asset:import': {
          if (!native) throw new Error('Import requires native file selection');
          const license = string(a.license, 'license').trim();
          if (!license) throw new Error('License declaration required');
          const registry = await readAssetRegistry(s.root);
          const result = await importAsset(s.root, { sourcePath: string(a.source, 'source'), license, expectedRegistryRevision: registry.revision });
          if (result.status !== 'saved') throw new Error('Asset registry changed; retry import');
          return null;
        }
        case 'scene:watch': {
          const watch = string(a.watch, 'watch id');
          if (entry.watches.size >= 32 || entry.watches.has(watch)) throw new Error('Watch limit or duplicate id');
          entry.watches.set(watch, s.sceneIO.watchScene(string(a.path, 'scene path'), value => {
            if (!closed && sessions.has(id)) options.emit({ kind: 'scene', session: id, watch, value });
          })); return null;
        }
        case 'scene:unwatch': {
          const watch = string(a.watch, 'watch id'); entry.watches.get(watch)?.(); entry.watches.delete(watch); return null;
        }
        default: throw new Error('Unsupported desktop method');
      }
    },
    close,
  };
}
