/**
 * A real end-to-end handshake exercise.
 *
 * The unit tests inject `fetch` and a transport. This test instead stands up a small HTTP server
 * that speaks the exact T3 routes and a minimal WebSocket upgrade (RFC 6455 handshake + text
 * frames) on `node:http`, then drives `connectT3` with Node's global `fetch` and `WebSocket`.
 * That proves the parts a mock cannot: the URL/query contract, the RFC 8693 token exchange, the
 * bearer ticket, the `?orchestrationProtocol=2&wsTicket=` gate, and JSON-envelope framing over a
 * real socket.
 *
 * It is deliberately not a T3 server: no orchestration semantics, only the transport contract.
 * The real pinned sidecar is still required for a true protocol proof, and the absence of any
 * pinned artifact is recorded in docs/research/agent-implementation.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { connectT3, isAgentBridgeError } from '../src/index.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Minimal RFC 6455 server endpoint: one text frame in, one or many text frames out. */
class MiniWebSocket {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: Socket,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void,
  ) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => onClose());
    socket.on('error', () => onClose());
  }

  send(text: string): void {
    const payload = Buffer.from(text, 'utf8');
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    try {
      this.socket.end(Buffer.from([0x88, 0x00]));
    } catch {
      // already gone
    }
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0] ?? 0;
      const second = this.buffer[1] ?? 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      const raw = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        this.close();
        this.onClose();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (opcode !== 0x1) continue;
      const decoded = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        const byte = raw[index] ?? 0;
        decoded[index] = mask === undefined ? byte : byte ^ (mask[index % 4] ?? 0);
      }
      this.onText(decoded.toString('utf8'));
    }
  }
}

interface StubOptions {
  readonly protocolVersion: number;
  /** Fail the upgrade when the query does not exactly match this. */
  readonly requireQuery?: { orchestrationProtocol: string; wsTicket: string };
  readonly providers?: ReadonlyArray<unknown>;
  /** Send one server-originated request once the first client frame arrives. */
  readonly serverRequest?: { tag: string };
}

interface Stub {
  readonly origin: string;
  readonly requests: string[];
  readonly upgradeQueries: string[];
  readonly clientReplies: string[];
  close(): Promise<void>;
}

