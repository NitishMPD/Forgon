import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AgentEvent, AgentRunRequest, AssetRecord, PermissionMode, ProviderId, SceneDocument } from '@forgon/project-schema';
import type { AgentConnection, AgentProviderInfo } from '../services.js';
import type { LogInput } from '../model/consoleLog.js';
import { buildContext, sendBlockers, type ContextChip } from './composerModel.js';
import { defaultPermissionMode } from './permissions.js';
import { agentReducer, newThread, type AgentState, type AgentThread, type PendingRequest } from './threadState.js';

export interface AgentController {
  connection: AgentConnection;
  state: AgentState;
  activeThread: AgentThread | null;
  activeProvider: AgentProviderInfo | null;
  draft: string;
  setDraft(text: string): void;
  chips: readonly ContextChip[];
  addChip(chip: ContextChip): void;
  removeChip(id: string): void;
  blockers: readonly string[];
  canSend: boolean;
  send(): void;
  cancel(): void;
  approve(threadId: string, runId: string, requestId: string, allow: boolean): void;
  newThread(): void;
  selectThread(threadId: string): void;
  setProvider(provider: ProviderId): void;
  setModel(model: string | null): void;
  setPermissionMode(mode: PermissionMode): void;
  refreshProviders?: (() => Promise<void>) | undefined;
}

export interface AgentSessionInput {
  connection: AgentConnection | null;
  projectRoot: string | null;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  onLog(entry: LogInput): void;
}

const emptyState: AgentState = { threads: [], activeThreadId: null };

function localId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultProvider(providers: readonly AgentProviderInfo[]): AgentProviderInfo | null {
  return providers.find(provider => provider.readiness !== 'not-ready') ?? providers[0] ?? null;
}

