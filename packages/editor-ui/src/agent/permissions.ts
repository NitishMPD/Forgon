import type { PermissionMode } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';

export const permissionLabels: Record<PermissionMode, string> = {
  inspect: 'Inspect',
  supervised: 'Supervised',
  'auto-edits': 'Auto edits',
  'full-local': 'Full local',
};

// What each mode asks for. None of them is an operating-system sandbox, and none of them can
// guarantee what a provider CLI does beyond the requests and reports Forgon actually receives.
export const permissionDescriptions: Record<PermissionMode, string> = {
  inspect: 'Asks the provider for read-only access. Forgon refuses writes it can intercept. This is not an operating-system sandbox.',
  supervised: 'Asks for approval before each request Forgon receives. Forgon cannot see provider actions that are not reported to it.',
  'auto-edits': 'Lets the provider edit project files without asking. Forgon cannot limit edits beyond what the provider reports.',
  'full-local': 'No approval prompts. Once a provider CLI is running, Forgon cannot limit what it does. Choose this only on projects you trust.',
};

export function enforcementNote(mode: PermissionMode): string {
  return permissionDescriptions[mode];
}

// Limits the provider adapter reported. Silence is shown as unverified, never as safe.
export function providerLimitsNote(provider: Pick<AgentProviderInfo, 'limits'>): string {
  if (provider.limits === undefined || provider.limits.length === 0) {
    return 'The provider did not report its limits. Treat every permission mode as unverified.';
  }
  return provider.limits.join(' ');
}

// Never picks full-local on the user's behalf. Returns null when no safer mode is supported,
// so the user has to choose a mode explicitly.
const safeOrder: readonly PermissionMode[] = ['supervised', 'inspect', 'auto-edits'];

export function defaultPermissionMode(supported: readonly PermissionMode[]): PermissionMode | null {
  return safeOrder.find(mode => supported.includes(mode)) ?? null;
}
