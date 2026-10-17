import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __internalFrameSchemas,
  describeError,
  describeFailure,
  encodeClientFrame,
  encodeClientResponseFrame,
  exitSucceeded,
  firstFailure,
  isAgentBridgeError,
  parseServerFrame,
} from '../src/index.js';

test('encodeClientFrame serializes a well-formed request envelope', () => {
  const encoded = encodeClientFrame({ _tag: 'Request', id: 'a:1', tag: 'x', payload: { n: 1 }, headers: [] });
  assert.deepEqual(JSON.parse(encoded), { _tag: 'Request', id: 'a:1', tag: 'x', payload: { n: 1 }, headers: [] });
});

test('encodeClientFrame rejects a malformed envelope as a protocol_shape error', () => {
  assert.throws(
    () => encodeClientFrame({ _tag: 'Nope' } as never),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'protocol_shape',
  );
});

test('encodeClientResponseFrame serializes a reply to a server request', () => {
  const encoded = encodeClientResponseFrame({
    _tag: 'Exit',
    requestId: 7,
    exit: { _tag: 'Success', value: { ok: true } },
  });
  assert.deepEqual(JSON.parse(encoded), {
    _tag: 'Exit',
    requestId: 7,
    exit: { _tag: 'Success', value: { ok: true } },
  });
});

test('parseServerFrame decodes a single envelope', () => {
  const frames = parseServerFrame(JSON.stringify({ _tag: 'Pong' }));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?._tag, 'Pong');
});

test('parseServerFrame decodes a JSON array of envelopes', () => {
  const frames = parseServerFrame(
    JSON.stringify([
      { _tag: 'Chunk', requestId: 'a:1', values: [1] },
      { _tag: 'Exit', requestId: 'a:1', exit: { _tag: 'Success', value: 'done' } },
    ]),
  );
  assert.deepEqual(frames.map((frame) => frame._tag), ['Chunk', 'Exit']);
});

test('parseServerFrame rejects invalid JSON, non-objects and unknown tags', () => {
  const shape = (error: unknown): boolean => isAgentBridgeError(error) && error.code === 'protocol_shape';
  assert.throws(() => parseServerFrame('not json'), shape);
  assert.throws(() => parseServerFrame('42'), shape);
  assert.throws(() => parseServerFrame(JSON.stringify({ _tag: 'Mystery' })), shape);
  assert.throws(() => parseServerFrame(JSON.stringify({ noTag: true })), shape);
});

test('a Chunk envelope with an empty values array is invalid per the wire contract', () => {
  assert.equal(__internalFrameSchemas.serverFrameSchema.safeParse({ _tag: 'Chunk', requestId: 'a', values: [] }).success, false);
});

test('firstFailure and describeFailure read an Effect exit cause', () => {
  const failure = {
    _tag: 'Failure',
    cause: [{ _tag: 'Interrupt', fiberId: 3 }],
  } as const;
  assert.equal(firstFailure(failure), undefined);
  assert.match(describeFailure(failure), /Interrupt\(3\)/);

  const withFail = {
    _tag: 'Failure',
    cause: [{ _tag: 'Fail', error: { _tag: 'ThreadNotFound' } }],
  } as const;
  assert.deepEqual(firstFailure(withFail), { _tag: 'ThreadNotFound' });
  assert.match(describeFailure(withFail), /ThreadNotFound/);
});

test('exitSucceeded and describeError report outcomes plainly', () => {
  assert.equal(exitSucceeded({ _tag: 'Success', value: 1 }), true);
  assert.equal(exitSucceeded({ _tag: 'Failure', cause: [] }), false);
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError({ _tag: 'E', message: 'm' }), 'E: m');
  assert.equal(describeError({ _tag: 'E' }), 'E');
  assert.equal(describeError('plain'), 'plain');
});