// Owns thread state for the agent dock. Events from the service are folded into transcripts;
// nothing here approves writes on its own. Approvals are sent only after an explicit click.
export function useAgentSessions(input: AgentSessionInput): AgentController | null {
  const { connection: originalConnection, projectRoot, scene, assets, onLog } = input;
  const [providerSnapshot, setProviderSnapshot] = useState<{ owner: AgentConnection; providers: readonly AgentProviderInfo[] } | null>(null);
  const connection = useMemo(() => originalConnection && providerSnapshot?.owner === originalConnection
    ? { ...originalConnection, providers: providerSnapshot.providers } : originalConnection, [originalConnection, providerSnapshot]);
  const refreshProviders = originalConnection?.refreshProviders ? async (): Promise<void> => {
    const providers = await originalConnection.refreshProviders!();
    setProviderSnapshot({ owner: originalConnection, providers });
  } : undefined;
  const [state, dispatch] = useReducer(agentReducer, emptyState);
  const [draft, setDraft] = useState('');
  const [chips, setChips] = useState<ContextChip[]>([]);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  const activeThread = state.threads.find(thread => thread.id === state.activeThreadId) ?? null;
  const activeProvider = connection?.providers.find(provider => provider.id === activeThread?.provider) ?? null;

  useEffect(() => {
    if (!connection) return;
    return connection.service.subscribe((event: AgentEvent) => {
      dispatch({ type: 'event', event });
      if (event.type === 'diagnostic') {
        onLogRef.current({ source: 'agent', severity: 'warning', message: event.diagnostic.message, file: event.diagnostic.path });
      }
      if (event.type === 'completed' && event.outcome === 'failed') {
        onLogRef.current({ source: 'agent', severity: 'error', message: event.message ?? 'Agent run failed.' });
      }
    });
  }, [connection]);

  useEffect(() => {
    if (!connection || state.threads.length > 0) return;
    const provider = defaultProvider(connection.providers);
    if (!provider) return;
    dispatch({ type: 'thread/ensure', thread: newThread(localId('thread'), provider.id, defaultPermissionMode(provider.permissionModes), null) });
  }, [connection, state.threads.length]);

  const start = useCallback((threadId: string, request: PendingRequest, fromQueue: boolean) => {
    if (!connection || projectRoot === null) return;
    dispatch({ type: 'run/requested', threadId, request, fromQueue });
    const runRequest: AgentRunRequest = {
      threadId,
      provider: request.provider,
      prompt: request.text,
      projectRoot,
      permissionMode: request.permissionMode,
      context: request.context,
      ...(request.model !== null ? { model: request.model } : {}),
    };
    Promise.resolve()
      .then(() => connection.service.start(runRequest))
      .then(
        ({ runId }) => dispatch({ type: 'run/started', threadId, runId }),
        (error: unknown) => {
          const message = errorMessage(error);
          dispatch({ type: 'run/failed', threadId, requestId: request.id, message });
          onLogRef.current({ source: 'agent', severity: 'error', message: `Could not start agent run: ${message}` });
        },
      );
  }, [connection, projectRoot]);

  // Queued prompts start one at a time once the thread is idle.
  useEffect(() => {
    if (!activeThread || activeThread.starting || activeThread.activeRunId !== null) return;
    const next = activeThread.queue[0];
    if (next) start(activeThread.id, next, true);
  }, [activeThread, start]);

  const blockers = connection === null
    ? ['Agent service is not connected.']
    : sendBlockers({
        projectOpen: projectRoot !== null,
        provider: activeProvider,
        permissionMode: activeThread?.permissionMode ?? null,
        chips,
        scene,
        assets,
      });
  const canSend = blockers.length === 0 && draft.trim() !== '' && activeThread !== null;

  const send = useCallback(() => {
    const mode = activeThread?.permissionMode ?? null;
    if (!connection || !activeThread || !canSend || mode === null) return;
    const request: PendingRequest = {
      id: localId('request'),
      text: draft.trim(),
      provider: activeThread.provider,
      model: activeThread.model,
      permissionMode: mode,
      context: buildContext(chips),
    };
    setDraft('');
    setChips([]);
    if (activeThread.starting || activeThread.activeRunId !== null) {
      dispatch({ type: 'queue/add', threadId: activeThread.id, request });
    } else {
      start(activeThread.id, request, false);
    }
  }, [connection, activeThread, canSend, draft, chips, start]);

  const cancel = useCallback(() => {
    const runId = activeThread?.activeRunId;
    if (!connection || !runId) return;
    connection.service.cancel(runId).catch((error: unknown) => {
      onLogRef.current({ source: 'agent', severity: 'error', message: `Cancel failed: ${errorMessage(error)}` });
    });
  }, [connection, activeThread]);

  // One answer per request. A second click while the first is in flight is ignored.
  const answering = useRef(new Set<string>());
  const approve = useCallback((threadId: string, runId: string, requestId: string, allow: boolean) => {
    if (!connection || answering.current.has(requestId)) return;
    answering.current.add(requestId);
    connection.service.approve(runId, requestId, allow).then(
      () => dispatch({ type: 'approval/answered', threadId, runId, requestId, allow }),
      (error: unknown) => onLogRef.current({ source: 'agent', severity: 'error', message: `Approval failed: ${errorMessage(error)}` }),
    ).finally(() => {
      answering.current.delete(requestId);
    });
  }, [connection]);

  const newThreadAction = useCallback(() => {
    if (!connection) return;
    const provider = connection.providers.find(item => item.id === activeThread?.provider) ?? defaultProvider(connection.providers);
    if (!provider) return;
    dispatch({ type: 'thread/add', thread: newThread(localId('thread'), provider.id, defaultPermissionMode(provider.permissionModes), null) });
  }, [connection, activeThread]);

  const setProvider = useCallback((provider: ProviderId) => {
    if (!activeThread || !connection) return;
    const info = connection.providers.find(item => item.id === provider);
    const current = activeThread.permissionMode;
    const keepMode = current !== null && (info?.permissionModes.includes(current) ?? false);
    dispatch({
      type: 'thread/settings',
      threadId: activeThread.id,
      provider,
      model: null,
      permissionMode: keepMode ? current : defaultPermissionMode(info?.permissionModes ?? []),
    });
  }, [activeThread, connection]);

  const setModel = useCallback((model: string | null) => {
    if (activeThread) dispatch({ type: 'thread/settings', threadId: activeThread.id, model });
  }, [activeThread]);

  const setPermissionMode = useCallback((permissionMode: PermissionMode) => {
    if (activeThread) dispatch({ type: 'thread/settings', threadId: activeThread.id, permissionMode });
  }, [activeThread]);

  const addChip = useCallback((chip: ContextChip) => {
    setChips(current => (current.some(item => item.kind === chip.kind && item.ref === chip.ref) ? current : [...current, chip]));
  }, []);

  const removeChip = useCallback((id: string) => {
    setChips(current => current.filter(item => item.id !== id));
  }, []);

  if (!connection) return null;
  return {
    connection,
    refreshProviders,
    state,
    activeThread,
    activeProvider,
    draft,
    setDraft,
    chips,
    addChip,
    removeChip,
    blockers,
    canSend,
    send,
    cancel,
    approve,
    newThread: newThreadAction,
    selectThread: threadId => dispatch({ type: 'thread/select', threadId }),
    setProvider,
    setModel,
    setPermissionMode,
  };
}
