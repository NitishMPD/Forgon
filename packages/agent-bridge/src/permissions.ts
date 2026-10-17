/**
 * Forgon `PermissionMode` → T3 `RuntimeMode`, with explicit honesty about what each mode buys.
 *
 * Source: packages/contracts/src/providerPolicy.ts. T3's `RuntimeMode` default is `full-access`,
 * and upstream's own documentation states the approval check is weaker than the provider's own
 * enforcement — approval is a UX gate, not a sandbox. `contracts.md` says the same: "Permission
 * labels alone confer no sandbox guarantee." So the mapping records the guarantee level instead
 * of implying safety from the label.
 *
 * `inspect` has no T3 equivalent and is refused rather than downgraded to the nearest mode:
 * silently sending `full-access` (T3's default) for a `inspect` request would be the exact
 * "faux security toggle" the build brief forbids.
 */
import type { PermissionMode } from '@forgon/project-schema';
import type { T3RuntimeMode } from './protocol.js';
import { unsupportedPermissionMode } from './errors.js';

export const FORGON_PERMISSION_MODES: readonly PermissionMode[] = [
  'inspect',
  'supervised',
  'auto-edits',
  'full-local',
];

export const isForgonPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (FORGON_PERMISSION_MODES as readonly string[]).includes(value);

/** What the delegation actually guarantees, independent of the label. */
export type PermissionGuarantee =
  | 't3-ux-gate-only'
  | 'provider-own-policy'
  | 'forgon-enforced-read-only';

export interface PermissionMapping {
  readonly mode: PermissionMode;
  readonly delegatedToT3: boolean;
  readonly runtimeMode: T3RuntimeMode;
  readonly guarantee: PermissionGuarantee;
  /**
   * Always present so a UI can state the limit. T3 approval is a UX gate; Forgon's cwd
   * containment does not constrain arbitrary child processes (see docs/research/agent-implementation.md).
   */
  readonly caveat: string;
}

const T3_UX_GATE_CAVEAT =
  'T3 approval is a UX gate, not a sandbox: the provider still runs under its own policy. Forgon cannot guarantee containment of arbitrary child processes.';

const delegatedMapping = (mode: PermissionMode, runtimeMode: T3RuntimeMode): PermissionMapping => ({
  mode,
  delegatedToT3: true,
  runtimeMode,
  guarantee: 't3-ux-gate-only',
  caveat: T3_UX_GATE_CAVEAT,
});

/**
 * Map a Forgon permission mode to what the bridge will actually ask T3 for.
 *
 * `inspect` throws unless the caller supplies a Forgon-side read-only enforcer, because the
 * bridge cannot make T3 read-only and must not pretend otherwise.
 */
export const mapPermissionMode = (
  mode: string,
  options?: { readonly forgonEnforcesInspect?: boolean },
): PermissionMapping => {
  if (!isForgonPermissionMode(mode)) {
    throw unsupportedPermissionMode(mode, `"${mode}" is not a Forgon permission mode.`);
  }
  switch (mode) {
    case 'supervised':
      return delegatedMapping('supervised', 'approval-required');
    case 'auto-edits':
      return delegatedMapping('auto-edits', 'auto-accept-edits');
    case 'full-local':
      return delegatedMapping('full-local', 'full-access');
    case 'inspect':
      if (options?.forgonEnforcesInspect !== true) {
        throw unsupportedPermissionMode(
          'inspect',
          'inspect is read-only intent with no T3 equivalent. T3 would run full-access by default, so the bridge refuses to start instead of silently granting write access.',
        );
      }
      return {
        mode: 'inspect',
        delegatedToT3: false,
        runtimeMode: 'approval-required',
        guarantee: 'forgon-enforced-read-only',
        caveat:
          'inspect is enforced by Forgon-side controls (read-only tool set), not by T3. T3 itself is still asked for approval-required so a write cannot slip through unreviewed.',
      };
  }
};

/**
 * T3 `RuntimeMode` values are a superset of what Forgon asks for. Report the ones Forgon cannot
 * reach as unsupported controls rather than exposing them.
 */
export const forgonUnreachableT3RuntimeModes = (): readonly T3RuntimeMode[] => ['auto'];
