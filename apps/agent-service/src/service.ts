/**
 * Forgon `AgentService` over a live T3 connection.
 *
 * This is the one callable interface the desktop worker consumes: it owns provider/model
 * discovery, project resolution, run tracking, event mapping, reattach, diffs and the
 * approval/cancellation/control commands, and nothing else. The sidecar manager owns the process;
 * the bridge owns the wire.
 *
 * Design rules carried from the contract and build brief:
 *  - A run's Forgon `runId` is the T3 run id, and `sequence` is per-run monotonic (see
 *    `ThreadEventMapper`). T3's own stream sequence is per-thread and is used only as a cursor.
 *  - An approval is answered only for a request this session actually received and that is still
 *    pending (`consumeApproval`); a stale or guessed id is refused rather than forwarded.
 *  - Unsupported controls are reported, never simulated: `inspect` refuses at the permission map,
 *    a provider that reports no models is unavailable rather than given a fabricated default, and
 *    a control the adapter says it cannot take (`requiresNewThreadForModelChange`, a runtime mode
 *    it does not list) is refused with `unsupported_control`.
 *  - No secrets reach an event or the persisted refs; the access token stays inside the
 *    connection closure and the bootstrap token is passed to `connectT3` only.
 */
import path from 'node:path';
import { withSceneInstructions } from './sceneInstructions.js';
import type {
  AgentEvent,
  AgentRunRequest,
  AgentService,
  PermissionMode,
  ProviderId,
} from '@forgon/project-schema';
import {
  AgentBridgeError,
  ThreadEventMapper,
  selectModelOptionSchema,
  approvalDecisionFor,
  approvalNotPending,
  availableForgonProviders,
  buildLaunchThreadInput,
  buildMessageDispatch,
  FORGON_CREATION,
  buildMessageContext,
  buildProviderSwitch,
  buildRunInterrupt,
  buildRuntimeRequestRespond,
  buildThreadInteractionModeSet,
  buildThreadModelSelectionSet,
  buildThreadRuntimeModeSet,
  createAgentConnection,
  defaultIdFactory,
  enforceablePermissionModes,
  forgonProviderForDriver,
  mapPermissionMode,
  parseDiffPaths,
  permissionModesForConnection,
  redactSecrets,
  resolveProviderRoute,
  runNotFound,
  unsupportedControl,
  type AgentConnection,
  type AgentProviderInfo,
  type IdFactory,
  type T3Connection,
  type T3Run,
  type T3ServerProvider,
  type T3ThreadProjection,
} from '@forgon/agent-bridge';
import type { ThreadRef, ThreadRefStore } from './persistence.js';

/** Where a reattach landed: whether the thread existed and which run is now being tracked. */
export interface ResumeResult {
  readonly threadId: string;
  /** True when the thread already existed on the server; false when it had to be relaunched. */
  readonly resumed: boolean;
  readonly runId?: string;
}

/** A best-effort reattach outcome, one per persisted thread. */
export interface ResumeOutcome {
  readonly threadId: string;
  readonly resumed: boolean;
  readonly runId?: string;
  /** Present when reattach failed; the thread is reported, never silently dropped. */
  readonly error?: string;
}

export interface TurnDiffRequest {
  readonly threadId: string;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly ignoreWhitespace?: boolean;
}

export interface FullThreadDiffRequest {
  readonly threadId: string;
  readonly toTurnCount: number;
  readonly ignoreWhitespace?: boolean;
}

/** The diff T3 returned, plus the paths the bridge parsed out of it. */
export interface TurnDiffResult {
  readonly threadId: string;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly paths: readonly string[];
  readonly diff: string;
}

export interface SetModelRequest {
  readonly threadId: string;
  readonly model: string;
}

export interface SetRuntimeModeRequest {
  readonly threadId: string;
  readonly permissionMode: PermissionMode;
}

