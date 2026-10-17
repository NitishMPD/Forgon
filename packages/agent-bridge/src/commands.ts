/**
 * Builders for the `OrchestrationV2Command` payloads the bridge dispatches.
 *
 * Every field name is transcribed from the audited `OrchestrationV2Command` union in
 * `packages/contracts/src/orchestrationV2.ts` at the pinned revision (LICENSES/t3code.txt).
 * These functions only *build* payloads; they never send them, so a test can assert the exact
 * command a bridge call would dispatch without a live server.
 *
 * Deliberate omissions:
 *  - `thread.stop` and the other server-only commands are not here: they are not in the
 *    client-dispatchable union.
 *  - No `runtimeMode` is defaulted anywhere. A caller must supply the mapped `RuntimeMode`;
 *    the bridge never silently picks T3's `full-access` default.
 */
import {
  COMMAND_TYPES,
  type T3ApprovalDecision,
  type T3CreationActor,
  type T3CreationSource,
  type T3MessageDispatchMode,
} from './protocol.js';
import type { AgentContext } from '@forgon/project-schema';

/** `OrchestrationV2CreationFields` = `{ createdBy, creationSource }`, both required. */
export interface T3CreationFields {
  readonly createdBy: T3CreationActor;
  readonly creationSource: T3CreationSource;
}

/** Generate a `CommandId`/`MessageId`. Injectable so tests are deterministic. */
export type IdFactory = (prefix: string) => string;

