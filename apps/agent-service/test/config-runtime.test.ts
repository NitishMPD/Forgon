import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentBridgeError } from '@forgon/agent-bridge';
import { T3_NODE_RANGE, assertCompatibleT3Node, describeT3NodeRequirement, satisfiesT3Node } from '../src/index.js';

test('satisfiesT3Node accepts exactly the pinned t3 engines range', () => {
  for (const version of ['22.16.0', '22.20.1', '23.11.0', '23.20.5', '24.10.0', '24.13.1', '25.0.0', '26.3.0', 'v24.13.1']) {
    assert.equal(satisfiesT3Node(version), true, `expected ${version} to satisfy ${T3_NODE_RANGE}`);
  }
});

test('satisfiesT3Node refuses versions below every range bound', () => {
  for (const version of ['20.19.0', '21.7.0', '22.15.9', '23.10.0', '24.0.0', '24.2.0', '24.9.9', '17.0.0']) {
    assert.equal(satisfiesT3Node(version), false, `expected ${version} to fail ${T3_NODE_RANGE}`);
  }
});

test('an unparseable runtime version is never assumed compatible', () => {
  for (const version of ['', '  ', 'not-a-version', '24', 'v24.13', 'abc.1.2']) {
    assert.equal(satisfiesT3Node(version), false, `expected ${JSON.stringify(version)} to fail`);
  }
});

test('assertCompatibleT3Node names the observed version and the requirement', () => {
  assert.doesNotThrow(() => assertCompatibleT3Node('24.13.1', 'C:/ignored/node.exe'));
  assert.throws(
    () => assertCompatibleT3Node('24.2.0', 'C:/ignored/node.exe'),
    (error: unknown): error is Error =>
      isAgentBridgeError(error) &&
      error.code === 'sidecar_unavailable' &&
      error.detail?.includes('24.2.0') === true &&
      error.detail?.includes(T3_NODE_RANGE) === true &&
      error.detail?.includes('C:/ignored/node.exe') === true,
  );
});

test('describeT3NodeRequirement states the range', () => {
  assert.ok(describeT3NodeRequirement().includes(T3_NODE_RANGE));
});
