import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcSession, isAgentBridgeError } from '../src/index.js';
import {
  createFakeTransport,
  lastSent,
  serverChunk,
  serverExitFailure,
  serverExitSuccess,
  serverPong,
  serverRequest,
} from './helpers.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('request sends an id-tagged Request frame and resolves on a Success exit', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport, idPrefix: 's' });
  const promise = session.request('server.getConfig', { a: 1 });
  const frame = lastSent(transport);
  assert.equal(frame['_tag'], 'Request');
  assert.equal(frame['tag'], 'server.getConfig');
  assert.deepEqual(frame['payload'], { a: 1 });

  transport.emit(serverExitSuccess(frame['id'] as string, { ok: true }));
  assert.deepEqual(await promise, { ok: true });
});

test('a Failure exit rejects with a typed rpc_failed error carrying the Effect tag', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  const promise = session.request('orchestration.getThreadProjection', {});
  const frame = lastSent(transport);
  transport.emit(serverExitFailure(frame['id'] as string, { _tag: 'ThreadNotFound', message: 'no thread' }));

  await assert.rejects(promise, (error: unknown) => {
    return isAgentBridgeError(error) && error.code === 'rpc_failed' && error.rpc?.errorTag === 'ThreadNotFound';
  });
});

test('request ids increase and stay unique', () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport, idPrefix: 's' });
  void session.request('a', {});
  void session.request('b', {});
  const ids = transport.sentFrames().map((frame) => (frame as { id: string }).id);
  assert.deepEqual(ids, ['s:1', 's:2']);
});

test('stream yields each Chunk value until the Exit', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  const iterate = session.stream('orchestration.subscribeThread', { threadId: 't' });
  const frame = lastSent(transport);
  transport.emit(serverChunk(frame['id'] as string, [{ kind: 'synchronized' }]));
  transport.emit(serverChunk(frame['id'] as string, [{ kind: 'unknown-event', sequence: 1, eventType: 'x' }]));
  transport.emit(serverExitSuccess(frame['id'] as string, null));

  const items: unknown[] = [];
  for await (const item of iterate) items.push(item);
  assert.deepEqual(items, [{ kind: 'synchronized' }, { kind: 'unknown-event', sequence: 1, eventType: 'x' }]);
});

test('a malformed frame fails the session and rejects in-flight calls', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  const promise = session.request('a', {});
  transport.emit('{ this is not json');
  await assert.rejects(promise, (error: unknown) => isAgentBridgeError(error) && error.code === 'protocol_shape');
  assert.equal((await session.closed).code, 1006);
});

test('an unhandled server request is answered with an explicit failure', async () => {
  const transport = createFakeTransport();
  createRpcSession({ transport });
  transport.emit(serverRequest('srv-1', 'server.askClient', {}));
  await tick();

  const reply = transport.sentFrames()[0] as {
    _tag: string;
    requestId: string;
    exit: { _tag: string; cause: ReadonlyArray<{ error: { _tag: string; method: string } }> };
  };
  assert.equal(reply._tag, 'Exit');
  assert.equal(reply.requestId, 'srv-1');
  assert.equal(reply.exit._tag, 'Failure');
  assert.equal(reply.exit.cause[0]?.error._tag, 'ForgonUnhandledServerRequest');
  assert.equal(reply.exit.cause[0]?.error.method, 'server.askClient');
});

test('a handled server request is answered with the handler value', async () => {
  const transport = createFakeTransport();
  createRpcSession({ transport, onServerRequest: (frame) => ({ handled: frame.tag }) });
  transport.emit(serverRequest(7, 'server.askClient', {}));
  await tick();

  const reply = transport.sentFrames()[0] as { requestId: number; exit: { _tag: string; value: unknown } };
  assert.equal(reply.requestId, 7);
  assert.deepEqual(reply.exit, { _tag: 'Success', value: { handled: 'server.askClient' } });
});

test('a throwing server-request handler is answered with a failure, not silence', async () => {
  const transport = createFakeTransport();
  createRpcSession({
    transport,
    onServerRequest: () => {
      throw new Error('nope');
    },
  });
  transport.emit(serverRequest('srv-2', 'server.askClient', {}));
  await tick();

  const reply = transport.sentFrames()[0] as { exit: { _tag: string; cause: ReadonlyArray<{ error: { _tag: string } }> } };
  assert.equal(reply.exit._tag, 'Failure');
  assert.equal(reply.exit.cause[0]?.error._tag, 'ForgonServerRequestFailed');
});

test('a server notification is not answered', async () => {
  const transport = createFakeTransport();
  createRpcSession({ transport });
  transport.emit(JSON.stringify({ _tag: 'Request', id: 'srv-3', tag: 'server.notice', payload: {}, isNotification: true }));
  await tick();
  assert.equal(transport.sent.length, 0);
});

test('interrupt is sent only for a pending request id', () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  void session.request('a', {});
  const frame = lastSent(transport);
  session.interrupt(frame['id'] as string);
  assert.equal(lastSent(transport)['_tag'], 'Interrupt');

  const before = transport.sent.length;
  session.interrupt('never-registered');
  assert.equal(transport.sent.length, before);
});

test('ping resolves when the server answers with Pong', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  const promise = session.ping();
  assert.equal(lastSent(transport)['_tag'], 'Ping');
  transport.emit(serverPong());
  await promise;
});

test('close rejects in-flight calls and reports a clean close code', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  const promise = session.request('a', {});
  session.close();
  await assert.rejects(promise);
  assert.deepEqual(await session.closed, { code: 1000, reason: 'forgon bridge closed' });
});

test('a transport error closes the session with code 1006', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  const closed = session.closed;
  transport.emitError(new Error('socket exploded'));
  assert.equal((await closed).code, 1006);
});

test('a request timeout rejects rather than hanging', async () => {
  const transport = createFakeTransport();
  const session = createRpcSession({ transport });
  await assert.rejects(
    session.request('slow', {}, { timeoutMs: 20 }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'transport_failed',
  );
});