export interface SetInteractionModeRequest {
  readonly threadId: string;
  readonly interactionMode: 'default' | 'plan';
}

export interface SwitchProviderRequest {
  readonly threadId: string;
  readonly provider: ProviderId;
  readonly model?: string;
}

export interface AgentServiceFacade extends AgentService {
  /** Providers Forgon can actually route to right now (driver present, enabled, installed). */
  availableProviders(): Promise<readonly ProviderId[]>;
  /** Discovery for capabilities-driven UI: readiness, models, enforceable modes, reported limits. */
  listProviders(): Promise<readonly AgentProviderInfo[]>;
  /** Force a fresh `server.refreshProviders` and return the refreshed capability snapshot. */
  refreshProviders(): Promise<readonly AgentProviderInfo[]>;
  /** Browser-safe connection wrapper for the renderer (plain data + the service methods). */
  connection(): AgentConnection;
  /** Persisted refs, oldest first; survives a restart of this facade. */
  threadRefs(): Promise<readonly ThreadRef[]>;

  /**
   * Reattach a durable thread by id: read its projection, seed a mapper from it, and resume the
   * live stream from the projection's sequence. Idempotent: a thread already streaming is not
   * subscribed twice.
   */
  resumeThread(threadId: string): Promise<ResumeResult>;
  /** Reattach every thread named by a persisted ref (latest ref per thread). Best-effort. */
  reattachPersistedThreads(): Promise<readonly ResumeOutcome[]>;

  /** Fetch `orchestration.getTurnDiff` for a run's turn range and emit it as a real `diff` event. */
  turnDiff(request: TurnDiffRequest): Promise<TurnDiffResult>;
  /** Fetch `orchestration.getFullThreadDiff` and emit it as a real `diff` event. */
  fullThreadDiff(request: FullThreadDiffRequest): Promise<TurnDiffResult>;

  /** Switch the model on a live thread, refusing when the adapter needs a new thread first. */
  setModel(request: SetModelRequest): Promise<void>;
  /** Change the live runtime mode (mapped from a Forgon permission mode). */
  setRuntimeMode(request: SetRuntimeModeRequest): Promise<void>;
  /** Toggle `default`/`plan` interaction mode. */
  setInteractionMode(request: SetInteractionModeRequest): Promise<void>;
  /** Move a live thread to another provider instance. */
  switchProvider(request: SwitchProviderRequest): Promise<void>;
  /** Runtime modes this connection can actually enforce for a provider right now. */
  permissionModesFor(provider: ProviderId): Promise<readonly PermissionMode[]>;
  /** Known provider instance id for a thread, if any discovery or ref names one. */
  instanceIdForThread(threadId: string): string | undefined;

  close(): void;
}

interface TrackedRun {
  readonly threadId: string;
  readonly provider: ProviderId;
}

export interface AgentServiceOptions {
  readonly connection: T3Connection;
  /** Persisted thread/run references. Required: a session that cannot be reattached is not a session. */
  readonly store: ThreadRefStore;
  readonly now?: () => string;
  readonly idFactory?: IdFactory;
  /** Set only when Forgon enforces `inspect` with a read-only agent surface. */
  readonly forgonEnforcesInspect?: boolean;
  readonly titleFor?: (request: AgentRunRequest) => string;
  readonly onWarning?: (message: string) => void;
  /**
   * When a `start` names a thread that already has a persisted ref, reuse that durable T3 thread
   * instead of asking the server to create a second one with the same id. Defaults to true.
   */
  readonly reuseExistingThread?: boolean;
}

const normalizeRoot = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const deriveTitle = (request: AgentRunRequest): string => {
  const firstLine = request.prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const title = firstLine.length === 0 ? 'Forgon agent run' : firstLine;
  return title.slice(0, 120);
};

const newestRun = (projection: T3ThreadProjection): T3Run | undefined => {
  let newest: T3Run | undefined;
  for (const run of projection.runs) {
    if (newest === undefined || run.ordinal > newest.ordinal) newest = run;
  }
  return newest;
};

