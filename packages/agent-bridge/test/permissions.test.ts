import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGON_PERMISSION_MODES,
  isAgentBridgeError,
  isForgonPermissionMode,
  mapPermissionMode,
  forgonUnreachableT3RuntimeModes,
} from '../src/index.js';

test('supervised maps to approval-required and is delegated to T3', () => {
  const mapping = mapPermissionMode('supervised');
  assert.equal(mapping.runtimeMode, 'approval-required');
  assert.equal(mapping.delegatedToT3, true);
  assert.equal(mapping.guarantee, 't3-ux-gate-only');
  assert.match(mapping.caveat, /not a sandbox/i);
});

test('auto-edits maps to auto-accept-edits', () => {
  assert.equal(mapPermissionMode('auto-edits').runtimeMode, 'auto-accept-edits');
});

test('full-local maps to full-access', () => {
  assert.equal(mapPermissionMode('full-local').runtimeMode, 'full-access');
});

test('inspect is refused without a Forgon-side read-only enforcer', () => {
  assert.throws(
    () => mapPermissionMode('inspect'),
    (error: unknown) =>
      isAgentBridgeError(error) && error.code === 'unsupported_permission_mode',
  );
});

test('inspect is allowed only when Forgon enforces it, and is not delegated to T3', () => {
  const mapping = mapPermissionMode('inspect', { forgonEnforcesInspect: true });
  assert.equal(mapping.delegatedToT3, false);
  assert.equal(mapping.guarantee, 'forgon-enforced-read-only');
  assert.equal(mapping.runtimeMode, 'approval-required');
});

test('an unknown permission mode is refused', () => {
  assert.throws(
    () => mapPermissionMode('yolo'),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'unsupported_permission_mode',
  );
});

test('isForgonPermissionMode narrows the supported Forgon modes', () => {
  for (const mode of FORGON_PERMISSION_MODES) assert.equal(isForgonPermissionMode(mode), true);
  assert.equal(isForgonPermissionMode('auto'), true);
});

test('Auto maps to the native automatic permission mode', () => {
  assert.equal(mapPermissionMode('auto').runtimeMode, 'auto');
  assert.deepEqual(forgonUnreachableT3RuntimeModes(), []);
});
