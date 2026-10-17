/**
 * T3 HTTP surface used by the bridge.
 *
 * Paths and payload shapes come from `packages/contracts/src/environmentHttp.ts`:
 *  - `GET  /.well-known/t3/environment`        (no auth) → `ExecutionEnvironmentDescriptor`
 *  - `POST /oauth/token`                       (form-urlencoded) → `AuthAccessTokenResult`
 *  - `POST /api/auth/websocket-ticket`         (bearer) → `AuthWebSocketTicketResult`
 *  - `GET  /api/projects`                      (bearer) → `ProjectSnapshot`
 *  - `POST /api/projects/mutate`               (bearer) → `Project`
 *
 * `fetch` is injected so tests exercise this client without a live server, and so the
 * sidecar manager can add whatever transport it needs without forking this file.
 */
import type { ZodType } from 'zod';
import {
  AUTH_ACCESS_TOKEN_TYPE,
  AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
  AUTH_TOKEN_EXCHANGE_GRANT_TYPE,
  ENVIRONMENT_DESCRIPTOR_PATH,
  OAUTH_TOKEN_PATH,
  PROJECTS_MUTATE_PATH,
  PROJECTS_SNAPSHOT_PATH,
  WEBSOCKET_TICKET_PATH,
  authAccessTokenResultSchema,
  authWebSocketTicketResultSchema,
  executionEnvironmentDescriptorSchema,
  projectSchema,
  projectSnapshotSchema,
} from './protocol.js';
import { authFailed, protocolShape, transportFailed } from './errors.js';
import { redactSecrets } from './redaction.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  readonly origin: string;
  readonly fetch: FetchLike;
}

const decode = <T>(schema: ZodType<T>, what: string, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw protocolShape(what, parsed.error.message);
  return parsed.data;
};

export interface AccessToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly scope: string;
}

export const createHttpClient = (options: HttpClientOptions) => {
  const url = (path: string): string => new URL(path, options.origin).toString();

  const request = async (path: string, init: RequestInit, what: string): Promise<Response> => {
    try {
      return await options.fetch(url(path), init);
    } catch (error) {
      throw transportFailed(what, error);
    }
  };

  const requireOk = (response: Response, what: string): void => {
    if (response.ok) return;
    const status = response.status;
    if (status === 401 || status === 403) throw authFailed(what, `HTTP ${status}`);
    throw transportFailed(what, new Error(`HTTP ${status} ${response.statusText}`));
  };

  return {
    getDescriptor: async () => {
      const response = await request(ENVIRONMENT_DESCRIPTOR_PATH, { method: 'GET' }, 'environment descriptor');
      requireOk(response, 'environment descriptor');
      return decode(executionEnvironmentDescriptorSchema, 'environment descriptor', await response.json());
    },

    /**
     * RFC 8693 token exchange. `subject_token` is the one-time bootstrap token; the
     * response token is what the WS ticket endpoint requires.
     */
    exchangeBootstrapToken: async (subjectToken: string, clientLabel?: string): Promise<AccessToken> => {
      const form = new URLSearchParams();
      form.set('grant_type', AUTH_TOKEN_EXCHANGE_GRANT_TYPE);
      form.set('subject_token', subjectToken);
      form.set('subject_token_type', AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE);
      form.set('requested_token_type', AUTH_ACCESS_TOKEN_TYPE);
      if (clientLabel !== undefined) form.set('client_label', clientLabel);
      const response = await request(
        OAUTH_TOKEN_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        },
        'token exchange',
      );
      requireOk(response, 'token exchange');
      const result = decode(authAccessTokenResultSchema, 'token exchange result', await response.json());
      return {
        accessToken: result.access_token,
        expiresAt: Date.now() + result.expires_in * 1_000,
        scope: result.scope,
      };
    },

    issueWebSocketTicket: async (accessToken: string) => {
      const response = await request(
        WEBSOCKET_TICKET_PATH,
        { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
        'websocket ticket',
      );
      requireOk(response, 'websocket ticket');
      return decode(authWebSocketTicketResultSchema, 'websocket ticket result', await response.json());
    },

    getProjectSnapshot: async (accessToken: string) => {
      const response = await request(
        PROJECTS_SNAPSHOT_PATH,
        { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
        'project snapshot',
      );
      requireOk(response, 'project snapshot');
      return decode(projectSnapshotSchema, 'project snapshot', await response.json());
    },

    createProject: async (accessToken: string, body: Record<string, unknown>) => {
      const response = await request(
        PROJECTS_MUTATE_PATH,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        'project mutation',
      );
      requireOk(response, 'project mutation');
      return decode(projectSchema, 'project mutation result', await response.json());
    },
  };
};

export type HttpClient = ReturnType<typeof createHttpClient>;

/** Redact a URL for logs: query values may include `wsTicket`. */
export const redactUrl = (value: string): string => redactSecrets(value);
