/**
 * Browser-safe `AgentService` adapter over an injected transport — the renderer half of the
 * desktop IPC seam.
 *
 * The renderer cannot import `apps/agent-service` (it pulls `node:path` and the persistence layer),
 * and a function cannot cross an IPC boundary, so the two sides exchange plain data:
 *
 *   host (Node/Tauri)                     renderer (webview)
 *   ─────────────────                     ──────────────────
 *   createAgentServiceRpcHandler(service)  createAgentServiceProxy(transport)
 *              ↑ transport.call(call)  ←──────────┘
 *   service.subscribe(push) ───transport.onEvent──→ listener
 *
 * This module implements the two ends and nothing about the mechanism that carries them: no Tauri,
 * no `node:*`, no socket. The host supplies `AgentServiceTransport` over whatever channel it owns
 * (Tauri events, a Worker port, a test double), so no transport is guessed here. The reconstructed
 * proxy is structurally the same `AgentService` the UI already consumes, and a refusal that
 * crossed the boundary keeps its typed `AgentBridgeError` code rather than becoming a generic error.
 */
import { z } from 'zod';
import type { AgentEvent, AgentRunRequest, AgentService } from '@forgon/project-schema';
import {
  AgentBridgeError,
  isAgentBridgeError,
  isAgentBridgeErrorCode,
  type AgentBridgeErrorCode,
} from './errors.js';
import { createAgentConnection, type AgentConnection, type AgentProviderInfo } from './agentConnection.js';

/** The three `AgentService` methods that take arguments. `subscribe` is the event channel. */
export type AgentServiceMethod = 'start' | 'cancel' | 'approve';

/**
 * One request crossing the boundary. A single discriminated object (not a `(name, params)` pair)
 * so the wire value validates as one shape and a host switch stays exhaustive.
 */
export type AgentServiceCall =
  | { readonly method: 'start'; readonly request: AgentRunRequest }
  | { readonly method: 'cancel'; readonly runId: string }
  | { readonly method: 'approve'; readonly runId: string; readonly requestId: string; readonly allow: boolean };

/**
 * One reply. Failures are values, not thrown: a rejected IPC call loses the `code`, and the UI
 * needs the same typed refusal (`approval_unbound`, `unsupported_provider`, …) it would see
 * in-process.
 */
export type AgentServiceCallResult =
  | { readonly ok: true; readonly runId?: string }
  | { readonly ok: false; readonly message: string; readonly code?: AgentBridgeErrorCode };

export interface AgentServiceTransport {
  /** Forward one call to the host handler. Should reject only if the channel itself is broken. */
  call(call: AgentServiceCall): Promise<AgentServiceCallResult>;
  /** Receive events the host forwards from the real service. Returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

const agentRunRequestSchema = z
  .object({
    threadId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().optional(),
    prompt: z.string(),
    projectRoot: z.string().min(1),
    permissionMode: z.string().min(1),
    context: z
      .object({
        files: z.array(z.string()),
        sceneId: z.string().optional(),
        entityIds: z.array(z.string()),
        assetIds: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough();

const callSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('start'), request: agentRunRequestSchema }).passthrough(),
  z.object({ method: z.literal('cancel'), runId: z.string().min(1) }).passthrough(),
  z
    .object({ method: z.literal('approve'), runId: z.string().min(1), requestId: z.string().min(1), allow: z.boolean() })
    .passthrough(),
]);

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Validate an inbound call value. A malformed call is a `protocol_shape` failure on this seam, not
 * a silent default: the host never runs a method it could not read.
 */
export const parseAgentServiceCall = (value: unknown): AgentServiceCall => {
  const parsed = callSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentBridgeError('protocol_shape', 'The agent IPC call was malformed.', {
      detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    });
  }
  return parsed.data as AgentServiceCall;
};

/**
 * Host side: turn a real `AgentService` into an IPC handler. The handler never throws — every
 * failure becomes `{ ok: false }`, preserving an `AgentBridgeError` code when there is one.
 *
 * The host is still responsible for forwarding events: `service.subscribe(sink)` where `sink`
 * pushes to the channel the renderer's `onEvent` reads.
 */
export type AgentServiceRpcHandler = (call: unknown) => Promise<AgentServiceCallResult>;

export const createAgentServiceRpcHandler = (service: AgentService): AgentServiceRpcHandler => async (call) => {
  let parsed: AgentServiceCall;
  try {
    parsed = parseAgentServiceCall(call);
  } catch (cause) {
    return { ok: false, code: 'protocol_shape', message: describe(cause) };
  }

  try {
    switch (parsed.method) {
      case 'start': {
        const { runId } = await service.start(parsed.request);
        return { ok: true, runId };
      }
      case 'cancel': {
        await service.cancel(parsed.runId);
        return { ok: true };
      }
      case 'approve': {
        await service.approve(parsed.runId, parsed.requestId, parsed.allow);
        return { ok: true };
      }
    }
  } catch (cause) {
    return isAgentBridgeError(cause)
      ? { ok: false, code: cause.code, message: cause.message }
      : { ok: false, code: 'service_error', message: describe(cause) };
  }
};

/**
 * Rebuild a failure from the wire. A hand-written transport in untyped JS could carry a code this
 * build does not know; an unknown code degrades to a plain `Error` rather than entering the union.
 */
const failureToError = (result: { readonly message: string; readonly code?: unknown }): Error =>
  isAgentBridgeErrorCode(result.code) ? new AgentBridgeError(result.code, result.message) : new Error(result.message);

/**
 * Renderer side: rebuild a live-looking `AgentService` from the transport. `start` refuses to
 * report a run the host did not confirm with a `runId`; a result without one is a shape failure,
 * not a fake success.
 */
export const createAgentServiceProxy = (transport: AgentServiceTransport): AgentService => ({
  start: async (request) => {
    const result = await transport.call({ method: 'start', request });
    if (!result.ok) throw failureToError(result);
    if (typeof result.runId !== 'string' || result.runId.length === 0) {
      throw new AgentBridgeError('protocol_shape', 'The agent host answered start without a runId.', {
        detail: 'A run id is required to track the run; the proxy will not report a run it cannot address.',
      });
    }
    return { runId: result.runId };
  },
  cancel: async (runId) => {
    const result = await transport.call({ method: 'cancel', runId });
    if (!result.ok) throw failureToError(result);
  },
  approve: async (runId, requestId, allow) => {
    const result = await transport.call({ method: 'approve', runId, requestId, allow });
    if (!result.ok) throw failureToError(result);
  },
  subscribe: (listener) => transport.onEvent(listener),
});

export interface RemoteAgentConnectionInput {
  readonly transport: AgentServiceTransport;
  /** The host's last provider snapshot, already serializable plain data. */
  readonly providers: readonly AgentProviderInfo[];
  readonly refreshProviders?: () => Promise<readonly AgentProviderInfo[]>;
}

/** Build the renderer-facing connection whose `service` is an IPC proxy over `transport`. */
export const createRemoteAgentConnection = (input: RemoteAgentConnectionInput): AgentConnection =>
  createAgentConnection({
    service: createAgentServiceProxy(input.transport),
    providers: input.providers,
    ...(input.refreshProviders === undefined ? {} : { refreshProviders: input.refreshProviders }),
  });
