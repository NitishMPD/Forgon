import type {
  OrchestrationClient,
  RpcSession,
  SubscribeThreadInput,
  T3Connection,
  T3ServerProvider,
  T3ThreadProjection,
} from '@forgon/agent-bridge';

export const NOW = '2024-01-01T00:00:00.000Z';

export const serverProvider = (
  overrides: Partial<T3ServerProvider> & Pick<T3ServerProvider, 'instanceId' | 'driver'>,
): T3ServerProvider => ({
  enabled: true,
  installed: true,
  version: '1.0.0',
  ...overrides,
});

export const models = (slug: string, isDefault = false): NonNullable<T3ServerProvider['models']> => [
  { slug, name: slug, isCustom: false, isDefault },
];

export const projection = (input: {
  readonly threadId: string;
  readonly runs: ReadonlyArray<Record<string, unknown>>;
  readonly turnItems?: ReadonlyArray<Record<string, unknown>>;
  readonly runtimeRequests?: ReadonlyArray<Record<string, unknown>>;
}): T3ThreadProjection =>
  ({
    thread: {
      id: input.threadId,
      projectId: 'project-1',
      providerInstanceId: 'codex',
      modelSelection: { instanceId: 'codex', model: 'gpt-5' },
      runtimeMode: 'approval-required',
      worktreePath: null,
    },
    runs: input.runs,
    ...(input.turnItems === undefined ? {} : { turnItems: input.turnItems }),
    ...(input.runtimeRequests === undefined ? {} : { runtimeRequests: input.runtimeRequests }),
    updatedAt: NOW,
  }) as unknown as T3ThreadProjection;

export const run = (id: string, status: string, ordinal = 1): Record<string, unknown> => ({
  id,
  threadId: 'th-1',
  ordinal,
  providerInstanceId: 'codex',
  status,
  userMessageId: 'msg-1',
  requestedAt: NOW,
  completedAt: null,
});

interface StreamController {
  push(item: unknown): void;
  end(): void;
  iterate(): AsyncIterable<unknown>;
}

const createStream = (): StreamController => {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push: (item) => {
      queue.push(item);
      wake?.();
      wake = undefined;
    },
    end: () => {
      done = true;
      wake?.();
      wake = undefined;
    },
    iterate: async function* iterate(): AsyncGenerator<unknown, void, undefined> {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

export interface FakeConnectionCalls {
  readonly launches: Record<string, unknown>[];
  readonly commands: Record<string, unknown>[];
  readonly subscribes: SubscribeThreadInput[];
  readonly createdProjects: Array<{ projectId: string; workspaceRoot: string; title: string }>;
}

export interface FakeConnection {
  readonly connection: T3Connection;
  readonly calls: FakeConnectionCalls;
  push(item: unknown): void;
  endStream(): void;
  setProviders(providers: readonly T3ServerProvider[]): void;
  closeCalls(): number;
}

export const createFakeConnection = (config: {
  readonly providers?: readonly T3ServerProvider[];
  readonly projection: T3ThreadProjection;
  readonly projects?: ReadonlyArray<{ id: string; workspaceRoot: string }>;
  /** Diffs the fake returns from `getTurnDiff` / `getFullThreadDiff`, keyed by thread id. */
  readonly diffs?: Readonly<Record<string, string>>;
  /** Thread ids for which `getThreadProjection` rejects, to exercise reattach failure paths. */
  readonly projectionErrorFor?: readonly string[];
}): FakeConnection => {
  const stream = createStream();
  const calls: FakeConnectionCalls = {
    launches: [],
    commands: [],
    subscribes: [],
    createdProjects: [],
  };
  // `currentProviders` is read at each refresh so a test can change what discovery returns.
  let currentProviders: readonly T3ServerProvider[] = config.providers ?? [];
  let currentProjection = config.projection;
  let closeCount = 0;
  let projectCounter = 0;
  const projects = new Map((config.projects ?? []).map((project) => [project.workspaceRoot, project.id]));

  const orchestration: OrchestrationClient = {
    refreshProviders: async () => currentProviders,
    getConfig: async () => ({}),
    enableProvider: async () => undefined,
    launchThread: async (input) => {
      if (input['reuseExistingThread'] === true && currentProjection.runs.length) throw new Error('Only an empty active thread can be reused during launch.');
      calls.launches.push(input);
      return { threadId: config.projection.thread.id, projection: config.projection, resumed: false };
    },
    dispatchCommand: async (command) => {
      calls.commands.push(command);
      if (command.type === 'message.dispatch') {
        const previous = currentProjection.runs.at(-1);
        currentProjection = { ...currentProjection, runs: [...currentProjection.runs, {
          ...previous, id: `dispatched-${calls.commands.length}`, threadId: String(command['threadId']), ordinal: (previous?.ordinal ?? 0) + 1,
          userMessageId: String(command['messageId']), providerInstanceId: previous?.providerInstanceId ?? 'codex',
          requestedAt: NOW, completedAt: null, status: 'running',
        }] };
      }
      return { sequence: calls.commands.length };
    },
    subscribeThread: (input) => {
      calls.subscribes.push(input);
      return stream.iterate();
    },
    getThreadProjection: async (threadId) => {
      if (config.projectionErrorFor?.includes(threadId) === true) {
        throw new Error(`projection unavailable for ${threadId}`);
      }
      return currentProjection;
    },
    getTurnDiff: async (input) => ({
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
      diff: config.diffs?.[input.threadId] ?? '',
    }),
    getFullThreadDiff: async (input) => ({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      diff: config.diffs?.[input.threadId] ?? '',
    }),
    getTurnItem: async () => null,
    stopWorkflow: async () => undefined,
  };

  const connection = {
    descriptor: {
      environmentId: 'env-1',
      label: 'fake',
      platform: { os: 'windows', arch: 'x64' },
      serverVersion: '1.0.0',
      orchestrationProtocolVersion: 2,
      capabilities: {},
    },
    environmentId: 'env-1',
    serverVersion: '1.0.0',
    session: {} as RpcSession,
    orchestration,
    http: {} as T3Connection['http'],
    projects: {
      snapshot: async () => [...projects.entries()].map(([workspaceRoot, id]) => ({ id, workspaceRoot })),
      create: async (input) => {
        projectCounter += 1;
        const id = `created-${projectCounter}`;
        calls.createdProjects.push({ projectId: input.projectId, workspaceRoot: input.workspaceRoot, title: input.title });
        projects.set(input.workspaceRoot, id);
        return { id, workspaceRoot: input.workspaceRoot };
      },
    },
    ticketExpiresAt: '2030-01-01T00:00:00.000Z',
    close: () => {
      closeCount += 1;
    },
  } satisfies T3Connection;

  return {
    connection,
    calls,
    push: (item) => stream.push(item),
    endStream: () => stream.end(),
    setProviders: (providers) => {
      currentProviders = providers;
    },
    closeCalls: () => closeCount,
  };
};

export const event = (sequence: number, type: string, payload: unknown): Record<string, unknown> => ({
  kind: 'event',
  sequence,
  event: { id: `evt-${sequence}`, threadId: 'th-1', occurredAt: NOW, type, payload },
});

export const tick = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
