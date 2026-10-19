/**
 * Browser-safe agent connection contract shared by the desktop host and the renderer.
 *
 * This module must stay free of `node:*` imports: the UI bundle imports it, and the renderer
 * cannot pull in `node:path` or the persistence layer. It defines only the shape the UI consumes
 * and a pure factory; the live `AgentService` may be a real object (desktop host) or an IPC/RPC
 * proxy with the same method names (renderer). It stays structurally compatible with the UI's own
 * `AgentConnection`/`AgentProviderInfo` declarations in `packages/editor-ui/src/services.ts`.
 */
import type { AgentService, PermissionMode, ProviderId } from '@forgon/project-schema';

/** Readiness is a verdict about routing, not a guess: `not-ready` always carries a reason. */
export type ProviderReadiness = 'ready' | 'not-ready' | 'unknown';

export interface AgentProviderInfo {
  readonly id: ProviderId;
  readonly name: string;
  readonly readiness: ProviderReadiness;
  /** Present when `readiness !== 'ready'`: why the provider cannot take work right now. */
  readonly message?: string;
  /** Model ids the adapter reports. Empty means the adapter reported none; never invented. */
  readonly models: readonly string[];
  modelOptions?: Readonly<Record<string, readonly import('@forgon/project-schema').AgentModelOption[]>>;
  defaultModel?: string;
  /**
   * Permission modes that are actually enforceable over this connection. `inspect` is included
   * only when Forgon enforces it (see `mapPermissionMode`); a mode the bridge cannot honor is
   * never listed just because the UI can render a label for it.
   */
  readonly permissionModes: readonly PermissionMode[];
  /** Plain-word limits the adapter reports. Absent means the adapter reported nothing. */
  readonly limits?: readonly string[];
}

export interface AgentConnection {
  readonly service: AgentService;
  /** Force a provider refresh and return the new snapshot. Optional: not every host supports it. */
  refreshProviders?: () => Promise<readonly AgentProviderInfo[]>;
  readonly providers: readonly AgentProviderInfo[];
}

/**
 * Permission modes the connection can actually enforce.
 *
 * `inspect` has no T3 equivalent and is refused unless Forgon supplies a read-only enforcement
 * layer, so the default list excludes it. Exposing it in the UI without that layer would make a
 * permission label stand in for a boundary it does not create.
 */
export const permissionModesForConnection = (options?: {
  readonly forgonEnforcesInspect?: boolean;
}): readonly PermissionMode[] =>
  options?.forgonEnforcesInspect === true
    ? ['inspect', 'supervised', 'auto-edits', 'auto', 'full-local']
    : ['supervised', 'auto-edits', 'auto', 'full-local'];

export interface AgentConnectionInput {
  readonly service: AgentService;
  readonly providers: readonly AgentProviderInfo[];
  readonly refreshProviders?: () => Promise<readonly AgentProviderInfo[]>;
}

/**
 * Build the renderer-facing connection from an already-running service and its last provider
 * snapshot. Kept trivial on purpose: the interesting behavior is in discovery (`listProviders`),
 * not in this wrapper, and an IPC host can reconstruct the same object from plain data.
 */
export const createAgentConnection = (input: AgentConnectionInput): AgentConnection => ({
  service: input.service,
  providers: input.providers,
  ...(input.refreshProviders === undefined ? {} : { refreshProviders: input.refreshProviders }),
});
