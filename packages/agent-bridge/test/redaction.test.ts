import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsLikelySecret, redactValue, redactSecrets } from '../src/index.js';

test('redactSecrets replaces a key=value secret', () => {
  assert.equal(redactSecrets('access_token=super-secret-value'), 'access_token="[redacted]"');
});

test('redactSecrets replaces JSON-shaped secrets', () => {
  assert.equal(
    redactSecrets('{"wsTicket":"abc123","other":"keep"}'),
    '{"wsTicket":"[redacted]","other":"keep"}',
  );
});

test('redactSecrets replaces a JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh';
  assert.equal(redactSecrets(`bearer ${jwt}`), 'bearer [redacted]');
});

test('redactSecrets replaces an Authorization bearer header value', () => {
  assert.equal(redactSecrets('Bearer abc.def-ghi'), 'Bearer [redacted]');
});

test('redactSecrets replaces a query-string ticket', () => {
  assert.equal(
    redactSecrets('ws://host/ws?orchestrationProtocol=2&wsTicket=abc123&x=1'),
    'ws://host/ws?orchestrationProtocol=2&wsTicket=[redacted]&x=1',
  );
});

test('redactSecrets leaves a clean string alone', () => {
  const clean = 'the agent edited src/main.ts';
  assert.equal(redactSecrets(clean), clean);
  assert.equal(containsLikelySecret(clean), false);
});

test('containsLikelySecret detects a token assignment', () => {
  assert.equal(containsLikelySecret('token=abc'), true);
});

test('redactValue walks nested objects and arrays and blanks secret keys', () => {
  const input = {
    access_token: 'abc',
    nested: { wsTicket: 'xyz', keep: 'ok' },
    list: ['plain', 'password=hunter2'],
  };
  assert.deepEqual(redactValue(input), {
    access_token: '[redacted]',
    nested: { wsTicket: '[redacted]', keep: 'ok' },
    list: ['plain', 'password="[redacted]"'],
  });
});

test('redactValue matches secret keys case-insensitively', () => {
  assert.deepEqual(redactValue({ WSTICKET: 'abc', Access_Token: 'def' }), {
    WSTICKET: '[redacted]',
    Access_Token: '[redacted]',
  });
});

test('redactValue passes non-plain values through', () => {
  assert.equal(redactValue(42), 42);
  assert.equal(redactValue(null), null);
  assert.equal(redactValue(undefined), undefined);
});
