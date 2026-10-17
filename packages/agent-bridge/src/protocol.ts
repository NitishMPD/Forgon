/**
 * T3 Code protocol v2 constants and wire schemas.
 *
 * Every constant and shape here is transcribed from the audited T3 Code revision
 * `2520821d575fb769875f67fca1b9c62784817452` (see LICENSES/t3code.txt). Nothing in
 * this file may be guessed from a method name: if a value is not traceable to a
 * source path named in the comment, it does not belong here.
 *
 * Schemas are deliberately tolerant (`.passthrough()`) because T3 strips, rather
 * than rejects, unknown fields, and newer servers add fields and event types. The
 * bridge validates what it consumes and preserves what it does not.
 */
import { z } from 'zod';

// packages/contracts/src/environment.ts
export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = '2';
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = 'orchestrationProtocol';
export const ORCHESTRATION_PROTOCOL_HEADER = 'x-t3-orchestration-protocol';

// apps/server/src/auth/EnvironmentAuth.ts
export const WEBSOCKET_TICKET_QUERY_PARAM = 'wsTicket';

// packages/contracts/src/environmentHttp.ts + apps/server/src/ws.ts
export const ENVIRONMENT_DESCRIPTOR_PATH = '/.well-known/t3/environment';
export const PROJECTS_SNAPSHOT_PATH = '/api/projects';
export const PROJECTS_MUTATE_PATH = '/api/projects/mutate';
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const WEBSOCKET_TICKET_PATH = '/api/auth/websocket-ticket';
export const WS_PATH = '/ws';

// packages/contracts/src/auth.ts
export const AUTH_TOKEN_EXCHANGE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:token-exchange';
export const AUTH_ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE =
  'urn:t3:params:oauth:token-type:environment-bootstrap';

// packages/contracts/src/orchestrationV2.ts (ORCHESTRATION_V2_WS_METHODS)
export const WS_METHODS = {
  dispatchCommand: 'orchestration.dispatchCommand',
  getTurnDiff: 'orchestration.getTurnDiff',
  getFullThreadDiff: 'orchestration.getFullThreadDiff',
  getThreadProjection: 'orchestration.getThreadProjection',
  getTurnItem: 'orchestration.getTurnItem',
  launchThread: 'orchestration.launchThread',
  stopWorkflow: 'orchestration.stopWorkflow',
  subscribeShell: 'orchestration.subscribeShell',
  subscribeThread: 'orchestration.subscribeThread',
  subscribeCommandOutput: 'orchestration.subscribeCommandOutput',
} as const;

// packages/contracts/src/rpc.ts (WS_METHODS)
export const SERVER_METHODS = {
  refreshProviders: 'server.refreshProviders',
  getConfig: 'server.getConfig',
  updateSettings: 'server.updateSettings',
} as const;

// packages/contracts/src/providerPolicy.ts
export const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export type T3RuntimeMode = (typeof RUNTIME_MODES)[number];
export const DEFAULT_RUNTIME_MODE: T3RuntimeMode = 'full-access';

export const PROVIDER_INTERACTION_MODES = ['default', 'plan'] as const;
export const PROVIDER_REQUEST_KINDS = [
  'command',
  'file-read',
  'file-change',
  'mcp-elicitation',
  'permission',
] as const;

export const PROVIDER_APPROVAL_DECISIONS = [
  'accept',
  'acceptForSession',
  'acceptAlways',
  'decline',
  'cancel',
] as const;
export type T3ApprovalDecision = (typeof PROVIDER_APPROVAL_DECISIONS)[number];

