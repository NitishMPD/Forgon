import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isAgentBridgeError } from '@forgon/agent-bridge';
import { assertIsolatedHome, defaultLiveHomeDir, isStrictlyInside } from '../src/index.js';

const containment = (error: unknown): boolean =>
  isAgentBridgeError(error) && error.code === 'containment_violation';

const LIVE = path.resolve('C:/users/dev/.t3');

test('defaultLiveHomeDir ends with the .t3 folder', () => {
  assert.equal(path.basename(defaultLiveHomeDir()), '.t3');
});

test('isStrictlyInside is true only for a real descendant', () => {
  assert.equal(isStrictlyInside(LIVE, path.join(LIVE, 'nested')), true);
  assert.equal(isStrictlyInside(LIVE, LIVE), false);
  assert.equal(isStrictlyInside(LIVE, path.resolve('C:/other')), false);
});

test('an isolated sibling directory is accepted', () => {
  const isolated = assertIsolatedHome({
    homeDir: path.resolve('C:/forgon/state/t3'),
    liveHomeDir: LIVE,
  });
  assert.equal(isolated.homeDir, path.resolve('C:/forgon/state/t3'));
  assert.equal(isolated.liveHomeDir, LIVE);
});

test('a relative home directory is refused', () => {
  assert.throws(() => assertIsolatedHome({ homeDir: 'state/t3', liveHomeDir: LIVE }), containment);
});

test('the live home itself is refused', () => {
  assert.throws(() => assertIsolatedHome({ homeDir: LIVE, liveHomeDir: LIVE }), containment);
});

test('a directory inside the live home is refused', () => {
  assert.throws(
    () => assertIsolatedHome({ homeDir: path.join(LIVE, 'sidecar'), liveHomeDir: LIVE }),
    containment,
  );
});

test('a directory that contains the live home is refused', () => {
  assert.throws(
    () => assertIsolatedHome({ homeDir: path.dirname(LIVE), liveHomeDir: LIVE }),
    containment,
  );
});

test('a filesystem root is refused', () => {
  const root = path.parse(path.resolve('C:/users/dev/.t3')).root;
  assert.throws(() => assertIsolatedHome({ homeDir: root, liveHomeDir: LIVE }), containment);
});