export const createAgentService = async (
  options: AgentServiceOptions,
): Promise<AgentServiceFacade> => {
  const { connection } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory;
  const titleFor = options.titleFor ?? deriveTitle;
  const store = options.store;
  await store.load();

  const listeners = new Set<(event: AgentEvent) => void>();
  /** One mapper per thread; several runs share it, which is what makes reattach non-duplicating. */
  const threadMappers = new Map<string, ThreadEventMapper>();
  const runs = new Map<string, TrackedRun>();
  /** Instance id per thread, learned from refs or discovery; the model-selection routing key. */
  const instanceIdByThread = new Map<string, string>();
  let providers: readonly T3ServerProvider[] | undefined;
  let projectIdByRoot = new Map<string, string>();

  const emit = (event: AgentEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (cause) {
        options.onWarning?.(`Agent event listener threw: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  };

  const ensureProviders = async (): Promise<readonly T3ServerProvider[]> => {
    if (providers === undefined) providers = await connection.orchestration.refreshProviders();
    return providers;
  };

  const providerFor = (id: ProviderId): T3ServerProvider | undefined => {
    const driver = id === 'claude-code' ? 'claudeAgent' : id;
    return (providers ?? []).find((candidate) => candidate.driver === driver);
  };

  const providerForInstanceId = (instanceId: string): ProviderId | undefined => {
    const found = (providers ?? []).find((candidate) => candidate.instanceId === instanceId);
    return found === undefined ? undefined : forgonProviderForDriver(found.driver);
  };

  /**
   * Reported limits, in plain words, only when the adapter says something specific. An adapter
   * that reports nothing yields no limits rather than a reassurance it did not make.
   */
  const limitsFor = (provider: T3ServerProvider): readonly string[] => {
    const limits: string[] = [];
    if (provider.reportsContextWindow === false) limits.push('Context window not reported by the provider.');
    if (provider.supportsConversationRollback === false) {
      limits.push('Conversation rollback is not supported by this provider.');
    }
    if (provider.requiresNewThreadForModelChange === true) {
      limits.push('Changing the model requires a new thread.');
    }
    const usage = provider.usageLimits;
    if (usage !== undefined) {
      if (usage.unavailable?.reason === 'unsupported') {
        limits.push('Usage limits are not reported for this provider.');
      } else if (usage.unavailable?.reason === 'probeFailed') {
        limits.push('Usage limits could not be read from the provider right now.');
      } else {
        for (const window of usage.windows) {
          const reset = window.resetsAt === undefined ? '' : ` (resets ${window.resetsAt})`;
          limits.push(`${window.label}: ${Math.round(window.usedPercent)}% used${reset}.`);
        }
      }
    }
    return limits;
  };

  const connectionModes = (): readonly PermissionMode[] =>
    permissionModesForConnection({
      ...(options.forgonEnforcesInspect === undefined
        ? {}
        : { forgonEnforcesInspect: options.forgonEnforcesInspect }),
    });

  const modesForProvider = (provider: T3ServerProvider): readonly PermissionMode[] =>
    enforceablePermissionModes({ discovered: provider, connectionModes: connectionModes() });

  const toProviderInfo = (provider: T3ServerProvider, forgonId: ProviderId): AgentProviderInfo => {
    const available = provider.enabled && provider.installed && provider.availability !== 'unavailable';
    const authStatus = provider.auth?.status;
    let readiness: AgentProviderInfo['readiness'];
    let message: string | undefined;
    if (!available) {
      readiness = 'not-ready';
      message = provider.unavailableReason ?? provider.message ?? provider.availability ?? 'Unavailable.';
    } else if (authStatus === 'unauthenticated') {
      readiness = 'not-ready';
      message = `Sign in to ${provider.displayName ?? forgonId} to use it.`;
    } else if (authStatus === 'unknown') {
      readiness = 'unknown';
      message = 'Authentication state could not be determined.';
    } else {
      readiness = 'ready';
    }
    const models = (provider.models ?? []).map((model) => model.slug);
    if (readiness === 'ready' && models.length === 0) {
      readiness = 'not-ready';
      message = 'The provider reported no models to run.';
    }
    const limits = [...limitsFor(provider)];
    const permissionModes = modesForProvider(provider);
    // A provider that lists runtime modes Forgon can none of is a specific, reportable limit.
    if (
      provider.supportedRuntimeModes !== undefined &&
      permissionModes.every((mode) => mode === 'inspect')
    ) {
      limits.push('The provider reports no runtime mode Forgon can enforce.');
    }
    return {
      id: forgonId,
      name: provider.displayName ?? forgonId,
      readiness,
      ...(message === undefined ? {} : { message }),
      models,
      ...(models.length ? { defaultModel: defaultModelFor(forgonId) } : {}),
      modelOptions: Object.fromEntries((provider.models ?? []).map(model => [model.slug,
        (model.capabilities?.optionDescriptors ?? []).flatMap(descriptor => {
          const parsed = selectModelOptionSchema.safeParse(descriptor);
          return parsed.success ? [parsed.data] : [];
        }),
      ])),
      permissionModes,
      ...(limits.length === 0 ? {} : { limits }),
    };
  };

  const buildProviderInfo = async (
    discovered: readonly T3ServerProvider[],
  ): Promise<readonly AgentProviderInfo[]> => {
    const info: AgentProviderInfo[] = [];
    for (const provider of discovered) {
      const forgonId = forgonProviderForDriver(provider.driver);
      if (forgonId === undefined) continue;
      info.push(toProviderInfo(provider, forgonId));
    }
    return info;
  };

  const defaultModelFor = (id: ProviderId): string => {
    const provider = providerFor(id);
    const models = provider?.models ?? [];
    const chosen = models.find((model) => model.isDefault === true) ?? models[0];
    if (chosen === undefined) {
      throw new AgentBridgeError(
        'unsupported_provider',
        `Provider "${id}" reports no models; refusing to fabricate a default model. Pass an explicit model or install the provider CLI.`,
        { detail: provider === undefined ? 'provider not discovered' : 'provider reported zero models' },
      );
    }
    return chosen.slug;
  };

  const ensureProject = async (projectRoot: string): Promise<string> => {
    const key = normalizeRoot(projectRoot);
    const cached = projectIdByRoot.get(key);
    if (cached !== undefined) return cached;
    const snapshot = await connection.projects.snapshot();
    projectIdByRoot = new Map(snapshot.map((project) => [normalizeRoot(project.workspaceRoot), project.id]));
    const existing = projectIdByRoot.get(key);
    if (existing !== undefined) return existing;
    const created = await connection.projects.create({
      projectId: idFactory('project'),
      workspaceRoot: projectRoot,
      title: path.basename(projectRoot) || 'Forgon project',
    });
    projectIdByRoot.set(key, created.id);
    return created.id;
  };

  /**
   * Provider to label a thread's events with. A discovered instance id wins; a persisted ref is
   * the fallback; when neither is known the newest run is read from the projection by the caller.
   */
  const providerForThread = (threadId: string): ProviderId | undefined => {
    const instanceId = instanceIdByThread.get(threadId);
    if (instanceId !== undefined) {
      const resolved = providerForInstanceId(instanceId);
      if (resolved !== undefined) return resolved;
    }
    return store.byThreadId(threadId)?.provider;
  };

  const mapperForThread = (threadId: string, provider: ProviderId): ThreadEventMapper => {
    const existing = threadMappers.get(threadId);
    if (existing !== undefined) return existing;
    const mapper = new ThreadEventMapper({
      threadId,
      provider,
      now,
      onEvent: emit,
    });
    threadMappers.set(threadId, mapper);
    return mapper;
  };

  const trackProjection = (threadId: string, provider: ProviderId, projection: T3ThreadProjection): T3Run | undefined => {
    const mapper = mapperForThread(threadId, provider);
    mapper.adoptProjection(projection);
    for (const run of projection.runs) runs.set(run.id, { threadId, provider });
    return newestRun(projection);
  };

  const subscribeToThread = (threadId: string, mapper: ThreadEventMapper): void => {
    const iterate = connection.orchestration.subscribeThread({
      threadId,
      afterSequence: mapper.cursor,
      requestCompletionMarker: false,
    });
    void (async () => {
      try {
        for await (const item of iterate) mapper.applyStreamItem(item);
      } catch (cause) {
        emit({
          runId: `thread:${threadId}`,
          threadId,
          sequence: 1,
          timestamp: now(),
          type: 'diagnostic',
          diagnostic: {
            path: threadId,
            message: redactSecrets(
              `T3 stream ended: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          },
        });
      }
    })();
  };

  /** Subscribe only if this thread is not already streaming; a second subscription would double events. */
  const subscribed = new Set<string>();
  const ensureSubscribed = (threadId: string, mapper: ThreadEventMapper): void => {
    if (subscribed.has(threadId)) return;
    subscribed.add(threadId);
    subscribeToThread(threadId, mapper);
  };

  const requireTrackedThread = (threadId: string): TrackedRun => {
    const tracked = [...runs.values()].find((candidate) => candidate.threadId === threadId);
    if (tracked === undefined) {
      throw new AgentBridgeError('run_not_found', `No tracked thread "${threadId}" exists in this session.`);
    }
    return tracked;
  };

  let lastProviderInfo: readonly AgentProviderInfo[] = [];

  const dispatch = async (command: Record<string, unknown>): Promise<void> => {
    await connection.orchestration.dispatchCommand(command);
  };

  const respond = async (runId: string, requestId: string, response: Pick<Parameters<typeof buildRuntimeRequestRespond>[0], 'decision' | 'answers'>): Promise<void> => {
    const tracked = runs.get(runId);
    if (!tracked) throw runNotFound(runId);
    const mapper = threadMappers.get(tracked.threadId);
    const pending = mapper?.pendingApprovals().find(request => request.requestId === requestId && request.runId === runId && !request.answered);
    if (!pending || Boolean(pending.questions) !== (response.answers !== undefined)) throw approvalNotPending(runId, requestId);
    if (pending.questions) {
      const answers = response.answers!;
      if (Object.keys(answers).some(id => !pending.questions!.some(question => question.id === id))) throw new Error('Unknown question id.');
      for (const question of pending.questions) {
        const answer = answers[question.id];
        if (answer === undefined && question.required === false) continue;
        const values = typeof answer === 'string' ? [answer] : Array.isArray(answer) ? answer : [];
        if (values.length === 0 || values.some(value => typeof value !== 'string' || (!value.trim() && question.initialAnswer === undefined)) || (!question.multiSelect && values.length !== 1)
          || (question.allowCustomAnswer === false && values.some(value => !question.options.some(option => (option.value ?? option.label) === value)))) {
          throw new Error(`Answer required for ${question.header}.`);
        }
      }
    }
    mapper!.consumeApproval(requestId);
    try {
      await dispatch(buildRuntimeRequestRespond({ commandId: idFactory('cmd'), threadId: tracked.threadId, requestId, ...response }));
    } catch (error) {
      pending.answered = false;
      throw error;
    }
  };

  const facade: AgentServiceFacade = {
    start: async (request: AgentRunRequest): Promise<{ runId: string }> => {
      const mapping = mapPermissionMode(request.permissionMode, {
        ...(options.forgonEnforcesInspect === undefined
          ? {}
          : { forgonEnforcesInspect: options.forgonEnforcesInspect }),
      });
      const discovered = await ensureProviders();
      const model = request.model ?? defaultModelFor(request.provider);
      const route = resolveProviderRoute({
        provider: request.provider,
        model,
        discoveredProviders: discovered,
      });
      const routedProvider = discovered.find(provider => provider.instanceId === route.instanceId);
      if (!routedProvider || !modesForProvider(routedProvider).includes(request.permissionMode)) {
        throw new AgentBridgeError('unsupported_control', 'The provider does not support this permission mode.');
      }
      const modelOptions = request.modelOptions ?? [];
      const descriptors = routedProvider.models?.find(candidate => candidate.slug === route.model)?.capabilities?.optionDescriptors ?? [];
      if (new Set(modelOptions.map(option => option.id)).size !== modelOptions.length) throw new AgentBridgeError('unsupported_control', 'A model option can only be selected once.');
      for (const selection of modelOptions) {
        const descriptor = descriptors.map(value => selectModelOptionSchema.safeParse(value)).find(parsed => parsed.success && parsed.data.id === selection.id);
        if (!descriptor?.success || !descriptor.data.options.some(option => option.id === selection.value)) {
          throw new AgentBridgeError('unsupported_control', 'This model does not support the selected reasoning option. Choose a supported value.');
        }
      }
      const projectId = await ensureProject(request.projectRoot);
      const context = buildMessageContext(request.context);
      const prompt = withSceneInstructions(request.prompt);
      const persisted = store.byThreadId(request.threadId);
      const reuseExistingThread = options.reuseExistingThread !== false && persisted !== undefined;
      const launchInput = buildLaunchThreadInput({
        commandId: idFactory('cmd'),
        projectId,
        title: titleFor(request),
        modelSelection: { instanceId: route.instanceId, model: route.model, ...(modelOptions.length ? { options: modelOptions } : {}) },
        runtimeMode: mapping.runtimeMode,
        interactionMode: 'default',
        workspaceStrategy: { type: 'root' },
        threadId: request.threadId,
        // The prompt is the run's first message and must always be sent; context is optional.
        initialMessage: {
          text: prompt,
          ...(context === undefined ? {} : { context }),
        },
      });

      let result: { threadId: string; projection: T3ThreadProjection };
      let messageId: string | undefined;
      if (reuseExistingThread) {
        if (persisted.projectId !== projectId || persisted.provider !== request.provider) {
          throw new AgentBridgeError('unsupported_control', 'Start a new thread to change the project or provider.');
        }
        if (routedProvider.requiresNewThreadForModelChange && persisted.model !== route.model) {
          throw new AgentBridgeError('unsupported_control', 'This provider requires a new thread to change models.');
        }
        await dispatch(buildThreadRuntimeModeSet({ commandId: idFactory('cmd'), threadId: request.threadId, runtimeMode: mapping.runtimeMode }));
        messageId = idFactory('msg');
        await dispatch(buildMessageDispatch({ commandId: idFactory('cmd'), threadId: request.threadId, messageId,
          text: prompt, creation: FORGON_CREATION,
          modelSelection: { instanceId: route.instanceId, model: route.model, options: modelOptions },
          ...(context === undefined ? {} : { context }),
        }));
        result = { threadId: request.threadId, projection: await connection.orchestration.getThreadProjection(request.threadId) };
      } else {
        result = await connection.orchestration.launchThread(launchInput);
      }
      const run = messageId ? result.projection.runs.find(candidate => candidate.userMessageId === messageId) : newestRun(result.projection);
      if (run === undefined) {
        throw new AgentBridgeError(
          'protocol_shape',
          'T3 accepted the message but created no durable run, so there is nothing to track.',
        );
      }

      instanceIdByThread.set(result.threadId, route.instanceId);
      trackProjection(result.threadId, request.provider, result.projection);
      const mapper = mapperForThread(result.threadId, request.provider);
      ensureSubscribed(result.threadId, mapper);

      await store.save({
        runId: run.id,
        threadId: result.threadId,
        projectId,
        projectRoot: request.projectRoot,
        provider: request.provider,
        instanceId: route.instanceId,
        model: route.model,
        permissionMode: request.permissionMode,
        title: titleFor(request),
        createdAt: now(),
      });

      return { runId: run.id };
    },

    cancel: async (runId: string): Promise<void> => {
      const tracked = runs.get(runId);
      if (tracked === undefined) throw runNotFound(runId);
      await dispatch(
        buildRunInterrupt({
          commandId: idFactory('cmd'),
          threadId: tracked.threadId,
          runId,
          reason: 'Cancelled by the Forgon user.',
        }),
      );
    },

    approve: (runId: string, requestId: string, allow: boolean) => respond(runId, requestId, { decision: approvalDecisionFor(allow) }),
    answer: (runId, requestId, answers) => respond(runId, requestId, { answers }),

    subscribe: (listener: (event: AgentEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    availableProviders: async () => availableForgonProviders(await ensureProviders()),

    listProviders: async () => {
      lastProviderInfo = await buildProviderInfo(await ensureProviders());
      return lastProviderInfo;
    },

    refreshProviders: async () => {
      providers = await connection.orchestration.refreshProviders();
      lastProviderInfo = await buildProviderInfo(providers);
      return lastProviderInfo;
    },

    connection: () =>
      createAgentConnection({
        service: facade,
        providers: lastProviderInfo,
        refreshProviders: () => facade.refreshProviders(),
      }),

    threadRefs: () => store.load(),

    resumeThread: async (threadId: string): Promise<ResumeResult> => {
      const ref = store.byThreadId(threadId);
      if (ref !== undefined) instanceIdByThread.set(threadId, ref.instanceId);
      const projection = await connection.orchestration.getThreadProjection(threadId);
      const provider = providerForThread(threadId) ?? (await providerFromProjection(projection));
      if (provider === undefined) {
        throw new AgentBridgeError(
          'unsupported_provider',
          `Thread "${threadId}" is not associated with a Forgon provider; refusing to label its events with a guessed provider.`,
        );
      }
      const run = trackProjection(threadId, provider, projection);
      const mapper = mapperForThread(threadId, provider);
      ensureSubscribed(threadId, mapper);
      return {
        threadId,
        resumed: true,
        ...(run === undefined ? {} : { runId: run.id }),
      };
    },

    reattachPersistedThreads: async (): Promise<readonly ResumeOutcome[]> => {
      const latestByThread = new Map<string, ThreadRef>();
      for (const ref of await store.load()) latestByThread.set(ref.threadId, ref);
      const outcomes: ResumeOutcome[] = [];
      for (const threadId of latestByThread.keys()) {
        try {
          const result = await facade.resumeThread(threadId);
          outcomes.push(result);
        } catch (cause) {
          const message = redactSecrets(cause instanceof Error ? cause.message : String(cause));
          outcomes.push({ threadId, resumed: false, error: message });
          options.onWarning?.(`Could not reattach thread "${threadId}": ${message}`);
        }
      }
      return outcomes;
    },

    turnDiff: async (request) => {
      requireTrackedThread(request.threadId);
      const result = await connection.orchestration.getTurnDiff({
        threadId: request.threadId,
        fromTurnCount: request.fromTurnCount,
        toTurnCount: request.toTurnCount,
        ...(request.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: request.ignoreWhitespace }),
      });
      const mapper = threadMappers.get(request.threadId);
      mapper?.applyDiff({ diff: result.diff, timestamp: now() });
      return {
        threadId: result.threadId,
        fromTurnCount: result.fromTurnCount,
        toTurnCount: result.toTurnCount,
        paths: parseDiffPaths(result.diff),
        diff: result.diff,
      };
    },

    fullThreadDiff: async (request) => {
      requireTrackedThread(request.threadId);
      const result = await connection.orchestration.getFullThreadDiff({
        threadId: request.threadId,
        toTurnCount: request.toTurnCount,
        ...(request.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: request.ignoreWhitespace }),
      });
      const mapper = threadMappers.get(request.threadId);
      mapper?.applyDiff({ diff: result.diff, timestamp: now() });
      return {
        threadId: result.threadId,
        fromTurnCount: result.fromTurnCount,
        toTurnCount: result.toTurnCount,
        paths: parseDiffPaths(result.diff),
        diff: result.diff,
      };
    },

    setModel: async (request) => {
      const tracked = requireTrackedThread(request.threadId);
      const provider = providerFor(tracked.provider);
      if (provider?.requiresNewThreadForModelChange === true) {
        throw unsupportedControl(
          'Changing the model on a live thread',
          `Provider "${tracked.provider}" reports requiresNewThreadForModelChange; start a new thread instead.`,
        );
      }
      const resolvedInstance = instanceIdByThread.get(request.threadId);
      if (resolvedInstance === undefined) {
        throw unsupportedControl(
          'Changing the model on a live thread',
          `No provider instance is known for thread "${request.threadId}"; reattach it first.`,
        );
      }
      await dispatch(
        buildThreadModelSelectionSet({
          commandId: idFactory('cmd'),
          threadId: request.threadId,
          modelSelection: { instanceId: resolvedInstance, model: request.model },
        }),
      );
    },

    setRuntimeMode: async (request) => {
      const tracked = requireTrackedThread(request.threadId);
      const mapping = mapPermissionMode(request.permissionMode, {
        ...(options.forgonEnforcesInspect === undefined
          ? {}
          : { forgonEnforcesInspect: options.forgonEnforcesInspect }),
      });
      const provider = providerFor(tracked.provider);
      if (
        provider?.supportedRuntimeModes !== undefined &&
        !provider.supportedRuntimeModes.includes(mapping.runtimeMode)
      ) {
        throw unsupportedControl(
          `Runtime mode "${mapping.runtimeMode}"`,
          `Provider "${tracked.provider}" does not list this runtime mode; refusing to set one it cannot run.`,
        );
      }
      await dispatch(
        buildThreadRuntimeModeSet({
          commandId: idFactory('cmd'),
          threadId: request.threadId,
          runtimeMode: mapping.runtimeMode,
        }),
      );
    },

    setInteractionMode: async (request) => {
      requireTrackedThread(request.threadId);
      await dispatch(
        buildThreadInteractionModeSet({
          commandId: idFactory('cmd'),
          threadId: request.threadId,
          interactionMode: request.interactionMode,
        }),
      );
    },

    switchProvider: async (request) => {
      requireTrackedThread(request.threadId);
      const discovered = await ensureProviders();
      const model = request.model ?? defaultModelFor(request.provider);
      const route = resolveProviderRoute({
        provider: request.provider,
        model,
        discoveredProviders: discovered,
      });
      await dispatch(
        buildProviderSwitch({
          commandId: idFactory('cmd'),
          threadId: request.threadId,
          modelSelection: { instanceId: route.instanceId, model: route.model },
        }),
      );
      instanceIdByThread.set(request.threadId, route.instanceId);
    },

    permissionModesFor: async (provider: ProviderId) => {
      await ensureProviders();
      const discovered = providerFor(provider);
      return discovered === undefined ? connectionModes() : modesForProvider(discovered);
    },

    instanceIdForThread: (threadId) => instanceIdByThread.get(threadId),

    close: () => {
      listeners.clear();
      runs.clear();
      threadMappers.clear();
      subscribed.clear();
      connection.close();
    },
  };

  /** Fall back to a discovered driver name when neither ref nor instance id names the provider. */
  const providerFromProjection = async (
    projection: T3ThreadProjection,
  ): Promise<ProviderId | undefined> => {
    await ensureProviders();
    return providerForInstanceId(projection.thread.providerInstanceId);
  };

  return facade;
};
