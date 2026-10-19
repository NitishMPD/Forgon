import type { PermissionMode } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';

export const permissionLabels: Record<PermissionMode, string> = {
  inspect: 'Inspect',
  supervised: 'Supervised',
  'auto-edits': 'Auto-accept edits',
  auto: 'Auto',
  'full-local': 'Full access',
};

// What each mode asks for. None of them is an operating-system sandbox, and none of them can
// guarantee what a provider CLI does beyond the requests and reports Forgon actually receives.
export const permissionDescriptions: Record<PermissionMode, string> = {
  inspect: 'Read-only tools. Project changes are blocked.',
  supervised: 'Ask before commands and file changes.',
  'auto-edits': 'Auto-approve edits, ask before other actions.',
  auto: 'Supported providers approve routine actions; others still ask.',
  'full-local': 'Allow commands and edits without permission prompts.',
};

export function enforcementNote(mode: PermissionMode): string {
  return `${permissionDescriptions[mode]} Permission modes are not an operating-system sandbox. ${mode === 'supervised' ? 'Forgon cannot see provider actions that are not reported to it.' : 'Once an agent is running, Forgon cannot limit what it does beyond reported actions.'}`;
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
