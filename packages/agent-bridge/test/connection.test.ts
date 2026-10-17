import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebSocketUrl, connectT3, isAgentBridgeError, redactSocketUrl, type FetchLike } from '../src/index.js';
import { createFakeTransport, type FakeTransport } from './helpers.js';

interface HttpResponse {
  readonly status?: number;
  readonly body: unknown;
}

interface RecordedCall {
  readonly pathname: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: string | undefined;
}

const headerValue = (headers: RequestInit['headers'], name: string): string | undefined => {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
};

const createFetch = (
  routes: Record<string, HttpResponse>,
): { fetchImpl: FetchLike; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({
      pathname: url.pathname,
      method: init?.method ?? 'GET',
      authorization: headerValue(init?.headers, 'authorization'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const route = routes[url.pathname];
    if (route === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
};

const descriptor = (version: number | undefined): unknown => ({
  environmentId: 'env-1',
  label: 'Forgon sidecar',
  platform: { os: 'windows', arch: 'x64' },
  serverVersion: '1.2.3',
  ...(version === undefined ? {} : { orchestrationProtocolVersion: version }),
  capabilities: { commandOutputStreaming: true },
});

const accessTokenBody = {
  access_token: 'access-token-xyz',
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'orchestration',
};

const ticketBody = { ticket: 'ONE-TIME-TICKET', expiresAt: '2030-01-01T00:00:00.000Z' };

test('buildWebSocketUrl puts protocol first and the ticket second', () => {
  assert.equal(
    buildWebSocketUrl('http://127.0.0.1:3777', 'TKT'),
    'ws://127.0.0.1:3777/ws?orchestrationProtocol=2&wsTicket=TKT',
  );
  assert.equal(
    buildWebSocketUrl('https://host:9000', 'TKT'),
    'wss://host:9000/ws?orchestrationProtocol=2&wsTicket=TKT',
  );
});

test('redactSocketUrl hides the ticket', () => {
  assert.equal(
    redactSocketUrl('ws://h/ws?orchestrationProtocol=2&wsTicket=SECRET'),
    'ws://h/ws?orchestrationProtocol=2&wsTicket=[redacted]',
  );
});

test('connectT3 performs the full handshake and keeps the token private', async () => {
  const { fetchImpl, calls } = createFetch({
    '/.well-known/t3/environment': { body: descriptor(2) },
    '/oauth/token': { body: accessTokenBody },
    '/api/auth/websocket-ticket': { body: ticketBody },
    '/api/projects': { body: { projects: [{ id: 'p1', workspaceRoot: 'C:/work' }], updatedAt: '2030-01-01T00:00:00.000Z' } },
    '/api/projects/mutate': { body: { id: 'p9', workspaceRoot: 'C:/new' } },
  });
  const sockets: FakeTransport[] = [];
  const urls: string[] = [];
  const connection = await connectT3({
    origin: 'http://127.0.0.1:3777',
    fetch: fetchImpl,
    bootstrapToken: 'BOOTSTRAP-ONE-TIME',
    idPrefix: 'test',
    webSocketFactory: async (url) => {
      urls.push(url);
      const socket = createFakeTransport();
      sockets.push(socket);
      return socket;
    },
  });

  assert.equal(urls[0], 'ws://127.0.0.1:3777/ws?orchestrationProtocol=2&wsTicket=ONE-TIME-TICKET');
  assert.equal(connection.environmentId, 'env-1');
  assert.equal(connection.serverVersion, '1.2.3');
  assert.equal(connection.ticketExpiresAt, '2030-01-01T00:00:00.000Z');

  const exchange = calls.find((call) => call.pathname === '/oauth/token');
  assert.ok(exchange?.body?.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange'));
  assert.ok(exchange?.body?.includes('subject_token=BOOTSTRAP-ONE-TIME'));

  const ticketCall = calls.find((call) => call.pathname === '/api/auth/websocket-ticket');
  assert.equal(ticketCall?.authorization, 'Bearer access-token-xyz');

  const projects = await connection.projects.snapshot();
  assert.deepEqual(projects, [{ id: 'p1', workspaceRoot: 'C:/work' }]);

  const created = await connection.projects.create({ projectId: 'ignored', workspaceRoot: 'C:/new', title: 'Work' });
  assert.deepEqual(created, { id: 'p9', workspaceRoot: 'C:/new' });
  const mutate = calls.find((call) => call.pathname === '/api/projects/mutate');
  assert.equal(mutate?.authorization, 'Bearer access-token-xyz');
  assert.ok(mutate?.body?.includes('"type":"project.create"'));
  assert.ok(mutate?.body?.includes('"workspaceRoot":"C:/new"'));

  // The bearer token is not a field on the returned connection.
  assert.equal(Object.prototype.hasOwnProperty.call(connection, 'accessToken'), false);

  connection.close();
});

test('connectT3 refuses an environment that advertises the wrong protocol', async () => {
  const { fetchImpl } = createFetch({ '/.well-known/t3/environment': { body: descriptor(1) } });
  await assert.rejects(
    connectT3({ origin: 'http://h', fetch: fetchImpl, bootstrapToken: 'b' }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'protocol_version_mismatch',
  );
});

test('connectT3 refuses an environment that advertises no protocol version', async () => {
  const { fetchImpl } = createFetch({ '/.well-known/t3/environment': { body: descriptor(undefined) } });
  await assert.rejects(
    connectT3({ origin: 'http://h', fetch: fetchImpl, bootstrapToken: 'b' }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'protocol_version_mismatch',
  );
});

test('connectT3 refuses to connect without any credential', async () => {
  const { fetchImpl } = createFetch({ '/.well-known/t3/environment': { body: descriptor(2) } });
  await assert.rejects(
    connectT3({ origin: 'http://h', fetch: fetchImpl }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'auth_failed',
  );
});

test('connectT3 surfaces a 401 from the ticket endpoint as auth_failed', async () => {
  const { fetchImpl } = createFetch({
    '/.well-known/t3/environment': { body: descriptor(2) },
    '/oauth/token': { body: accessTokenBody },
    '/api/auth/websocket-ticket': { status: 401, body: { error: 'nope' } },
  });
  await assert.rejects(
    connectT3({ origin: 'http://h', fetch: fetchImpl, bootstrapToken: 'b' }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'auth_failed',
  );
});

test('connectT3 accepts a pre-minted access token without an exchange', async () => {
  const { fetchImpl, calls } = createFetch({
    '/.well-known/t3/environment': { body: descriptor(2) },
    '/api/auth/websocket-ticket': { body: ticketBody },
  });
  const connection = await connectT3({
    origin: 'http://h',
    fetch: fetchImpl,
    accessToken: 'minted-token',
    webSocketFactory: async () => createFakeTransport(),
  });
  assert.equal(calls.some((call) => call.pathname === '/oauth/token'), false);
  const ticketCall = calls.find((call) => call.pathname === '/api/auth/websocket-ticket');
  assert.equal(ticketCall?.authorization, 'Bearer minted-token');
  connection.close();
});
