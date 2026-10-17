import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableForgonProviders,
  defaultInstanceIdForDriver,
  enforceablePermissionModes,
  forgonPermissionModeForRuntimeMode,
  forgonProviderForDriver,
  isAgentBridgeError,
  isForgonProviderId,
  resolveProviderRoute,
  type T3ServerProvider,
} from '../src/index.js';

const provider = (overrides: Partial<T3ServerProvider> & Pick<T3ServerProvider, 'instanceId' | 'driver'>): T3ServerProvider => ({
  enabled: true,
  installed: true,
  version: '1.0.0',
  ...overrides,
});

test('resolveProviderRoute falls back to the driver default instance id', () => {
  const route = resolveProviderRoute({ provider: 'codex', model: 'gpt-5' });
  assert.deepEqual(route, {
    provider: 'codex',
    driver: 'codex',
    instanceId: 'codex',
    model: 'gpt-5',
    discovered: false,
  });
});

test('claude-code routes to the claudeAgent driver', () => {
  assert.equal(resolveProviderRoute({ provider: 'claude-code', model: 'sonnet' }).driver, 'claudeAgent');
});

test('opencode routes to its own driver', () => {
  assert.equal(resolveProviderRoute({ provider: 'opencode', model: 'm' }).driver, 'opencode');
});

test('a discovered enabled instance wins over the default id', () => {
  const route = resolveProviderRoute({
    provider: 'codex',
    model: 'gpt-5',
    discoveredProviders: [provider({ instanceId: 'codex-work', driver: 'codex' })],
  });
  assert.equal(route.instanceId, 'codex-work');
  assert.equal(route.discovered, true);
});

test('a disabled discovered instance is ignored', () => {
  const route = resolveProviderRoute({
    provider: 'codex',
    model: 'gpt-5',
    discoveredProviders: [provider({ instanceId: 'codex-off', driver: 'codex', enabled: false })],
  });
  assert.equal(route.instanceId, 'codex');
  assert.equal(route.discovered, false);
});

test('an unsupported provider is refused rather than substituted', () => {
  assert.throws(
    () => resolveProviderRoute({ provider: 'gemini', model: 'x' }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'unsupported_provider',
  );
});

test('an empty model is refused', () => {
  assert.throws(
    () => resolveProviderRoute({ provider: 'codex', model: '  ' }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'unsupported_provider',
  );
});

test('availableForgonProviders filters to enabled and installed adapters', () => {
  const available = availableForgonProviders([
    provider({ instanceId: 'codex', driver: 'codex' }),
    provider({ instanceId: 'claude', driver: 'claudeAgent', installed: false }),
    provider({ instanceId: 'opencode', driver: 'opencode', enabled: false }),
    provider({ instanceId: 'unknown', driver: 'gemini' }),
  ]);
  assert.deepEqual(available, ['codex']);
});

test('forgonProviderForDriver inverts the driver map', () => {
  assert.equal(forgonProviderForDriver('claudeAgent'), 'claude-code');
  assert.equal(forgonProviderForDriver('codex'), 'codex');
  assert.equal(forgonProviderForDriver('gemini'), undefined);
});

test('defaultInstanceIdForDriver is the driver kind', () => {
  assert.equal(defaultInstanceIdForDriver('claudeAgent'), 'claudeAgent');
});

test('isForgonProviderId accepts only the three Forgon names', () => {
  assert.equal(isForgonProviderId('claude-code'), true);
  assert.equal(isForgonProviderId('claudeAgent'), false);
});

test('forgonPermissionModeForRuntimeMode maps the three shared modes and refuses T3 auto', () => {
  assert.equal(forgonPermissionModeForRuntimeMode('approval-required'), 'supervised');
  assert.equal(forgonPermissionModeForRuntimeMode('auto-accept-edits'), 'auto-edits');
  assert.equal(forgonPermissionModeForRuntimeMode('full-access'), 'full-local');
  assert.equal(forgonPermissionModeForRuntimeMode('auto'), undefined);
  assert.equal(forgonPermissionModeForRuntimeMode('nonsense'), undefined);
});

test('enforceablePermissionModes keeps the connection default when the adapter reports nothing', () => {
  const connectionModes = ['supervised', 'auto-edits', 'full-local'] as const;
  assert.deepEqual(enforceablePermissionModes({ connectionModes }), [...connectionModes]);
  assert.deepEqual(enforceablePermissionModes({ discovered: {}, connectionModes }), [...connectionModes]);
});

test('enforceablePermissionModes drops modes the adapter cannot run and never adds inspect', () => {
  const connectionModes = ['supervised', 'auto-edits', 'full-local'] as const;
  assert.deepEqual(
    enforceablePermissionModes({
      discovered: { supportedRuntimeModes: ['approval-required', 'full-access'] },
      connectionModes,
    }),
    ['supervised', 'full-local'],
  );
  // A mode list the adapter reports without a Forgon mapping leaves nothing enforceable.
  assert.deepEqual(
    enforceablePermissionModes({ discovered: { supportedRuntimeModes: ['auto'] }, connectionModes }),
    [],
  );
  // inspect survives the intersection only when the connection already carries it.
  assert.deepEqual(
    enforceablePermissionModes({
      discovered: { supportedRuntimeModes: ['approval-required'] },
      connectionModes: ['inspect', 'supervised', 'auto-edits', 'full-local'],
    }),
    ['inspect', 'supervised'],
  );
});