export const defaultIdFactory: IdFactory = (prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`;

/** The creation fields Forgon sends: an external client acting on the user's behalf. */
export const FORGON_CREATION: T3CreationFields = { createdBy: 'user', creationSource: 'web' };

/** Highest number of file references Forgon forwards; composer-context records cap at 200. */
export const MAX_CONTEXT_FILES = 50;

/** Max characters the composer context allows per label / path (`composerContext.ts`). */
const CONTEXT_LABEL_MAX = 200;
const CONTEXT_PATH_MAX = 2_048;

/**
 * `OrchestrationMessageContext` (`composerContext.ts`): `{ version: 1, records }`.
 *
 * Forgon file references become `mention` records (a path, not an uploaded attachment, so no
 * bytes cross the wire); the scene/entity/asset ids Forgon knows and T3 does not ride in one
 * `forgon-scene` record, which decodes through upstream's `UnknownContextRecord` because it is
 * not a known kind. Undecodable records are dropped by the server, never fatal, so a shape drift
 * degrades to "no structured context" rather than a failed turn.
 */
export interface T3MessageContext {
  readonly version: 1;
  readonly records: ReadonlyArray<unknown>;
}

export const buildMessageContext = (context: AgentContext): T3MessageContext | undefined => {
  const records: unknown[] = [];
  for (const [index, path] of context.files.slice(0, MAX_CONTEXT_FILES).entries()) {
    records.push({
      version: 1,
      contextId: `forgon-file-${index}`,
      label: path.slice(0, CONTEXT_LABEL_MAX),
      kind: 'mention',
      path: path.slice(0, CONTEXT_PATH_MAX),
    });
  }
  if (context.sceneId !== undefined || context.entityIds.length > 0 || context.assetIds.length > 0) {
    records.push({
      version: 1,
      contextId: 'forgon-scene',
      label: 'Forgon scene context',
      kind: 'forgon-scene',
      payload: {
        ...(context.sceneId === undefined ? {} : { sceneId: context.sceneId }),
        entityIds: context.entityIds,
        assetIds: context.assetIds,
      },
    });
  }
  return records.length === 0 ? undefined : { version: 1, records };
};

export interface MessageDispatchInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly commandId: string;
  readonly creation: T3CreationFields;
  /** `start_immediately` runs the turn now; the queue/steer modes alter a live run. */
  readonly dispatchMode?: T3MessageDispatchMode;
  readonly modelSelection?: { instanceId: string; model: string };
  /** Free-form context the provider sees; Forgon maps `AgentContext` into this. */
  readonly context?: unknown;
}

export interface T3Command {
  readonly type: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly [field: string]: unknown;
}

/** `message.dispatch` — submit a user turn (and, with `start_immediately`, start the run). */
export const buildMessageDispatch = (input: MessageDispatchInput): T3Command => ({
  type: COMMAND_TYPES.messageDispatch,
  ...input.creation,
  commandId: input.commandId,
  threadId: input.threadId,
  messageId: input.messageId,
  // `attachments` is a required array in the contract; Forgon's first cut sends none.
  attachments: [],
  text: input.text,
  dispatchMode: { type: input.dispatchMode ?? 'start_immediately' },
  ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
  ...(input.context === undefined ? {} : { context: input.context }),
});

/** `run.interrupt` — cancel the active run. This is the only client-side cancel path. */
export const buildRunInterrupt = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly reason?: string;
  readonly holdQueue?: boolean;
}): T3Command => ({
  type: COMMAND_TYPES.runInterrupt,
  commandId: input.commandId,
  threadId: input.threadId,
  runId: input.runId,
  ...(input.reason === undefined ? {} : { reason: input.reason }),
  ...(input.holdQueue === undefined ? {} : { holdQueue: input.holdQueue }),
});

/**
 * `runtime-request.respond` — answer an approval or user-input request.
 *
 * The `requestId` is bound to the pending action the server issued; the bridge never invents one.
 */
export const buildRuntimeRequestRespond = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly decision?: T3ApprovalDecision;
  readonly answers?: Record<string, unknown>;
}): T3Command => {
  if (input.decision === undefined && input.answers === undefined) {
    throw new Error('runtime-request.respond needs a decision or answers.');
  }
  return {
    type: COMMAND_TYPES.runtimeRequestRespond,
    commandId: input.commandId,
    threadId: input.threadId,
    requestId: input.requestId,
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(input.answers === undefined ? {} : { answers: input.answers }),
  };
};

/** `checkpoint.rollback` — rewind a checkpoint. `restoreFiles` must be opted into explicitly. */
export const buildCheckpointRollback = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly scopeId: string;
  readonly checkpointId: string;
  readonly restoreFiles: boolean;
}): T3Command => ({
  type: COMMAND_TYPES.checkpointRollback,
  commandId: input.commandId,
  threadId: input.threadId,
  scopeId: input.scopeId,
  checkpointId: input.checkpointId,
  restoreFiles: input.restoreFiles,
});

/** `thread.model-selection.set` — switch model on an existing thread. */
export const buildThreadModelSelectionSet = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly modelSelection: { instanceId: string; model: string };
}): T3Command => ({
  type: COMMAND_TYPES.threadModelSelectionSet,
  commandId: input.commandId,
  threadId: input.threadId,
  modelSelection: input.modelSelection,
});

/** `thread.runtime-mode.set` — change the live runtime mode. */
export const buildThreadRuntimeModeSet = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly runtimeMode: string;
}): T3Command => ({
  type: COMMAND_TYPES.threadRuntimeModeSet,
  commandId: input.commandId,
  threadId: input.threadId,
  runtimeMode: input.runtimeMode,
});

/** `thread.interaction-mode.set` — `default` or `plan`. */
export const buildThreadInteractionModeSet = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly interactionMode: 'default' | 'plan';
}): T3Command => ({
  type: COMMAND_TYPES.threadInteractionModeSet,
  commandId: input.commandId,
  threadId: input.threadId,
  interactionMode: input.interactionMode,
});

/** `provider.switch` — move a thread to another provider instance. */
export const buildProviderSwitch = (input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly modelSelection: { instanceId: string; model: string };
}): T3Command => ({
  type: COMMAND_TYPES.providerSwitch,
  commandId: input.commandId,
  threadId: input.threadId,
  modelSelection: input.modelSelection,
});

/**
 * Forgon `PermissionMode` → `ProviderApprovalDecision` for a one-shot approval answer.
 *
 * The five upstream decisions are distinct; Forgon only wants allow-once, allow-for-session and
 * deny. `acceptAlways` is intentionally not reachable from a Forgon `approve(...allow)` call
 * because it silently widens the grant for every future request.
 */
export const approvalDecisionFor = (allow: boolean): T3ApprovalDecision => (allow ? 'accept' : 'decline');

/** Forgon "allow for the rest of the session" → `acceptForSession`. */
export const sessionApprovalDecision = (): T3ApprovalDecision => 'acceptForSession';

/**
 * `OrchestrationV2ThreadLaunchWorkspaceStrategy`.
 *
 * Forgon's first cut always targets the project's own checkout (`root`), because a Forgon
 * project *is* the workspace and the desktop shell owns worktree creation. The other two
 * variants exist upstream and are exposed, not defaulted, so a caller cannot accidentally run an
 * agent in an unrelated worktree.
 */
export type T3WorkspaceStrategy =
  | { readonly type: 'root'; readonly branch?: string }
  | { readonly type: 'existing_worktree'; readonly worktreePath: string; readonly branch?: string }
  | {
      readonly type: 'worktree';
      readonly baseRef: string;
      readonly branch?: string;
      readonly startFromOrigin?: boolean;
    };

export interface LaunchThreadInput {
  readonly commandId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: { instanceId: string; model: string };
  /** Mapped from Forgon `PermissionMode`; never defaulted here. */
  readonly runtimeMode: string;
  readonly interactionMode: 'default' | 'plan';
  readonly workspaceStrategy: T3WorkspaceStrategy;
  /**
   * `OrchestrationV2ThreadLaunchInput.creationSource`. `createdBy` is deliberately absent: the
   * launch input schema has no `createdBy` field, and the server hardcodes `createdBy: "user"`
   * (apps/server/src/ws.ts). Sending it would be silently dropped.
   */
  readonly creationSource?: T3CreationSource;
  readonly threadId?: string;
  /**
   * `OrchestrationV2ThreadLaunchInput.reuseExistingThread`. When true and `threadId` already
   * exists, T3 reuses that durable thread instead of creating a new one; the result's `resumed`
   * flag reports which happened.
   */
  readonly reuseExistingThread?: boolean;
  readonly generateTitle?: boolean;
  readonly initialMessage?: {
    readonly messageId?: string;
    readonly text: string;
    readonly context?: unknown;
  };
}

/**
 * `orchestration.launchThread` payload (`OrchestrationV2ThreadLaunchInput`).
 *
 * Returns a plain object so the caller can assert it in a test; the RPC call is separate.
 */
export const buildLaunchThreadInput = (input: LaunchThreadInput): Record<string, unknown> => ({
  commandId: input.commandId,
  creationSource: input.creationSource ?? FORGON_CREATION.creationSource,
  projectId: input.projectId,
  title: input.title,
  modelSelection: input.modelSelection,
  runtimeMode: input.runtimeMode,
  interactionMode: input.interactionMode,
  workspaceStrategy: input.workspaceStrategy,
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.reuseExistingThread === undefined
    ? {}
    : { reuseExistingThread: input.reuseExistingThread }),
  ...(input.generateTitle === undefined ? {} : { generateTitle: input.generateTitle }),
  ...(input.initialMessage === undefined
    ? {}
    : {
        initialMessage: {
          text: input.initialMessage.text,
          attachments: [],
          ...(input.initialMessage.messageId === undefined
            ? {}
            : { messageId: input.initialMessage.messageId }),
          ...(input.initialMessage.context === undefined
            ? {}
            : { context: input.initialMessage.context }),
        },
      }),
});