// packages/contracts/src/orchestrationV2.ts (OrchestrationV2RunStatus)
export const RUN_STATUSES = [
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type T3RunStatus = (typeof RUN_STATUSES)[number];

/** Terminal run statuses: once reached, a run will not produce more live work. */
export const TERMINAL_RUN_STATUSES = [
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
] as const satisfies ReadonlyArray<T3RunStatus>;

export const isTerminalRunStatus = (status: T3RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as ReadonlyArray<T3RunStatus>).includes(status);

export const TURN_ITEM_STATUSES = [
  'idle',
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export const TURN_ITEM_TYPES = [
  'notification',
  'user_message',
  'assistant_message',
  'reasoning',
  'proposed_plan',
  'todo_list',
  'user_input_request',
  'file_change',
  'command_execution',
  'file_search',
  'web_search',
  'approval_request',
  'checkpoint',
  'run_interrupt_request',
  'run_interrupt_result',
  'system_notice',
  'error',
  'compaction',
  'handoff',
  'fork',
  'thread_created',
  'secret_request',
  'subagent',
  'dynamic_tool',
] as const;
export type T3TurnItemType = (typeof TURN_ITEM_TYPES)[number];

/** Server/client enforcement split copy, kept verbatim so it can be reported to users. */
export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  'File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.';

const trimmedNonEmpty = z.string().min(1);

/** `ExecutionEnvironmentCapabilities`: all flags optional, decoded loosely. */
export const environmentCapabilitiesSchema = z
  .object({
    repositoryIdentity: z.boolean().optional(),
    connectionProbe: z.boolean().optional(),
    attachmentUploads: z.boolean().optional(),
    fileAttachments: z.object({ maxUploadBytes: z.number().int().positive() }).passthrough().optional(),
    pullRequests: z.boolean().optional(),
    commandOutputStreaming: z.boolean().optional(),
    serverBrowser: z.boolean().optional(),
    threadRestartContinuation: z.boolean().optional(),
  })
  .passthrough();

export const executionEnvironmentDescriptorSchema = z
  .object({
    environmentId: trimmedNonEmpty,
    label: trimmedNonEmpty,
    platform: z
      .object({
        os: z.enum(['darwin', 'linux', 'windows', 'unknown']),
        arch: z.enum(['arm64', 'x64', 'other']),
      })
      .passthrough(),
    serverVersion: trimmedNonEmpty,
    // Absent means a server older than protocol negotiation. The bridge must fail
    // loudly rather than assume compatibility (packages/contracts/src/environment.ts).
    orchestrationProtocolVersion: z.number().int().optional(),
    capabilities: environmentCapabilitiesSchema,
  })
  .passthrough();
export type ExecutionEnvironmentDescriptor = z.infer<typeof executionEnvironmentDescriptorSchema>;

export const authWebSocketTicketResultSchema = z
  .object({ ticket: trimmedNonEmpty, expiresAt: z.string() })
  .passthrough();

export const authAccessTokenResultSchema = z
  .object({
    access_token: trimmedNonEmpty,
    issued_token_type: z.string(),
    token_type: z.enum(['Bearer', 'DPoP']),
    expires_in: z.number(),
    scope: z.string(),
  })
  .passthrough();

export const projectSchema = z
  .object({
    id: trimmedNonEmpty,
    workspaceRoot: z.string(),
  })
  .passthrough();

export const projectSnapshotSchema = z
  .object({ projects: z.array(projectSchema), updatedAt: z.string() })
  .passthrough();

export const modelSelectionSchema = z
  .object({ instanceId: trimmedNonEmpty, model: trimmedNonEmpty })
  .passthrough();

export const runtimeRequestIdSchema = z.string().min(1);

/** `OrchestrationV2Run`, reduced to the fields the bridge maps. */
export const runSchema = z
  .object({
    id: trimmedNonEmpty,
    threadId: trimmedNonEmpty,
    ordinal: z.number(),
    providerInstanceId: trimmedNonEmpty,
    status: z.enum(RUN_STATUSES),
    userMessageId: trimmedNonEmpty,
    requestedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .passthrough();
export type T3Run = z.infer<typeof runSchema>;

const turnItemBase = {
  id: trimmedNonEmpty,
  threadId: trimmedNonEmpty,
  runId: z.string().nullable(),
  ordinal: z.number(),
  status: z.enum(TURN_ITEM_STATUSES),
  title: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  updatedAt: z.string(),
};

/**
 * `OrchestrationV2TurnItem`, keyed by `type`. Only the fields the bridge reads are
 * declared; the rest pass through untouched so callers can inspect them.
 */
export const turnItemSchema = z.discriminatedUnion('type', [
  z.object({ ...turnItemBase, type: z.literal('notification') }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('user_message'), text: z.string(), messageId: trimmedNonEmpty }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('assistant_message'), text: z.string(), messageId: trimmedNonEmpty, streaming: z.boolean() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('reasoning'), text: z.string(), streaming: z.boolean() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('proposed_plan'), markdown: z.string(), streaming: z.boolean() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('todo_list'), steps: z.array(z.unknown()) }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('user_input_request'), requestId: runtimeRequestIdSchema, questions: z.array(z.unknown()) }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('file_change'), fileName: trimmedNonEmpty, additions: z.number().optional(), deletions: z.number().optional() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('command_execution'), input: z.string(), output: z.string().optional(), exitCode: z.number().optional() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('file_search'), pattern: z.string().optional() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('web_search') }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('approval_request'), requestId: runtimeRequestIdSchema, requestKind: z.enum(PROVIDER_REQUEST_KINDS), prompt: z.string().optional() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('checkpoint'), checkpointId: trimmedNonEmpty, scopeId: trimmedNonEmpty, files: z.array(z.object({ path: z.string() }).passthrough()) }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('run_interrupt_request'), message: z.string() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('run_interrupt_result'), message: z.string() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('system_notice'), message: z.string() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('error'), failure: z.object({ class: z.string(), message: z.string() }).passthrough() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('compaction') }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('handoff') }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('fork') }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('thread_created') }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('secret_request'), label: trimmedNonEmpty, reason: z.string(), secretStatus: z.string() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('subagent'), subagentId: trimmedNonEmpty, prompt: z.string() }).passthrough(),
  z.object({ ...turnItemBase, type: z.literal('dynamic_tool'), input: z.unknown(), output: z.unknown().optional(), toolName: z.string().nullable().optional() }).passthrough(),
]);
export type T3TurnItem = z.infer<typeof turnItemSchema>;

