import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentBridgeError,
  createAgentServiceProxy,
  createAgentServiceRpcHandler,
  createRemoteAgentConnection,
  parseAgentServiceCall,
  type AgentProviderInfo,
  type AgentServiceCall,
  type AgentServiceCallResult,
  type AgentServiceTransport,
} from '../src/index.js';
import type { AgentEvent, AgentRunRequest, AgentService } from '@forgon/project-schema';

const request: AgentRunRequest = {
  threadId: 't1',
  provider: 'codex',
  prompt: 'hello',
  projectRoot: 'C:/project',
  permissionMode: 'supervised',
  context: { files: [], entityIds: [], assetIds: [] },
};

const event: AgentEvent = {
  runId: 'r1',
  threadId: 't1',
  sequence: 1,
  timestamp: '2026-10-17T00:00:00.000Z',
  type: 'text',
  text: 'hi',
};

/** Wire the two ends together in memory: exactly what a real transport must preserve. */
const link = (service: AgentService): { transport: AgentServiceTransport; calls: AgentServiceCall[] } => {
  const handler = createAgentServiceRpcHandler(service);
  const listeners = new Set<(event: AgentEvent) => void>();
  const calls: AgentServiceCall[] = [];
  return {
    calls,
    transport: {
      call: (call) => {
        calls.push(call);
        return handler(call);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};

const recordingService = (overrides: Partial<AgentService> = {}): AgentService => ({
  start: overrides.start ?? (() => Promise.resolve({ runId: 'r1' })),
  cancel: overrides.cancel ?? (() => Promise.resolve()),
  approve: overrides.approve ?? (() => Promise.resolve()),
  subscribe: overrides.subscribe ?? (() => () => undefined),
});

test('proxy forwards each method and the handler applies it to the real service', async () => {
  const seen: unknown[] = [];
  const service = recordingService({
    start: (req) => {
      seen.push(['start', req.threadId, req.prompt]);
      return Promise.resolve({ runId: 'run-9' });
    },
    cancel: (runId) => {
      seen.push(['cancel', runId]);
      return Promise.resolve();
    },
    approve: (runId, requestId, allow) => {
      seen.push(['approve', runId, requestId, allow]);
      return Promise.resolve();
    },
  });
  const { transport, calls } = link(service);
  const proxy = createAgentServiceProxy(transport);

  assert.deepEqual(await proxy.start(request), { runId: 'run-9' });
  await proxy.cancel('run-9');
  await proxy.approve('run-9', 'req-1', false);

  assert.deepEqual(seen, [
    ['start', 't1', 'hello'],
    ['cancel', 'run-9'],
    ['approve', 'run-9', 'req-1', false],
  ]);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['start', 'cancel', 'approve'],
  );
});

test('a typed refusal keeps its code across the boundary', async () => {
  const service = recordingService({
    start: () =>
      Promise.reject(new AgentBridgeError('unsupported_permission_mode', 'inspect is not enforceable here.')),
  });
  const proxy = createAgentServiceProxy(link(service).transport);

  await assert.rejects(
    () => proxy.start(request),
    (error: unknown) => {
      assert.ok(error instanceof AgentBridgeError);
      assert.equal(error.code, 'unsupported_permission_mode');
      assert.equal(error.message, 'inspect is not enforceable here.');
      return true;
    },
  );
});

test('an untyped failure degrades to service_error, not a fabricated code', async () => {
  const service = recordingService({ cancel: () => Promise.reject(new Error('socket closed')) });
  const { transport } = link(service);
  await assert.rejects(
    () => createAgentServiceProxy(transport).cancel('r1'),
    (error: unknown) => {
      assert.ok(error instanceof AgentBridgeError);
      assert.equal(error.code, 'service_error');
      assert.equal(error.message, 'socket closed');
      return true;
    },
  );
});

test('start refuses a result without a runId instead of reporting an unaddressable run', async () => {
  const handler: (call: unknown) => Promise<AgentServiceCallResult> = () => Promise.resolve({ ok: true });
  const transport: AgentServiceTransport = { call: handler, onEvent: () => () => undefined };
  await assert.rejects(
    () => createAgentServiceProxy(transport).start(request),
    (error: unknown) => error instanceof AgentBridgeError && error.code === 'protocol_shape',
  );
});

test('subscribe is the transport event channel, and unsubscribing is honoured', () => {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const transport: AgentServiceTransport = {
    call: () => Promise.resolve({ ok: true }),
    onEvent: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const proxy = createAgentServiceProxy(transport);
  const received: AgentEvent[] = [];

  const off = proxy.subscribe((incoming) => received.push(incoming));
  assert.equal(listeners.length, 1);
  listeners.forEach((listener) => listener(event));
  assert.deepEqual(received, [event]);

  off();
  assert.equal(listeners.length, 0);
  listeners.forEach((listener) => listener(event));
  assert.deepEqual(received, [event]);
});

test('a malformed call is a protocol_shape failure, never a guessed default', async () => {
  const handler = createAgentServiceRpcHandler(recordingService());
  assert.deepEqual(await handler({ method: 'cancel' }), {
    ok: false,
    code: 'protocol_shape',
    message: 'The agent IPC call was malformed.',
  });
  assert.deepEqual(await handler('nonsense'), {
    ok: false,
    code: 'protocol_shape',
    message: 'The agent IPC call was malformed.',
  });
  assert.throws(() => parseAgentServiceCall({ method: 'approve', runId: 'r', requestId: 'x' }));
});

test('createRemoteAgentConnection exposes the proxy, providers and refresh', async () => {
  const service = recordingService();
  const { transport } = link(service);
  const providers: AgentProviderInfo[] = [
    { id: 'codex', name: 'Codex', readiness: 'ready', models: ['gpt-5'], permissionModes: ['supervised'] },
  ];
  const refreshed: AgentProviderInfo[] = [{ ...providers[0]!, models: ['gpt-5', 'gpt-5-mini'] }];
  const connection = createRemoteAgentConnection({
    transport,
    providers,
    refreshProviders: () => Promise.resolve(refreshed),
  });

  assert.deepEqual(connection.providers, providers);
  assert.deepEqual(await connection.refreshProviders!(), refreshed);
  assert.deepEqual(await connection.service.start(request), { runId: 'r1' });
});
