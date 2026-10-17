import type { ScriptCatalog, AgentEvent, AgentRunRequest, AssetRecord, PrefabDocument, ProjectManifest, SceneRead, SceneWatchEvent, SaveSceneRequest, SaveSceneResult } from '@forgon/project-schema';
import type { BridgeEvent, Transport } from './protocol.js';
import type { RunningAgentService } from '@forgon/agent-service';
type AgentProviderInfo = RunningAgentService['agentConnection']['providers'][number];

interface SessionData { id: string; root: string; manifest: ProjectManifest; assets: AssetRecord[]; prefabs: PrefabDocument[] }
type OpenData = { status: 'opened'; session: SessionData } | { status: 'failed'; reason: 'not-project' | 'invalid' | 'unreadable'; message: string; diagnostics: { path: string; message: string }[] };

/** Browser-safe public factory. No Node imports or project paths become filesystem capabilities. */
export async function createDesktopServices(transport: Transport) {
  // Reload/reconnect releases watches and sessions owned by the previous renderer generation.
  await transport.request('bridge:reset');
  const listeners = new Set<(event: AgentEvent) => void>();
  const sessions = new Map<string, () => void>();
  let disconnected = false;
  const stop = transport.subscribe(event => {
    if (event.kind === 'agent') for (const listener of listeners) listener(event.value as AgentEvent);
    if (event.kind === 'closed') {
      disconnected = true;
      for (const close of sessions.values()) close();
    }
  });
  async function open(method: string, args?: Record<string, unknown>) {
    const value = await transport.request<OpenData>(method, args);
    if (value.status !== 'opened') return value;
    const data = value.session;
    let closed = false;
    const watchers = new Map<string, (event: SceneWatchEvent) => void>();
    const off = transport.subscribe(event => {
      if (!closed && event.kind === 'scene' && event.session === data.id && event.watch) watchers.get(event.watch)?.(event.value as SceneWatchEvent);
    });
    function request<T>(name: string, a: Record<string, unknown> = {}) {
      if (closed || disconnected) return Promise.reject(new Error('Desktop project session is closed'));
      return transport.request<T>(name, { ...a, session: data.id });
    }
    function close() {
      if (closed) return; closed = true; watchers.clear(); off(); sessions.delete(data.id);
      if (!disconnected) void transport.request('session:close', { session: data.id }).catch(() => {});
    }
    sessions.set(data.id, close);
    return { status: 'opened' as const, session: {
      root: data.root, manifest: data.manifest, assets: data.assets, prefabs: data.prefabs,
      sceneIO: {
        readScene: (path: string) => request<SceneRead>('scene:read', { path }),
        saveScene: (value: SaveSceneRequest) => request<SaveSceneResult>('scene:save', { request: value }),
        watchScene(path: string, listener: (event: SceneWatchEvent) => void) {
          const watch = crypto.randomUUID(); let active = true;
          watchers.set(watch, listener);
          // Keep registration/removal ordered even when unsubscribe happens before the RPC resolves.
          const registered = request('scene:watch', { path, watch });
          void registered.catch(error => {
            if (active && !closed) listener({ type: 'invalid', diagnostics: [{ path, message: String(error) }] });
          });
          return () => {
            if (!active) return; active = false; watchers.delete(watch);
            void registered.then(() => closed ? undefined : request('scene:unwatch', { watch })).catch(() => {});
          };
        },
      },
      compileScripts: () => request<ScriptCatalog>('scripts:compile'),
      readCatalog: () => request<{ manifest: ProjectManifest; assets: { assets: AssetRecord[] }; prefabs: PrefabDocument[] }>('catalog:read'),
      async readAsset(assetId: string) {
        const value = await request<{ asset: AssetRecord; bytes: string; revision: string }>('asset:read', { assetId });
        const binary = atob(value.bytes);
        return { ...value, bytes: Uint8Array.from(binary, c => c.charCodeAt(0)) };
      },
      importAsset: (license: string) => request<void>('asset:import', { license }),
      close,
    } };
  }
  const refreshProviders = () => transport.request<readonly AgentProviderInfo[]>('agent:providers');
  const service = {
    start: (request: AgentRunRequest) => transport.request<{ runId: string }>('agent:start', { request }),
    cancel: (runId: string) => transport.request<void>('agent:cancel', { runId }),
    approve: (runId: string, requestId: string, allow: boolean) => transport.request<void>('agent:approve', { runId, requestId, allow }),
    subscribe(listener: (event: AgentEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    project: {
      pickFolder: () => transport.request<string | null>('project:pick'),
      listRecent: () => transport.request<{ path: string; name: string; lastOpened: string; status: 'ready' | 'needs_attention' | 'unavailable' }[]>('project:recent'),
      forgetRecent: async (root: string) => { await transport.request<null>('project:forget', { root }); },
      planCreate: (root: string) => transport.request<{ root: string; files: string[]; blockedReason?: string }>('project:plan', { root }),
      planCreateChild: (parent: string, name: string) => transport.request<{ root: string; files: string[]; blockedReason?: string }>('project:planChild', { parent, name }),
      open: (root: string) => open('project:open', { root }),
      create: (root: string) => open('project:create', { root }),
      openExample: () => open('project:example'),
    },
    agent: { service, providers: await refreshProviders(), refreshProviders },
    dispose() { for (const close of sessions.values()) close(); listeners.clear(); stop(); },
  };
}

/** Load native APIs only inside Tauri; ordinary browser sample mode needs no desktop runtime. */
export async function connectDesktop() {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const listeners = new Set<(event: BridgeEvent) => void>();
  const off = await listen<BridgeEvent>('forgon:desktop', event => { for (const listener of listeners) listener(event.payload); });
  const offClose = await getCurrentWindow().onCloseRequested(async event => {
    const guard = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guard);
    if (guard.defaultPrevented) {
      event.preventDefault();
      await invoke('desktop_close_blocked');
    }
  });
  try {
    const services = await createDesktopServices({
      request: async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
        try { return await invoke<T>('desktop_request', { method, args }); }
        catch (error) {
          const failure = error as { message?: unknown; code?: unknown } | null;
          throw Object.assign(new Error(typeof failure?.message === 'string' ? failure.message : String(error)), {
            code: typeof failure?.code === 'string' ? failure.code : 'DESKTOP_ERROR',
          });
        }
      },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    });
    return { ...services, dispose() { services.dispose(); off(); offClose(); } };
  } catch (error) { off(); offClose(); throw error; }
}

export function isDesktop(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; }

export type { Transport } from './protocol.js';