const eventBaseSchema = z.object({
  id: trimmedNonEmpty,
  threadId: trimmedNonEmpty,
  occurredAt: z.string(),
});

/**
 * Domain event arm we map directly. `type` is left as a free string so a newer
 * server's event reaches the unknown-event branch instead of failing the stream
 * (orchestrationV2.ts `OrchestrationV2UnknownThreadStreamEvent`).
 */
export const domainEventSchema = eventBaseSchema
  .extend({ type: z.string(), payload: z.unknown().optional() })
  .passthrough();
export type T3DomainEvent = z.infer<typeof domainEventSchema>;

export const threadStreamItemSchema = z.union([
  z.object({ kind: z.literal('synchronized') }).passthrough(),
  z
    .object({
      kind: z.literal('snapshot'),
      snapshotSequence: z.number().int().nonnegative(),
      projection: z
        .object({
          thread: z.object({ id: trimmedNonEmpty, projectId: trimmedNonEmpty }).passthrough(),
          runs: z.array(runSchema),
          turnItems: z.array(z.unknown()).optional(),
          visibleTurnItems: z
            .array(z.object({ position: z.number(), item: z.unknown() }).passthrough())
            .optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z.object({ kind: z.literal('event'), sequence: z.number().int().nonnegative(), event: domainEventSchema }).passthrough(),
  z.object({ kind: z.literal('unknown-event'), sequence: z.number().int().nonnegative(), eventType: z.string() }).passthrough(),
]);
export type T3ThreadStreamItem = z.infer<typeof threadStreamItemSchema>;

export const threadProjectionSchema = z
  .object({
    thread: z
      .object({
        id: trimmedNonEmpty,
        projectId: trimmedNonEmpty,
        providerInstanceId: trimmedNonEmpty,
        modelSelection: modelSelectionSchema,
        runtimeMode: z.enum(RUNTIME_MODES),
        branch: z.string().nullable().optional(),
        worktreePath: z.string().nullable(),
      })
      .passthrough(),
    runs: z.array(runSchema),
    turnItems: z.array(z.unknown()).optional(),
    visibleTurnItems: z
      .array(z.object({ position: z.number(), item: z.unknown() }).passthrough())
      .optional(),
    runtimeRequests: z.array(z.unknown()).optional(),
    checkpointScopes: z.array(z.object({ id: trimmedNonEmpty, cwd: z.string() }).passthrough()).optional(),
    checkpoints: z.array(z.object({ id: trimmedNonEmpty, scopeId: trimmedNonEmpty }).passthrough()).optional(),
    updatedAt: z.string(),
  })
  .passthrough();
export type T3ThreadProjection = z.infer<typeof threadProjectionSchema>;

export const threadLaunchResultSchema = z
  .object({ threadId: trimmedNonEmpty, projection: threadProjectionSchema, resumed: z.boolean() })
  .passthrough();

export const dispatchCommandResultSchema = z.object({ sequence: z.number().int().nonnegative() }).passthrough();

export const turnDiffSchema = z
  .object({ threadId: trimmedNonEmpty, fromTurnCount: z.number(), toTurnCount: z.number(), diff: z.string() })
  .passthrough();
export type T3TurnDiff = z.infer<typeof turnDiffSchema>;

export const getTurnItemResultSchema = z.object({ item: z.unknown().nullable() }).passthrough();

/**
 * `server.refreshProviders` → `ServerProviderUpdatedPayload` (`packages/contracts/src/server.ts`).
 * `providers` is an array of `ServerProvider`; `instanceId` is the only stable routing key.
 */
/** `ServerProviderModel` (`packages/contracts/src/server.ts`): one selectable model. */
export const serverProviderModelSchema = z
  .object({
    slug: trimmedNonEmpty,
    name: trimmedNonEmpty,
    shortName: z.string().optional(),
    subProvider: z.string().optional(),
    isCustom: z.boolean(),
    isDefault: z.boolean().optional(),
    isLegacy: z.boolean().optional(),
    badge: z.string().optional(),
    capabilities: z
      .object({ optionDescriptors: z.array(z.unknown()).optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type T3ServerProviderModel = z.infer<typeof serverProviderModelSchema>;

/**
 * `ServerProviderUsageLimits` (`packages/contracts/src/providerUsageLimits.ts`). Windows are the
 * only part Forgon surfaces; `unavailable` distinguishes an account that can never report usage
 * from a probe that failed this time, so a UI does not show stale bars as fresh.
 */
export const serverProviderUsageWindowSchema = z
  .object({
    id: trimmedNonEmpty,
    kind: z.enum(['session', 'weekly', 'monthly', 'other']),
    label: trimmedNonEmpty,
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.string().optional(),
    windowDurationMins: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type T3ServerProviderUsageWindow = z.infer<typeof serverProviderUsageWindowSchema>;

export const serverProviderUsageLimitsSchema = z
  .object({
    checkedAt: z.string(),
    windows: z.array(serverProviderUsageWindowSchema),
    credentialFingerprint: z.string().optional(),
    unavailable: z
      .object({ reason: z.enum(['unsupported', 'probeFailed']), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type T3ServerProviderUsageLimits = z.infer<typeof serverProviderUsageLimitsSchema>;

export const serverProviderSchema = z
  .object({
    instanceId: trimmedNonEmpty,
    driver: trimmedNonEmpty,
    displayName: z.string().optional(),
    enabled: z.boolean(),
    installed: z.boolean(),
    version: z.string().nullable(),
    availability: z.string().optional(),
    unavailableReason: z.string().optional(),
    message: z.string().optional(),
    checkedAt: z.string().optional(),
    state: z.enum(['ready', 'warning', 'error', 'disabled']).optional(),
    supportedRuntimeModes: z.array(z.enum(RUNTIME_MODES)).optional(),
    requiresNewThreadForModelChange: z.boolean().optional(),
    reportsContextWindow: z.boolean().optional(),
    supportsConversationRollback: z.boolean().optional(),
    auth: z
      .object({
        status: z.enum(['authenticated', 'unauthenticated', 'unknown']),
        label: z.string().optional(),
        email: z.string().optional(),
        type: z.string().optional(),
        canLogout: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    models: z.array(serverProviderModelSchema).optional(),
    nativeSessions: z
      .object({
        canList: z.boolean(),
        canLoad: z.boolean(),
        canResume: z.boolean(),
        canDelete: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    usageLimits: serverProviderUsageLimitsSchema.optional(),
  })
  .passthrough();
export type T3ServerProvider = z.infer<typeof serverProviderSchema>;

export const refreshProvidersResultSchema = z
  .object({ providers: z.array(serverProviderSchema) })
  .passthrough();

/**
 * Command `type` literals a client may dispatch (`OrchestrationV2Command`).
 *
 * `thread.stop` exists upstream but only in the server-only internal command union, so a client
 * must never send it; cancelling a run is `run.interrupt`.
 */
export const COMMAND_TYPES = {
  messageDispatch: 'message.dispatch',
  runInterrupt: 'run.interrupt',
  runtimeRequestRespond: 'runtime-request.respond',
  checkpointRollback: 'checkpoint.rollback',
  threadModelSelectionSet: 'thread.model-selection.set',
  threadRuntimeModeSet: 'thread.runtime-mode.set',
  threadInteractionModeSet: 'thread.interaction-mode.set',
  providerSwitch: 'provider.switch',
} as const;

/** `OrchestrationV2Command` `dispatchMode.type` for `message.dispatch`. */
export const MESSAGE_DISPATCH_MODES = [
  'start_immediately',
  'defer_start',
  'steer_active',
  'restart_active',
  'queue_after_active',
] as const;
export type T3MessageDispatchMode = (typeof MESSAGE_DISPATCH_MODES)[number];

/** `OrchestrationV2ThreadLaunchWorkspaceStrategy` `type` literals. */
export const WORKSPACE_STRATEGY_TYPES = ['root', 'existing_worktree', 'worktree'] as const;
export type T3WorkspaceStrategyType = (typeof WORKSPACE_STRATEGY_TYPES)[number];

/** `OrchestrationV2RunStatus` has no `idle`; a shell thread can still be `idle`. */
export const SHELL_THREAD_STATUSES = ['idle', ...RUN_STATUSES] as const;

/** `OrchestrationV2Actor` (`orchestrationV2.ts`). */
export const CREATION_ACTORS = ['user', 'agent', 'system'] as const;
export type T3CreationActor = (typeof CREATION_ACTORS)[number];

/**
 * `OrchestrationV2CreationSource` (`orchestrationV2.ts`).
 *
 * Forgon is an external client of the T3 server, so it reports `web`, the same value T3's own
 * browser client sends. `server`/`provider`/`mcp` describe server-internal producers.
 */
export const CREATION_SOURCES = ['web', 'mobile', 'mcp', 'provider', 'server'] as const;
export type T3CreationSource = (typeof CREATION_SOURCES)[number];

/**
 * `DesktopBackendBootstrap` (`packages/contracts/src/desktopBootstrap.ts`), read by the server as
 * one JSON line from `--bootstrap-fd`. The Forgon sidecar manager writes this envelope, matching
 * the role T3's own desktop supervisor plays; it never reads the developer's live T3 state.
 */
export const desktopBootstrapSchema = z
  .object({
    mode: z.literal('desktop'),
    noBrowser: z.boolean(),
    port: z.number().int().positive(),
    t3Home: z.string().optional(),
    host: z.string(),
    desktopBootstrapToken: trimmedNonEmpty,
    desktopBootstrapSecret: z.string().optional(),
    shellEnvironmentPrepared: z.boolean().optional(),
    tailscaleServeEnabled: z.boolean(),
    tailscaleServePort: z.number().int().positive(),
  })
  .passthrough();
export type T3DesktopBootstrap = z.infer<typeof desktopBootstrapSchema>;

/**
 * Exit code a supervised T3 server uses when another process already owns the state directory
 * (`desktopBootstrap.ts`). The manager treats it as "do not restart".
 */
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;
