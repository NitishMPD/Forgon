/**
 * Full handshake against a T3 protocol-v2 environment.
 *
 * Order of operations (each shape transcribed from the pinned revision; see LICENSES/t3code.txt):
 *  1. `GET /.well-known/t3/environment` → `ExecutionEnvironmentDescriptor`.
 *  2. Require `orchestrationProtocolVersion === 2`. A missing or different version is refused:
 *     the bridge speaks exactly one protocol and never guesses a compatible shape.
 *  3. `POST /oauth/token` (RFC 8693 token exchange) — the one-time bootstrap token becomes a
 *     short-lived bearer access token. An already-minted access token may be supplied instead.
 *  4. `POST /api/auth/websocket-ticket` (Bearer) → `{ ticket, expiresAt }`.
 *  5. Open `ws(s)://<host>/ws?orchestrationProtocol=2&wsTicket=<ticket>`.
 *  6. Wrap the socket in an `RpcSession` and an `OrchestrationClient`.
 *
 * The bootstrap token and the access token are held only inside this closure. Neither is put on
 * the returned object, logged, or allowed into an `AgentEvent`; the only sensitive string that
 * leaves this module is the WebSocket URL handed straight to the transport factory.
 *
 * `fetch` and `webSocketFactory` are injected so the whole handshake is testable without a
 * server, and so the sidecar manager controls the socket implementation.
 */
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WEBSOCKET_TICKET_QUERY_PARAM,
  WS_PATH,
  type ExecutionEnvironmentDescriptor,
} from './protocol.js';
import { createHttpClient, type AccessToken, type FetchLike } from './httpClient.js';
import { authFailed, protocolVersionMismatch } from './errors.js';
import { redactSecrets } from './redaction.js';
import { createOrchestrationClient, type OrchestrationClient } from './orchestration.js';
import {
  createGlobalWebSocketTransport,
  createRpcSession,
  type RpcSession,
  type WebSocketFactory,
} from './wsClient.js';

/** Build the authenticated `/ws` URL. Exported so a test asserts the exact query contract. */
export const buildWebSocketUrl = (origin: string, ticket: string): string => {
  const url = new URL(WS_PATH, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  // Order matches upstream's own verification client: protocol first, then the one-use ticket.
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  url.searchParams.set(WEBSOCKET_TICKET_QUERY_PARAM, ticket);
  return url.toString();
};

export interface ConnectT3Options {
  /** Base origin without `/ws`, e.g. `http://127.0.0.1:3777`. */
  readonly origin: string;
  readonly fetch: FetchLike;
  /** Defaults to the global WHATWG `WebSocket`. */
  readonly webSocketFactory?: WebSocketFactory;
  /** One-time environment bootstrap token; exchanged for an access token. */
  readonly bootstrapToken?: string;
  /** A pre-minted bearer token. When present, no exchange is attempted. */
  readonly accessToken?: string;
  readonly clientLabel?: string;
  readonly idPrefix?: string;
  readonly callTimeoutMs?: number;
  /** Reply to server-originated requests. When absent the session fails them explicitly. */
  readonly onServerRequest?: (frame: {
    readonly id: string | number;
    readonly tag: string;
    readonly payload: unknown;
  }) => unknown | Promise<unknown>;
}

export interface T3ProjectRef {
  readonly id: string;
  readonly workspaceRoot: string;
}

export interface T3Connection {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly environmentId: string;
  readonly serverVersion: string;
  readonly session: RpcSession;
  readonly orchestration: OrchestrationClient;
  readonly http: ReturnType<typeof createHttpClient>;
  /**
   * Project records the access token is scoped to. These hold the token privately: a caller never
   * receives the bearer token, so the credential cannot leak into a log or an event.
   */
  readonly projects: {
    snapshot(): Promise<readonly T3ProjectRef[]>;
    create(input: { readonly projectId: string; readonly workspaceRoot: string; readonly title: string }): Promise<T3ProjectRef>;
  };
  /** The ticket's advertised expiry (ISO string); callers reconnect before it lapses. */
  readonly ticketExpiresAt: string;
  close(): void;
}

/**
 * Perform the handshake and return a live connection. Rejects with a typed `AgentBridgeError`
 * for every failure mode: version mismatch, missing credentials, HTTP auth failure, or a
 * transport that will not open. It never falls back to a weaker connection.
 */
export const connectT3 = async (options: ConnectT3Options): Promise<T3Connection> => {
  const http = createHttpClient({ origin: options.origin, fetch: options.fetch });

  const descriptor = await http.getDescriptor();
  if (descriptor.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION) {
    throw protocolVersionMismatch(ORCHESTRATION_PROTOCOL_VERSION, descriptor.orchestrationProtocolVersion);
  }

  const token = await resolveAccessToken(http, options);
  const ticket = await http.issueWebSocketTicket(token.accessToken);

  const socketUrl = buildWebSocketUrl(options.origin, ticket.ticket);
  const webSocketFactory = options.webSocketFactory ?? createGlobalWebSocketTransport;
  const transport = await webSocketFactory(socketUrl);

  const session = createRpcSession({
    transport,
    ...(options.idPrefix === undefined ? {} : { idPrefix: options.idPrefix }),
    ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
  });
  const orchestration = createOrchestrationClient(session, {
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
  });

  const projectIdFactory = options.idPrefix === undefined ? undefined : `${options.idPrefix}:project`;
  const newProjectId = (): string =>
    projectIdFactory === undefined
      ? globalThis.crypto.randomUUID()
      : `${projectIdFactory}-${globalThis.crypto.randomUUID()}`;

  return {
    descriptor,
    environmentId: descriptor.environmentId,
    serverVersion: descriptor.serverVersion,
    session,
    orchestration,
    http,
    projects: {
      snapshot: async () => {
        const snapshot = await http.getProjectSnapshot(token.accessToken);
        return snapshot.projects.map((project) => ({ id: project.id, workspaceRoot: project.workspaceRoot }));
      },
      create: async (input) => {
        const projectId = newProjectId();
        const created = await http.createProject(token.accessToken, {
          type: 'project.create',
          commandId: `${projectId}:create`,
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
        });
        return { id: created.id, workspaceRoot: created.workspaceRoot };
      },
    },
    ticketExpiresAt: ticket.expiresAt,
    close: () => session.close(),
  };
};

const resolveAccessToken = async (
  http: ReturnType<typeof createHttpClient>,
  options: ConnectT3Options,
): Promise<AccessToken> => {
  if (options.accessToken !== undefined) {
    return { accessToken: options.accessToken, expiresAt: Number.POSITIVE_INFINITY, scope: 'supplied' };
  }
  if (options.bootstrapToken !== undefined) {
    return http.exchangeBootstrapToken(options.bootstrapToken, options.clientLabel);
  }
  throw authFailed(
    'token exchange',
    'connectT3 needs a bootstrapToken or an accessToken; the bridge will not connect unauthenticated.',
  );
};

/** Redacted form of a connection's socket URL, for a log line that cannot leak the ticket. */
export const redactSocketUrl = (socketUrl: string): string => redactSecrets(socketUrl);
