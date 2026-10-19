import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AgentEvent, AgentRunRequest, AssetRecord, PermissionMode, ProviderId, SceneDocument } from '@forgon/project-schema';
import type { AgentConnection, AgentProviderInfo } from '../services.js';
import type { LogInput } from '../model/consoleLog.js';
import { readPreferences, rememberModel, rememberPermission, saveProgressiveDesign, type Preferences } from '../model/preferences.js';
import { buildContext, sendBlockers, progressiveDesignPrompt, type ContextChip } from './composerModel.js';
import { reasoningOptions, supportedModelOptions } from './modelPickerModel.js';
import { defaultPermissionMode } from './permissions.js';
import { agentReducer, canChangeProvider, newThread, type AgentAction, type AgentState, type AgentThread, type PendingRequest } from './threadState.js';

export interface AgentController {
  connection: AgentConnection;
  state: AgentState;
  activeThread: AgentThread | null;
  activeProvider: AgentProviderInfo | null;
  progressiveDesign: boolean;
  setProgressiveDesign(enabled: boolean): void;
  progressivePromptId: string | null;
  progressiveBuilding: boolean;
  draft: string;
  setDraft(text: string): void;
  chips: readonly ContextChip[];
  addChip(chip: ContextChip): void;
  removeChip(id: string): void;
  blockers: readonly string[];
  canSend: boolean;
  send(): void;
  cancel(): void;
  answer(threadId: string, runId: string, requestId: string, answers: import('@forgon/project-schema').AgentAnswers): Promise<void>;
  approve(threadId: string, runId: string, requestId: string, allow: boolean): void;
  newThread(): void;
  selectThread(threadId: string): void;
  setProvider(provider: ProviderId): void;
  setModel(model: string | null, provider?: ProviderId): void;
  setModelOption(id: string, value: string | null): void;
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
  return providers.find(provider => provider.readiness !== 'not-ready' && provider.models.length > 0) ?? null;
}

export function defaultAgentThread(id: string, providers: readonly AgentProviderInfo[], preferences: Preferences = readPreferences()): AgentThread | null {
  const choice = preferences.lastModel;
  const remembered = choice && providers.find(provider => provider.id === choice.provider && provider.readiness !== 'not-ready' && provider.models.length > 0);
  const provider = remembered || defaultProvider(providers);
  if (!provider) return null;
  const model = remembered && choice?.model === null ? null
    : remembered && choice?.model && provider.models.includes(choice.model) ? choice.model : provider.defaultModel ?? null;
  const savedMode = preferences.permissionModes?.[provider.id];
  const permissionMode = savedMode && provider.permissionModes.includes(savedMode) ? savedMode : defaultPermissionMode(provider.permissionModes);
  return { ...newThread(id, provider.id, permissionMode, model), modelOptions: supportedModelOptions(provider, model, remembered ? choice?.options : []) };
}

export function modelSelectionAction(thread: AgentThread, providers: readonly AgentProviderInfo[], model: string | null, provider: ProviderId = thread.provider): AgentAction | null {
  if (thread.starting || (provider !== thread.provider && !canChangeProvider(thread))) return null;
  const info = providers.find(item => item.id === provider);
  if (!info || (model !== null && !info.models.includes(model))) return null;
  const saved = readPreferences().permissionModes?.[provider];
  const current = provider === thread.provider ? thread.permissionMode : saved ?? null;
  return { type: 'thread/settings', threadId: thread.id, provider, model,
    permissionMode: current !== null && info.permissionModes.includes(current) ? current : defaultPermissionMode(info.permissionModes),
    modelOptions: model === thread.model && provider === thread.provider ? supportedModelOptions(info, model, thread.modelOptions) : [] };
}