const startStub = async (options: StubOptions): Promise<Stub> => {
  const requests: string[] = [];
  const upgradeQueries: string[] = [];
  const clientReplies: string[] = [];
  const sockets = new Set<MiniWebSocket>();

  const server = http.createServer((req, res) => {
    requests.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/t3/environment') {
      send(200, {
        environmentId: 'stub-env',
        label: 'Forgon handshake stub',
        platform: { os: 'windows', arch: 'x64' },
        serverVersion: '0.0.1-stub',
        orchestrationProtocolVersion: options.protocolVersion,
        capabilities: {},
      });
      return;
    }
    if (req.url === '/oauth/token') {
      send(200, {
        access_token: 'stub-access-token',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'orchestration',
      });
      return;
    }
    if (req.url === '/api/auth/websocket-ticket') {
      send(200, { ticket: 'stub-ticket', expiresAt: '2030-01-01T00:00:00.000Z' });
      return;
    }
    if (req.url === '/api/projects') {
      send(200, { projects: [{ id: 'stub-project', workspaceRoot: 'C:/stub' }], updatedAt: '2030-01-01T00:00:00.000Z' });
      return;
    }
    send(404, { error: 'not found' });
  });

  let serverRequestSent = false;
  server.on('upgrade', (req, socket: Socket) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    upgradeQueries.push(url.search);
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (
      options.requireQuery !== undefined &&
      (url.searchParams.get('orchestrationProtocol') !== options.requireQuery.orchestrationProtocol ||
        url.searchParams.get('wsTicket') !== options.requireQuery.wsTicket)
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const ws = new MiniWebSocket(
      socket,
      (text) => {
        const parsed = JSON.parse(text) as { _tag?: string; id?: string; tag?: string };
        if (parsed._tag === 'Request') {
          const reply =
            parsed.tag === 'server.refreshProviders'
              ? { providers: options.providers ?? [] }
              : parsed.tag === 'orchestration.getTurnDiff'
                ? { threadId: 'stub-thread', fromTurnCount: 0, toTurnCount: 1, diff: '' }
                : {};
          ws.send(JSON.stringify({ _tag: 'Exit', requestId: parsed.id, exit: { _tag: 'Success', value: reply } }));
        } else if (parsed._tag === 'Exit' || parsed._tag === 'Defect') {
          clientReplies.push(text);
        }
        if (options.serverRequest !== undefined && !serverRequestSent) {
          serverRequestSent = true;
          ws.send(
            JSON.stringify({ _tag: 'Request', id: 'stub-server-1', tag: options.serverRequest.tag, payload: {} }),
          );
        }
      },
      () => sockets.delete(ws),
    );
    sockets.add(ws);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    upgradeQueries,
    clientReplies,
    close: async () => {
      for (const ws of sockets) ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const fetchLike = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);

test('connectT3 completes a real HTTP + WebSocket handshake and calls RPC over the socket', async () => {
  const stub = await startStub({
    protocolVersion: 2,
    requireQuery: { orchestrationProtocol: '2', wsTicket: 'stub-ticket' },
    providers: [
      { instanceId: 'codex', driver: 'codex', enabled: true, installed: true, version: '1.0.0' },
    ],
  });
  try {
    const connection = await connectT3({ origin: stub.origin, fetch: fetchLike, bootstrapToken: 'BOOT' });

    assert.equal(connection.environmentId, 'stub-env');
    assert.equal(connection.serverVersion, '0.0.1-stub');
    assert.equal(connection.ticketExpiresAt, '2030-01-01T00:00:00.000Z');
    assert.deepEqual(stub.upgradeQueries, ['?orchestrationProtocol=2&wsTicket=stub-ticket']);

    const providers = await connection.orchestration.refreshProviders();
    assert.deepEqual(providers.map((provider) => provider.instanceId), ['codex']);

    const diff = await connection.orchestration.getTurnDiff({ threadId: 't', fromTurnCount: 0, toTurnCount: 1 });
    assert.equal(diff.diff, '');

    const projects = await connection.projects.snapshot();
    assert.deepEqual(projects, [{ id: 'stub-project', workspaceRoot: 'C:/stub' }]);

    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(stub.requests.some((request) => request.startsWith('GET /.well-known/t3/environment')));
    assert.ok(stub.requests.some((request) => request.startsWith('POST /oauth/token')));
    assert.ok(stub.requests.some((request) => request.startsWith('POST /api/auth/websocket-ticket')));
  } finally {
    await stub.close();
  }
});

test('connectT3 answers a real server-originated request with an explicit failure', async () => {
  const stub = await startStub({
    protocolVersion: 2,
    serverRequest: { tag: 'server.stubClientTask' },
  });
  try {
    const connection = await connectT3({ origin: stub.origin, fetch: fetchLike, bootstrapToken: 'BOOT' });
    await connection.orchestration.refreshProviders();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(stub.clientReplies.length, 1);
    const reply = JSON.parse(stub.clientReplies[0] ?? '{}') as {
      _tag: string;
      exit: { _tag: string; cause: ReadonlyArray<{ error: { _tag: string; method: string } }> };
    };
    assert.equal(reply._tag, 'Exit');
    assert.equal(reply.exit._tag, 'Failure');
    assert.equal(reply.exit.cause[0]?.error._tag, 'ForgonUnhandledServerRequest');
    assert.equal(reply.exit.cause[0]?.error.method, 'server.stubClientTask');

    connection.close();
  } finally {
    await stub.close();
  }
});

test('connectT3 refuses a real server advertising protocol 1 before opening a socket', async () => {
  const stub = await startStub({ protocolVersion: 1 });
  try {
    await assert.rejects(
      connectT3({ origin: stub.origin, fetch: fetchLike, bootstrapToken: 'BOOT' }),
      (error: unknown) => isAgentBridgeError(error) && error.code === 'protocol_version_mismatch',
    );
    assert.deepEqual(stub.upgradeQueries, []);
    assert.equal(stub.requests.some((request) => request.startsWith('POST /oauth/token')), false);
  } finally {
    await stub.close();
  }
});
