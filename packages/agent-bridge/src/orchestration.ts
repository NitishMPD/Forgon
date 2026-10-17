/**
 * Typed client for the T3 orchestration v2 RPC surface.
 *
 * Method tags come from `ORCHESTRATION_V2_WS_METHODS` and `WS_METHODS` in
 * `packages/contracts/src/{orchestrationV2,rpc}.ts`; payload/response shapes from
 * `OrchestrationV2RpcSchemas` at the pinned revision. This file owns no provider logic and no
 * transport: it takes an `RpcSession` and turns each call into one decoded value, refusing a
 * response that does not match the audited shape instead of guessing.
 */
import type { ZodType } from 'zod';
import {
  SERVER_METHODS,
  WS_METHODS,
  dispatchCommandResultSchema,
  getTurnItemResultSchema,
  refreshProvidersResultSchema,
  threadLaunchResultSchema,
  threadProjectionSchema,
  turnDiffSchema,
  type T3ServerProvider,
  type T3ThreadProjection,
  type T3TurnDiff,
} from './protocol.js';
import { protocolShape } from './errors.js';
import type { RpcSession } from './wsClient.js';

const decode = <T>(what: string, value: unknown, schema: ZodType<T>): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw protocolShape(what, parsed.error.message);
  return parsed.data;
};

export interface SubscribeThreadInput {
  readonly threadId: string;
  /** Resume cursor: the last stream sequence already consumed. */
  readonly afterSequence?: number;
  /** Ask the server to emit a completion marker so a client knows the stream is caught up. */
  readonly requestCompletionMarker?: boolean;
}

export interface TurnDiffInput {
  readonly threadId: string;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly ignoreWhitespace?: boolean;
}

export interface FullThreadDiffInput {
  readonly threadId: string;
  readonly toTurnCount: number;
  readonly ignoreWhitespace?: boolean;
}

export interface OrchestrationClient {
  refreshProviders(): Promise<readonly T3ServerProvider[]>;
  getConfig(): Promise<unknown>;
  /** Turn on a provider instance in this isolated T3 home (some drivers, e.g. OpenCode, default to off). */
  enableProvider(input: { instanceId: string; driver: string }): Promise<void>;
  launchThread(input: Record<string, unknown>): Promise<{ threadId: string; projection: T3ThreadProjection; resumed: boolean }>;
  dispatchCommand(command: Record<string, unknown>): Promise<{ sequence: number }>;
  subscribeThread(input: SubscribeThreadInput): AsyncIterable<unknown>;
  getThreadProjection(threadId: string): Promise<T3ThreadProjection>;
  getTurnDiff(input: TurnDiffInput): Promise<T3TurnDiff>;
  getFullThreadDiff(input: FullThreadDiffInput): Promise<T3TurnDiff>;
  getTurnItem(input: { threadId: string; itemId: string; revision?: string }): Promise<unknown | null>;
  stopWorkflow(input: { threadId: string; subagentId: string }): Promise<void>;
}

/**
 * Create a client over a live RPC session.
 *
 * Timeout defaults are generous: a provider turn can legitimately take a while to be created, and
 * a too-short timeout would misreport a slow start as a transport failure.
 */
export const createOrchestrationClient = (session: RpcSession, defaults?: { readonly callTimeoutMs?: number }): OrchestrationClient => {
  const timeoutMs = defaults?.callTimeoutMs ?? 30_000;

  return {
    refreshProviders: async () => {
      const result = await session.request(SERVER_METHODS.refreshProviders, {}, { timeoutMs });
      return decode('server.refreshProviders', result, refreshProvidersResultSchema).providers;
    },

    getConfig: async () => session.request(SERVER_METHODS.getConfig, {}, { timeoutMs }),

    enableProvider: async ({ instanceId, driver }) => {
      // T3 reads both the instance flag and the driver config's own flag; an explicit false in either wins.
      await session.request(SERVER_METHODS.updateSettings, {
        patch: {},
        providerInstanceMutation: { operation: 'upsert', instanceId, instance: { driver, enabled: true, config: { enabled: true } } },
      }, { timeoutMs });
    },

    launchThread: async (input) => {
      const result = await session.request(WS_METHODS.launchThread, input, { timeoutMs });
      return decode('orchestration.launchThread', result, threadLaunchResultSchema);
    },

    dispatchCommand: async (command) => {
      const result = await session.request(WS_METHODS.dispatchCommand, command, { timeoutMs });
      return decode('orchestration.dispatchCommand', result, dispatchCommandResultSchema);
    },

    subscribeThread: (input) =>
      session.stream(WS_METHODS.subscribeThread, {
        threadId: input.threadId,
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        ...(input.requestCompletionMarker === undefined ? {} : { requestCompletionMarker: input.requestCompletionMarker }),
      }),

    getThreadProjection: async (threadId) => {
      const result = await session.request(WS_METHODS.getThreadProjection, { threadId }, { timeoutMs });
      return decode('orchestration.getThreadProjection', result, threadProjectionSchema);
    },

    getTurnDiff: async (input) => {
      const result = await session.request(WS_METHODS.getTurnDiff, input, { timeoutMs });
      return decode('orchestration.getTurnDiff', result, turnDiffSchema);
    },

    getFullThreadDiff: async (input) => {
      const result = await session.request(WS_METHODS.getFullThreadDiff, input, { timeoutMs });
      return decode('orchestration.getFullThreadDiff', result, turnDiffSchema);
    },

    getTurnItem: async (input) => {
      const result = await session.request(WS_METHODS.getTurnItem, input, { timeoutMs });
      return decode('orchestration.getTurnItem', result, getTurnItemResultSchema).item;
    },

    stopWorkflow: async (input) => {
      await session.request(WS_METHODS.stopWorkflow, input, { timeoutMs });
    },
  };
};
