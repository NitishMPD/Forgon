/**
 * Forgon `ProviderId` → T3 provider routing.
 *
 * Forgon names: `codex`, `opencode`, `claude-code` (packages/project-schema/src/boundaries.ts).
 * T3 driver kinds are runtime-registered slugs (packages/contracts/src/providerInstance.ts),
 * so the driver names here come from the audited `apps/server` driver registrations, not from
 * Forgon's own enum.
 */
import type { PermissionMode, ProviderId } from '@forgon/project-schema';
import { AgentBridgeError, unsupportedProvider } from './errors.js';
import type { T3ServerProvider } from './protocol.js';

export const FORGON_PROVIDER_IDS: readonly ProviderId[] = ['codex', 'opencode', 'claude-code'];

/** Forgon label → T3 driver kind. `claude-code` is Forgon's name for T3's `claudeAgent`. */
const DRIVER_KIND_BY_PROVIDER: Record<ProviderId, string> = {
  codex: 'codex',
  opencode: 'opencode',
  'claude-code': 'claudeAgent',
};

/**
 * The default instance id for a driver is the driver kind itself
 * (`defaultInstanceIdForDriver`, packages/contracts/src/providerInstance.ts), which is how
 * the pre-multi-instance world addressed providers. A discovered instance always wins.
 */
export const defaultInstanceIdForDriver = (driver: string): string => driver;

export const isForgonProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && (FORGON_PROVIDER_IDS as readonly string[]).includes(value);

/** Reverse of the driver map, for reading a discovered `ServerProvider.driver` back to Forgon. */
export const forgonProviderForDriver = (driver: string): ProviderId | undefined =>
  FORGON_PROVIDER_IDS.find((provider) => DRIVER_KIND_BY_PROVIDER[provider] === driver);

export interface ProviderRoute {
  readonly provider: ProviderId;
  readonly driver: string;
  readonly instanceId: string;
  readonly model: string;
  /** True when `instanceId` came from a discovered provider snapshot rather than the default. */
  readonly discovered: boolean;
}

/**
 * Resolve a Forgon provider + model to a T3 `ModelSelection`.
 *
 * Rejects any provider outside Forgon's three. The bridge never silently substitutes a
 * different provider: an unknown or missing provider is an explicit failure.
 */
export const resolveProviderRoute = (input: {
  provider: string;
  model: string;
  discoveredProviders?: readonly T3ServerProvider[];
}): ProviderRoute => {
  if (!isForgonProviderId(input.provider)) throw unsupportedProvider(input.provider);
  if (input.model.trim().length === 0) {
    throw new AgentBridgeError('unsupported_provider', `A model must be chosen for ${input.provider}.`);
  }
  const driver = DRIVER_KIND_BY_PROVIDER[input.provider];
  const discovered = (input.discoveredProviders ?? []).find(
    (candidate) => candidate.driver === driver && candidate.enabled && candidate.installed,
  );
  return {
    provider: input.provider,
    driver,
    instanceId: discovered?.instanceId ?? defaultInstanceIdForDriver(driver),
    model: input.model,
    discovered: discovered !== undefined,
  };
};

/** Which Forgon providers a set of discovered T3 providers can serve. */
export const availableForgonProviders = (
  discoveredProviders: readonly T3ServerProvider[],
): readonly ProviderId[] =>
  FORGON_PROVIDER_IDS.filter((provider) =>
    discoveredProviders.some(
      (candidate) =>
        candidate.driver === DRIVER_KIND_BY_PROVIDER[provider] && candidate.enabled && candidate.installed,
    ),
  );

/**
 * Reverse of `mapPermissionMode`'s runtime-mode column: which Forgon mode a T3 `RuntimeMode`
 * actually satisfies. Unknown modes are never advertised as controls.
 */
export const forgonPermissionModeForRuntimeMode = (mode: string): PermissionMode | undefined => {
  switch (mode) {
    case 'approval-required':
      return 'supervised';
    case 'auto-accept-edits':
      return 'auto-edits';
    case 'auto':
      return 'auto';
    case 'full-access':
      return 'full-local';
    default:
      return undefined;
  }
};

/**
 * The modes a discovered provider can actually run, intersected with what the connection can
 * enforce.
 *
 * When the adapter reports `supportedRuntimeModes`, only the modes those runtimes map to are
 * advertised; an adapter that does not support a runtime must not be handed it. When the adapter
 * reports nothing, upstream's own default (`full-access`) is the only fact the bridge has, so the
 * connection's default set is kept. `inspect` is added only when Forgon enforces it.
 */
export const enforceablePermissionModes = (input: {
  readonly discovered?: Pick<T3ServerProvider, 'supportedRuntimeModes'>;
  readonly connectionModes: readonly PermissionMode[];
}): readonly PermissionMode[] => {
  const supported = input.discovered?.supportedRuntimeModes;
  if (supported === undefined) return input.connectionModes;
  const granted = new Set(supported.map((mode) => forgonPermissionModeForRuntimeMode(mode)));
  return input.connectionModes.filter(
    (mode) => mode === 'inspect' || granted.has(mode),
  );
};
