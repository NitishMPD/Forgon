/**
 * `@forgon/agent-service` public surface.
 *
 * The desktop worker calls `startAgentService` and receives one `AgentService` plus a `stop`.
 * That keeps two ownership rules in one place: the service never spawns a process, and the
 * sidecar manager never speaks the protocol. `connectT3` is the seam between them.
 */
import {
  connectT3,
  type AgentConnection,
  type FetchLike,
  type T3Connection,
  type WebSocketFactory,
} from '@forgon/agent-bridge';
import { startSidecar, type Sidecar, type SpawnFn, type StartSidecarOptions } from './sidecar.js';
import { createThreadRefStore, defaultThreadRefPath } from './persistence.js';
import { createAgentService, type AgentServiceFacade, type ResumeOutcome } from './service.js';
import type { T3Artifact } from './artifact.js';

export * from './artifact.js';
export * from './config.js';
export * from './config-runtime.js';
export * from './isolatedHome.js';
export * from './sidecar.js';
export * from './persistence.js';
export * from './service.js';
export { redactSecrets } from '@forgon/agent-bridge';

export interface StartAgentServiceOptions {
  readonly artifact: T3Artifact;
  readonly homeDir: string;
  readonly liveHomeDir?: string;
  readonly port: number;
  readonly host?: string;
  readonly nodePath?: string;
  readonly clientLabel?: string;
  readonly forgonEnforcesInspect?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnFn;
  readonly fetch?: FetchLike;
  readonly webSocketFactory?: WebSocketFactory;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
  readonly idPrefix?: string;
  readonly readinessTimeoutMs?: number;
  readonly onLog?: StartSidecarOptions['onLog'];
  readonly onWarning?: (message: string) => void;
  /**
   * Reattach every persisted thread on startup and stream its live events. Defaults to true; a
   * service that silently dropped a project's conversation across a restart would not be a resume.
   */
  readonly resumeOnStart?: boolean;
}

export interface RunningAgentService {
  readonly service: AgentServiceFacade;
  readonly sidecar: Sidecar;
  readonly connection: T3Connection;
  /** Browser-safe renderer facade: the service plus the last provider snapshot. */
  readonly agentConnection: AgentConnection;
  /** Outcomes of reattaching persisted threads at startup, when `resumeOnStart` ran. */
  readonly resume: readonly ResumeOutcome[];
  /** Stop the service, then the captured child, and resolve once it has exited. */
  stop(): Promise<void>;
}

/**
 * Start the isolated sidecar, connect over protocol v2, and return a ready `AgentService`.
 *
 * The readiness gate is inside `startSidecar` (descriptor advertises protocol 2), and `connectT3`
 * re-checks the version, so a mismatched server fails here rather than serving a half-open API.
 */
export const startAgentService = async (
  options: StartAgentServiceOptions,
): Promise<RunningAgentService> => {
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  const sidecar = await startSidecar({
    artifact: options.artifact,
    homeDir: options.homeDir,
    ...(options.liveHomeDir === undefined ? {} : { liveHomeDir: options.liveHomeDir }),
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    fetch: fetchFn,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  });

  let connection: T3Connection;
  try {
    connection = await connectT3({
      origin: sidecar.origin,
      fetch: fetchFn,
      bootstrapToken: sidecar.bootstrapToken,
      ...(options.clientLabel === undefined ? {} : { clientLabel: options.clientLabel }),
      ...(options.idPrefix === undefined ? {} : { idPrefix: options.idPrefix }),
      ...(options.webSocketFactory === undefined ? {} : { webSocketFactory: options.webSocketFactory }),
    });
  } catch (error) {
    sidecar.stop();
    throw error;
  }

  const store = createThreadRefStore({
    filePath: defaultThreadRefPath(sidecar.homeDir),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });

  const service = await createAgentService({
    connection,
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.forgonEnforcesInspect === undefined
      ? {}
      : { forgonEnforcesInspect: options.forgonEnforcesInspect }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });

  // T3 ships OpenCode disabled, but Forgon offers it as one of its three providers. This only touches
  // the isolated home's settings; a failure leaves OpenCode reported as disabled, not a dead service.
  try {
    await connection.orchestration.enableProvider({ instanceId: 'opencode', driver: 'opencode' });
  } catch (cause) {
    options.onWarning?.(
      `Could not enable OpenCode in the isolated T3 settings: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Discovery is best-effort at startup: a provider CLI that is missing is an unavailable
  // provider, not a failed service, so a refresh error is reported and the service still runs.
  try {
    await service.listProviders();
  } catch (cause) {
    options.onWarning?.(
      `Provider discovery failed at startup: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Reattach persisted threads after discovery, because a mapper needs a provider label. A
  // reattach failure is reported per thread and never blocks the service.
  let resume: readonly ResumeOutcome[] = [];
  if (options.resumeOnStart !== false) {
    try {
      resume = await service.reattachPersistedThreads();
    } catch (cause) {
      options.onWarning?.(
        `Thread reattach failed at startup: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  return {
    service,
    sidecar,
    connection,
    agentConnection: service.connection(),
    resume,
    stop: async () => {
      service.close();
      sidecar.stop();
      await sidecar.exited;
    },
  };
};
