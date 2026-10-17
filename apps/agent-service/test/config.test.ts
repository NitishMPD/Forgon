import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentBridgeError, type AgentBridgeError } from '@forgon/agent-bridge';
import {
  AGENT_SERVICE_CONFIG_MAX_BYTES,
  loadAgentServiceConfig,
  parseAgentServiceConfig,
  type ConfigIo,
} from '../src/index.js';

const DIGEST = 'a'.repeat(64);
const ENTRY = 'C:/forgon/t3/dist/bin.mjs';
const validConfig = () => ({
  port: 3777,
  artifact: {
    entryPath: ENTRY,
    expectedSha256: DIGEST,
    expectedServerVersion: '1.0.0',
  },
});

const expectFailure = (error: unknown, needle: string): error is AgentBridgeError => {
  assert.ok(isAgentBridgeError(error), 'expected an AgentBridgeError');
  assert.equal(error.code, 'invalid_configuration');
  assert.ok(error.detail?.includes(needle) === true, `expected detail to mention ${JSON.stringify(needle)}; got ${error.detail}`);
  return true;
};

test('parseAgentServiceConfig accepts the descriptor the desktop bridge reads', () => {
  const parsed = parseAgentServiceConfig(validConfig());
  assert.equal(parsed.port, 3777);
  assert.equal(parsed.artifact.entryPath, ENTRY);
  assert.equal(parsed.artifact.expectedSha256, DIGEST);
  assert.equal(parsed.artifact.expectedServerVersion, '1.0.0');
});

test('parseAgentServiceConfig accepts a full bundle manifest and an uppercase digest', () => {
  const parsed = parseAgentServiceConfig({
    port: 65535,
    artifact: {
      entryPath: ENTRY,
      expectedSha256: DIGEST.toUpperCase(),
      kind: 'node-script',
      bundle: [
        { path: 'bin.mjs', sha256: DIGEST },
        { path: 'binCli-CsDHl451.mjs', sha256: 'b'.repeat(64) },
      ],
    },
  });
  assert.equal(parsed.artifact.bundle?.length, 2);
  assert.equal(parsed.artifact.kind, 'node-script');
});

test('parseAgentServiceConfig requires the entry path to be absolute', () => {
  assert.throws(
    () => parseAgentServiceConfig({ ...validConfig(), artifact: { entryPath: 'dist/bin.mjs', expectedSha256: DIGEST } }),
    (error: unknown) => expectFailure(error, 'must be absolute'),
  );
});

test('parseAgentServiceConfig bounds the port', () => {
  for (const port of [0, -1, 65_536, 1.5, 3777.5]) {
    assert.throws(
      () => parseAgentServiceConfig({ ...validConfig(), port }),
      (error: unknown) => isAgentBridgeError(error) && error.code === 'invalid_configuration',
      `expected port ${port} to be refused`,
    );
  }
});

test('parseAgentServiceConfig refuses a malformed digest', () => {
  for (const digest of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63), ` ${DIGEST} `]) {
    assert.throws(
      () => parseAgentServiceConfig({ ...validConfig(), artifact: { entryPath: ENTRY, expectedSha256: digest } }),
      (error: unknown) => isAgentBridgeError(error) && error.code === 'invalid_configuration',
      `expected digest ${JSON.stringify(digest)} to be refused`,
    );
  }
});

test('parseAgentServiceConfig refuses unknown fields so a typo is not silently ignored', () => {
  assert.throws(
    () => parseAgentServiceConfig({ ...validConfig(), artfiact: {} }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'invalid_configuration',
  );
  assert.throws(
    () => parseAgentServiceConfig({ ...validConfig(), artifact: { entryPath: ENTRY, expectedSHA256: DIGEST } }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'invalid_configuration',
  );
});

test('parseAgentServiceConfig refuses an empty or malformed bundle manifest', () => {
  assert.throws(
    () => parseAgentServiceConfig({ ...validConfig(), artifact: { entryPath: ENTRY, expectedSha256: DIGEST, bundle: [] } }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'invalid_configuration',
  );
  assert.throws(
    () =>
      parseAgentServiceConfig({
        ...validConfig(),
        artifact: { entryPath: ENTRY, expectedSha256: DIGEST, bundle: [{ path: 'bin.mjs', sha256: 'nope' }] },
      }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'invalid_configuration',
  );
});

test('loadAgentServiceConfig reads and parses through an injected reader', async () => {
  const io: ConfigIo = { read: async (filePath) => {
    assert.equal(filePath, 'C:/forgon/agent.json');
    return new TextEncoder().encode(JSON.stringify(validConfig()));
  } };
  const parsed = await loadAgentServiceConfig('C:/forgon/agent.json', io);
  assert.equal(parsed.port, 3777);
  assert.equal(parsed.artifact.entryPath, ENTRY);
});

test('loadAgentServiceConfig refuses a relative configuration path', async () => {
  await assert.rejects(
    loadAgentServiceConfig('agent.json', { read: async () => new Uint8Array() }),
    (error: unknown) => expectFailure(error, 'must be absolute'),
  );
});

test('loadAgentServiceConfig reports an unreadable file and invalid JSON distinctly', async () => {
  await assert.rejects(
    loadAgentServiceConfig('C:/forgon/agent.json', {
      read: async () => {
        throw new Error('ENOENT');
      },
    }),
    (error: unknown) => expectFailure(error, 'could not be read'),
  );
  await assert.rejects(
    loadAgentServiceConfig('C:/forgon/agent.json', { read: async () => new TextEncoder().encode('{ not json') }),
    (error: unknown) => expectFailure(error, 'not valid JSON'),
  );
});

test('loadAgentServiceConfig refuses a file over the size limit', async () => {
  await assert.rejects(
    loadAgentServiceConfig('C:/forgon/agent.json', {
      read: async () => new Uint8Array(AGENT_SERVICE_CONFIG_MAX_BYTES + 1),
    }),
    (error: unknown) => expectFailure(error, 'over the'),
  );
});
