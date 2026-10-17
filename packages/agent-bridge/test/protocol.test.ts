import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_TYPES,
  DEFAULT_RUNTIME_MODE,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  PROVIDER_APPROVAL_DECISIONS,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
  WEBSOCKET_TICKET_QUERY_PARAM,
  desktopBootstrapSchema,
  executionEnvironmentDescriptorSchema,
  isTerminalRunStatus,
  runSchema,
  serverProviderSchema,
  threadStreamItemSchema,
  turnItemSchema,
} from '../src/index.js';

test('the pinned protocol version is 2 and its query text is "2"', () => {
  assert.equal(ORCHESTRATION_PROTOCOL_VERSION, 2);
  assert.equal(ORCHESTRATION_PROTOCOL_VERSION_TEXT, '2');
  assert.equal(WEBSOCKET_TICKET_QUERY_PARAM, 'wsTicket');
});

test('only terminal run statuses are terminal', () => {
  assert.equal(isTerminalRunStatus('running'), false);
  assert.equal(isTerminalRunStatus('completed'), true);
  assert.equal(isTerminalRunStatus('rolled_back'), true);
  assert.equal(isTerminalRunStatus('cancelled'), true);
});

test('server-only commands are absent from the client command set', () => {
  assert.equal((Object.values(COMMAND_TYPES) as readonly string[]).includes('thread.stop'), false);
  assert.equal(COMMAND_TYPES.runInterrupt, 'run.interrupt');
});

test('T3 default runtime mode is full-access and acceptAlways exists but is not Forgon-reachable', () => {
  assert.equal(DEFAULT_RUNTIME_MODE, 'full-access');
  assert.equal((PROVIDER_APPROVAL_DECISIONS as readonly string[]).includes('acceptAlways'), true);
});

test('the environment descriptor requires an orchestration protocol version to be meaningful', () => {
  const withoutVersion = {
    environmentId: 'env-1',
    label: 'Local',
    platform: { os: 'windows', arch: 'x64' },
    serverVersion: '1.0.0',
    capabilities: {},
  };
  assert.deepEqual(executionEnvironmentDescriptorSchema.parse(withoutVersion).orchestrationProtocolVersion, undefined);

  const ok = { ...withoutVersion, orchestrationProtocolVersion: 2 };
  assert.equal(executionEnvironmentDescriptorSchema.parse(ok).orchestrationProtocolVersion, 2);

  assert.equal(executionEnvironmentDescriptorSchema.safeParse({ ...ok, platform: { os: 'beos' } }).success, false);
});

test('runSchema accepts a real run and rejects an unknown status', () => {
  const run = {
    id: 'run-1',
    threadId: 'th-1',
    ordinal: 1,
    providerInstanceId: 'codex',
    status: 'running',
    userMessageId: 'msg-1',
    requestedAt: '2024-01-01T00:00:00.000Z',
    completedAt: null,
  };
  assert.equal(runSchema.safeParse(run).success, true);
  assert.equal(runSchema.safeParse({ ...run, status: 'galaxy' }).success, false);
});

test('turnItemSchema parses a known item and rejects an unknown type', () => {
  const base = {
    id: 'item-1',
    threadId: 'th-1',
    runId: 'run-1',
    ordinal: 0,
    status: 'running',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
  const message = { ...base, type: 'assistant_message', text: 'hi', messageId: 'm-1', streaming: true };
  assert.equal(turnItemSchema.safeParse(message).success, true);
  assert.equal(turnItemSchema.safeParse({ ...base, type: 'quantum_thought' }).success, false);
});

test('threadStreamItemSchema accepts each stream arm and rejects a missing kind', () => {
  const baseEvent = { id: 'e1', threadId: 'th-1', occurredAt: '2024-01-01T00:00:00.000Z' };
  assert.equal(threadStreamItemSchema.safeParse({ kind: 'synchronized' }).success, true);
  assert.equal(
    threadStreamItemSchema.safeParse({
      kind: 'event',
      sequence: 3,
      event: { ...baseEvent, type: 'run.updated', payload: {} },
    }).success,
    true,
  );
  assert.equal(
    threadStreamItemSchema.safeParse({ kind: 'unknown-event', sequence: 4, eventType: 'future.event' }).success,
    true,
  );
  assert.equal(threadStreamItemSchema.safeParse({ sequence: 1 }).success, false);
});

test('serverProviderSchema requires the routing keys and tolerates extra fields', () => {
  const minimal = {
    instanceId: 'codex',
    driver: 'codex',
    enabled: true,
    installed: true,
    version: null,
  };
  assert.equal(serverProviderSchema.safeParse(minimal).success, true);
  assert.equal(serverProviderSchema.safeParse({ ...minimal, futureField: 1 }).success, true);
  assert.equal(serverProviderSchema.safeParse({ driver: 'codex', enabled: true, installed: true, version: null }).success, false);
});

test('desktopBootstrapSchema requires the desktop envelope fields', () => {
  const bootstrap = {
    mode: 'desktop',
    noBrowser: true,
    port: 3777,
    host: '127.0.0.1',
    desktopBootstrapToken: 'one-time-token',
    tailscaleServeEnabled: false,
    tailscaleServePort: 3778,
  };
  assert.equal(desktopBootstrapSchema.safeParse(bootstrap).success, true);
  const parsed = desktopBootstrapSchema.safeParse(bootstrap);
  assert.ok(parsed.success && parsed.data.t3Home === undefined);
  assert.equal(desktopBootstrapSchema.safeParse({ ...bootstrap, mode: 'headless' }).success, false);
});

test('the state-directory-owned exit code is 78', () => {
  assert.equal(SERVER_EXIT_CODE_STATE_DIR_OWNED, 78);
});
