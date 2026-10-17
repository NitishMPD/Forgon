/**
 * Typed failures for the T3 bridge and sidecar manager.
 *
 * Every error carries a stable `code` so callers and the service interface can
 * report *why* something is unavailable instead of substituting a fake success.
 * `unsupported` and `unavailable` are deliberately distinct: `unsupported` means
 * the protocol/provider cannot express the control, `unavailable` means it exists
 * but this build/host cannot supply it right now.
 */
export const AGENT_BRIDGE_ERROR_CODES = [
  'protocol_version_mismatch',
  'protocol_shape',
  'auth_failed',
  'transport_failed',
  'rpc_failed',
  'unsupported_provider',
  'unsupported_permission_mode',
  'unsupported_control',
  'run_not_found',
  'approval_unbound',
  'rollback_not_isolated',
  'sidecar_unavailable',
  'provenance_unverified',
  'containment_violation',
  'invalid_configuration',
  'service_stopped',
  'service_error',
] as const;

export type AgentBridgeErrorCode = (typeof AGENT_BRIDGE_ERROR_CODES)[number];

/**
 * True when `value` is one of the stable error codes. An IPC seam uses this to decide whether a
 * failure that crossed the boundary can be rebuilt as the same typed `AgentBridgeError` or must
 * degrade to a plain `Error` — a code it does not recognise is never invented into the union.
 */
export const isAgentBridgeErrorCode = (value: unknown): value is AgentBridgeErrorCode =>
  typeof value === 'string' && (AGENT_BRIDGE_ERROR_CODES as readonly string[]).includes(value);

/** Details of a typed RPC failure returned by T3 as an Effect tagged error. */
export interface RpcFailureInfo {
  /** The RPC method tag, e.g. `orchestration.dispatchCommand`. */
  readonly method: string;
  /** The Effect error `_tag` when the failure was a tagged error, else `undefined`. */
  readonly errorTag: string | undefined;
  /** The raw decoded failure payload, for callers that need its fields. */
  readonly payload: unknown;
}

export class AgentBridgeError extends Error {
  readonly code: AgentBridgeErrorCode;
  readonly detail: string | undefined;
  readonly rpc: RpcFailureInfo | undefined;

  constructor(
    code: AgentBridgeErrorCode,
    message: string,
    options?: { detail?: string; cause?: unknown; rpc?: RpcFailureInfo },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentBridgeError';
    this.code = code;
    this.detail = options?.detail;
    this.rpc = options?.rpc;
  }
}

/** Read a tagged Effect error's `_tag` from a decoded failure payload. */
export const rpcErrorTagOf = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const tag = (payload as { _tag?: unknown })._tag;
  return typeof tag === 'string' ? tag : undefined;
};

export const rpcFailed = (method: string, failure: unknown, message: string): AgentBridgeError =>
  new AgentBridgeError('rpc_failed', message, {
    rpc: { method, errorTag: rpcErrorTagOf(failure), payload: failure },
  });

export const isAgentBridgeError = (value: unknown): value is AgentBridgeError =>
  value instanceof AgentBridgeError;

/** True when a bridge error is a typed RPC failure with the given Effect error `_tag`. */
export const hasRpcErrorTag = (value: unknown, tag: string): boolean =>
  isAgentBridgeError(value) && value.rpc?.errorTag === tag;

/** Protocol versioning failed: refuse rather than fall back to a guessed shape. */
export const protocolVersionMismatch = (expected: number, received: number | undefined): AgentBridgeError =>
  new AgentBridgeError(
    'protocol_version_mismatch',
    received === undefined
      ? `The T3 environment did not advertise orchestration protocol version ${expected}; it is older than protocol negotiation and cannot be used safely.`
      : `This bridge speaks orchestration protocol ${expected}, but the T3 environment advertises ${received}. Upgrade the pinned t3 sidecar or this bridge before connecting.`,
  );

export const protocolShape = (what: string, detail: string, cause?: unknown): AgentBridgeError =>
  new AgentBridgeError('protocol_shape', `Unexpected ${what} from the T3 environment.`, { detail, cause });

export const unsupportedProvider = (provider: string): AgentBridgeError =>
  new AgentBridgeError(
    'unsupported_provider',
    `Forgon supports codex, opencode and claude-code; "${provider}" is not one of them.`,
  );

export const unsupportedPermissionMode = (mode: string, reason: string): AgentBridgeError =>
  new AgentBridgeError('unsupported_permission_mode', reason, { detail: `permissionMode=${mode}` });

export const unsupportedControl = (control: string, reason: string): AgentBridgeError =>
  new AgentBridgeError('unsupported_control', `${control} is unavailable and will not be simulated.`, {
    detail: reason,
  });

export const transportFailed = (what: string, cause: unknown): AgentBridgeError =>
  new AgentBridgeError('transport_failed', `The T3 transport failed during ${what}.`, { cause });

export const authFailed = (what: string, detail?: string): AgentBridgeError =>
  new AgentBridgeError('auth_failed', `T3 authentication failed during ${what}.`, {
    ...(detail === undefined ? {} : { detail }),
  });

export const runNotFound = (runId: string): AgentBridgeError =>
  new AgentBridgeError('run_not_found', `No tracked run "${runId}" exists in this session.`);

/**
 * An approval was answered for a request that is not currently pending for its run. This is the
 * binding check: a stale, guessed or already-answered id must not reach `runtime-request.respond`,
 * or a caller could replay one approval onto a different pending action.
 */
export const approvalNotPending = (runId: string, requestId: string): AgentBridgeError =>
  new AgentBridgeError(
    'approval_unbound',
    `Approval "${requestId}" is not pending for run "${runId}"; refusing to answer a request this session did not receive.`,
  );

export const rollbackNotIsolated = (): AgentBridgeError =>
  new AgentBridgeError(
    'rollback_not_isolated',
    'File restore is unavailable for this thread: the workspace is not an isolated worktree, so restoring files could discard another thread\'s edits. Rewind the conversation instead.',
  );