export function restoreAgentSettingsAction(thread: AgentThread, providers: readonly AgentProviderInfo[], preferences: Preferences = readPreferences()): AgentAction | null {
  if (thread.settingsTouched || !canChangeProvider(thread)) return null;
  const restored = defaultAgentThread(thread.id, providers, preferences);
  if (!restored || (restored.provider === thread.provider && restored.model === thread.model && restored.permissionMode === thread.permissionMode && JSON.stringify(restored.modelOptions) === JSON.stringify(thread.modelOptions))) return null;
  return { type: 'thread/settings', threadId: thread.id, restoring: true, provider: restored.provider, model: restored.model,
    permissionMode: restored.permissionMode, modelOptions: restored.modelOptions ?? [] };
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
  useEffect(() => {
    if (!originalConnection?.onProvidersChanged) return undefined;
    const reread = (): void => {
      void originalConnection.refreshProviders?.()
        .then(providers => setProviderSnapshot({ owner: originalConnection, providers }))
        .catch(() => undefined);
    };
    // The service may finish starting while no editor is mounted (e.g. on the launcher), so re-read on mount too.
    reread();
    return originalConnection.onProvidersChanged(reread);
  }, [originalConnection]);
  const [state, dispatch] = useReducer(agentReducer, emptyState);
  const [progressiveDesign, setProgressive] = useState(() => readPreferences().progressiveDesign ?? false);
  const [progressivePrompt, setProgressivePrompt] = useState<{ id: string; threadId: string } | null>(null);
  const setProgressiveDesign = useCallback((enabled: boolean) => { setProgressive(enabled); saveProgressiveDesign(enabled); }, []);
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
    const thread = defaultAgentThread(localId('thread'), connection.providers);
    if (thread) dispatch({ type: 'thread/ensure', thread });
  }, [connection, state.threads.length]);

  useEffect(() => {
    if (!connection || !activeThread) return;
    const action = restoreAgentSettingsAction(activeThread, connection.providers);
    if (action) dispatch(action);
  }, [connection, activeThread]);

  const start = useCallback((threadId: string, request: PendingRequest, fromQueue: boolean) => {
    if (!connection || projectRoot === null) return;
    setProgressivePrompt({ id: request.id, threadId });
    dispatch({ type: 'run/requested', threadId, request, fromQueue });
    const runRequest: AgentRunRequest = {
      threadId,
      provider: request.provider,
      prompt: progressiveDesignPrompt(request.text, request.progressiveDesign ?? false),
      projectRoot,
      permissionMode: request.permissionMode,
      context: request.context,
      ...(request.modelOptions?.length ? { modelOptions: request.modelOptions } : {}),
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
      progressiveDesign,
      text: draft.trim(),
      provider: activeThread.provider,
      model: activeThread.model,
      modelOptions: [...(activeThread.modelOptions ?? [])],
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
  }, [connection, activeThread, canSend, draft, chips, start, progressiveDesign]);

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

  const answer = useCallback(async (threadId: string, runId: string, requestId: string, answers: import('@forgon/project-schema').AgentAnswers) => {
    if (!connection || answering.current.has(requestId)) return;
    answering.current.add(requestId);
    try {
      await connection.service.answer(runId, requestId, answers);
      dispatch({ type: 'input/answered', threadId, runId, requestId });
    } finally { answering.current.delete(requestId); }
  }, [connection]);

  const newThreadAction = useCallback(() => {
    if (!connection) return;
    const thread = defaultAgentThread(localId('thread'), connection.providers);
    if (thread) dispatch({ type: 'thread/add', thread });
  }, [connection]);

  const setModel = useCallback((model: string | null, provider?: ProviderId) => {
    if (!activeThread || !connection) return;
    const action = modelSelectionAction(activeThread, connection.providers, model, provider);
    if (action) {
      dispatch(action);
      rememberModel({ provider: provider ?? activeThread.provider, model, ...(action.type === 'thread/settings' && action.modelOptions?.length ? { options: action.modelOptions } : {}) });
    }
  }, [activeThread, connection]);

  const setProvider = useCallback((provider: ProviderId) => setModel(null, provider), [setModel]);

  const setPermissionMode = useCallback((permissionMode: PermissionMode) => {
    if (!activeThread || activeThread.starting || !activeProvider?.permissionModes.includes(permissionMode)) return;
    dispatch({ type: 'thread/settings', threadId: activeThread.id, permissionMode });
    rememberPermission(activeThread.provider, permissionMode);
  }, [activeThread, activeProvider]);

  const setModelOption = useCallback((id: string, value: string | null) => {
    if (!activeThread || activeThread.starting) return;
    const descriptor = reasoningOptions(activeProvider, activeThread.model).find(option => option.id === id);
    if (!descriptor || (value !== null && !descriptor.options.some(option => option.id === value))) return;
    const modelOptions = [...(activeThread.modelOptions ?? []).filter(option => option.id !== id), ...(value === null ? [] : [{ id, value }])];
    dispatch({ type: 'thread/settings', threadId: activeThread.id, modelOptions });
    rememberModel({ provider: activeThread.provider, model: activeThread.model, ...(modelOptions.length ? { options: modelOptions } : {}) });
  }, [activeThread, activeProvider]);

  const addChip = useCallback((chip: ContextChip) => {
    setChips(current => (current.some(item => item.kind === chip.kind && item.ref === chip.ref) ? current : [...current, chip]));
  }, []);

  const removeChip = useCallback((id: string) => {
    setChips(current => current.filter(item => item.id !== id));
  }, []);

  if (!connection) return null;
  return {
    connection,
    progressiveDesign,
    setProgressiveDesign,
    progressivePromptId: progressivePrompt?.id ?? null,
    progressiveBuilding: state.threads.some(thread => thread.id === progressivePrompt?.threadId && (thread.starting || thread.activeRunId !== null)),
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
    answer,
    newThread: newThreadAction,
    selectThread: threadId => dispatch({ type: 'thread/select', threadId }),
    setProvider,
    setModel,
    setPermissionMode,
    setModelOption,
  };
}
