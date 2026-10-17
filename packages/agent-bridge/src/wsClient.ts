/**
 * A minimal Effect-RPC-over-WebSocket client session.
 *
 * This is the client half of the framing in `rpcFraming.ts`. It tracks in-flight
 * requests by id, resolves single-shot calls, streams `Chunk` values, forwards
 * `Interrupt`, and keeps the socket's `Ping`/`Pong` liveness check.
 *
 * The transport is injected so tests can drive a real socket or an in-memory pair;
 * production uses the global `WebSocket` (Node's WHATWG client, available since Node 22),
 * which matches T3's URL-based `wsTicket` auth because the WHATWG API cannot set headers.
 */
import {
  type RpcClientFrame,
  type RpcServerFrame,
  type RequestId,
  encodeClientFrame,
  encodeClientResponseFrame,
  firstFailure,
  parseServerFrame,
  describeFailure,
  describeError,
} from './rpcFraming.js';
import { AgentBridgeError, protocolShape, rpcFailed, transportFailed } from './errors.js';
import { redactSecrets } from './redaction.js';

export interface WebSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
}

/** The subset of a WebSocket the session needs. */
export interface WebSocketTransport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (info: WebSocketCloseInfo) => void): void;
  onError(listener: (error: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => Promise<WebSocketTransport>;

/** Adapter for the global WHATWG `WebSocket`. Resolves once the socket opens. */
export const createGlobalWebSocketTransport: WebSocketFactory = (url) => {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (WebSocketCtor === undefined) {
    return Promise.reject(
      new AgentBridgeError('transport_failed', 'This Node runtime has no global WebSocket client.'),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(url);
    socket.addEventListener('message', (event: MessageEvent) => {
      messageListeners.forEach((listener) => listener(String(event.data)));
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      closeListeners.forEach((listener) => listener({ code: event.code, reason: event.reason }));
    });
    socket.addEventListener('error', (event: Event) => {
      errorListeners.forEach((listener) => listener(event));
    });
    socket.addEventListener('open', () => {
      resolve({
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        onMessage: (listener) => messageListeners.push(listener),
        onClose: (listener) => closeListeners.push(listener),
        onError: (listener) => errorListeners.push(listener),
      });
    });
    const messageListeners: Array<(data: string) => void> = [];
    const closeListeners: Array<(info: WebSocketCloseInfo) => void> = [];
    const errorListeners: Array<(error: unknown) => void> = [];
    socket.addEventListener('error', () => {
      // Only reject the open promise; post-open errors reach onError listeners.
      reject(transportFailed('websocket connect', new Error('WebSocket failed to open.')));
    });
  });
};

interface PendingCall {
  readonly kind: 'call' | 'stream';
  readonly tag: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AgentBridgeError) => void;
  readonly onChunk: ((value: unknown) => void) | undefined;
}

export interface RpcSessionOptions {
  readonly transport: WebSocketTransport;
  /** Send an `Ack` after each streamed chunk. T3's WS protocol reports `supportsAck: false`. */
  readonly expectsAck?: boolean;
  /** Reply to server-originated requests. Defaults to failing them explicitly. */
  readonly onServerRequest?: (frame: {
    readonly id: RequestId;
    readonly tag: string;
    readonly payload: unknown;
  }) => unknown | Promise<unknown>;
  readonly idPrefix?: string;
}

export interface RpcSession {
  /** Single-shot call: resolves with the `Exit.Success` value. */
  request(tag: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Streaming call: yields each `Chunk` value until the request's `Exit`. */
  stream(tag: string, payload: unknown): AsyncIterable<unknown>;
  /** Fire-and-forget request without an id (Effect `isNotification`). */
  notify(tag: string, payload: unknown): void;
  interrupt(requestId: RequestId): void;
  ping(): Promise<void>;
  close(): void;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
}

let sessionCounter = 0;

/**
 * Create a request/response session over an already-open transport.
 *
 * Frames that fail validation reject the affected call and fail the session, since a
 * stream that silently skipped a frame would report an incomplete run as complete.
 */
export const createRpcSession = (options: RpcSessionOptions): RpcSession => {
  const pending = new Map<RequestId, PendingCall>();
  const pongWaiters: Array<() => void> = [];
  let nextId = 0;
  const prefix = options.idPrefix ?? `forgon-${(sessionCounter += 1)}`;

  let closedInfo: { code: number; reason: string } | undefined;
  let resolveClosed: (info: { code: number; reason: string }) => void = () => undefined;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });

  const finishClosed = (info: { code: number; reason: string }, error: AgentBridgeError): void => {
    if (closedInfo !== undefined) return;
    closedInfo = info;
    for (const [id, call] of pending) {
      pending.delete(id);
      call.reject(error);
    }
    resolveClosed(info);
  };

  const failSession = (error: AgentBridgeError): void => {
    finishClosed({ code: 1006, reason: error.message }, error);
    try {
      options.transport.close(1002, redactSecrets(error.message).slice(0, 120));
    } catch {
      // The socket may already be gone; the session is closed either way.
    }
  };

  const send = (frame: RpcClientFrame): void => {
    if (closedInfo !== undefined) {
      throw transportFailed('websocket send', new Error('The RPC session is closed.'));
    }
    options.transport.send(encodeClientFrame(frame));
  };

  const handleFrame = (frame: RpcServerFrame): void => {
    switch (frame._tag) {
      case 'Pong': {
        pongWaiters.shift()?.();
        return;
      }
      case 'Chunk': {
        const call = pending.get(frame.requestId);
        if (call === undefined) return;
        for (const value of frame.values) call.onChunk?.(value);
        if (options.expectsAck === true) send({ _tag: 'Ack', requestId: frame.requestId });
        return;
      }
      case 'Exit': {
        const call = pending.get(frame.requestId);
        if (call === undefined) return;
        pending.delete(frame.requestId);
        if (frame.exit._tag === 'Success') {
          call.resolve(frame.exit.value);
        } else {
          const failure = firstFailure(frame.exit);
          call.reject(
            failure === undefined
              ? transportFailed(`rpc ${call.tag}`, new Error(describeFailure(frame.exit)))
              : rpcFailed(call.tag, failure, `${call.tag} failed: ${describeError(failure)}`),
          );
        }
        return;
      }
      case 'Defect': {
        failSession(protocolShape('server defect frame', redactSecrets(String(frame.defect))));
        return;
      }
      case 'ClientProtocolError': {
        failSession(protocolShape('client protocol error frame', redactSecrets(String(frame.error))));
        return;
      }
      case 'Request': {
        if (frame.isNotification === true) return;
        // A server-originated request must be answered or the server waits forever.
        const handler = options.onServerRequest;
        const settle = (frame_: { readonly _tag: 'Success'; readonly value: unknown } | { readonly _tag: 'Failure'; readonly cause: ReadonlyArray<{ readonly _tag: 'Fail'; readonly error: unknown }> }): void => {
          try {
            options.transport.send(encodeClientResponseFrame({ _tag: 'Exit', requestId: frame.id, exit: frame_ }));
          } catch {
            // The socket is already gone; the session's close path reports it.
          }
        };
        if (handler === undefined) {
          settle({ _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'ForgonUnhandledServerRequest', method: frame.tag } }] });
          return;
        }
        void Promise.resolve()
          .then(() => handler({ id: frame.id, tag: frame.tag, payload: frame.payload }))
          .then((value) => settle({ _tag: 'Success', value: value ?? null }))
          .catch((error: unknown) =>
            settle({ _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'ForgonServerRequestFailed', message: describeError(error) } }] }),
          );
        return;
      }
    }
  };

  options.transport.onMessage((data) => {
    let frames: ReadonlyArray<RpcServerFrame>;
    try {
      frames = parseServerFrame(data);
    } catch (error) {
      failSession(error instanceof AgentBridgeError ? error : protocolShape('websocket frame', String(error)));
      return;
    }
    for (const frame of frames) handleFrame(frame);
  });

  options.transport.onError((error) => {
    finishClosed({ code: 1006, reason: 'transport error' }, transportFailed('websocket', error));
  });
  options.transport.onClose((info) => {
    finishClosed(info, transportFailed('websocket', new Error(`Socket closed (${info.code}): ${info.reason}`)));
  });

  const register = (
    kind: 'call' | 'stream',
    tag: string,
    payload: unknown,
    onChunk: ((value: unknown) => void) | undefined,
  ): { id: RequestId; promise: Promise<unknown> } => {
    const id: RequestId = `${prefix}:${(nextId += 1)}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { kind, tag, resolve, reject, onChunk });
      try {
        send({ _tag: 'Request', id, tag, payload, headers: [] });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof AgentBridgeError ? error : transportFailed(`rpc ${tag}`, error));
      }
    });
    return { id, promise };
  };

  return {
    request: (tag, payload, callOptions) => {
      const { promise } = register('call', tag, payload, undefined);
      if (callOptions?.timeoutMs === undefined) return promise;
      return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(transportFailed(`rpc ${tag}`, new Error(`Timed out after ${callOptions.timeoutMs}ms.`)));
          }, callOptions.timeoutMs);
          timer.unref?.();
          void promise.finally(() => clearTimeout(timer)).catch(() => undefined);
        }),
      ]);
    },
    stream: (tag, payload) => {
      const queue: unknown[] = [];
      let resolveNext: (() => void) | undefined;
      let done = false;
      let failure: AgentBridgeError | undefined;
      const wake = (): void => {
        resolveNext?.();
        resolveNext = undefined;
      };
      const { promise } = register('stream', tag, payload, (value) => {
        queue.push(value);
        wake();
      });
      promise
        .then(() => {
          done = true;
          wake();
        })
        .catch((error: unknown) => {
          failure = error instanceof AgentBridgeError ? error : transportFailed(`rpc ${tag}`, error);
          done = true;
          wake();
        });
      return (async function* iterate(): AsyncGenerator<unknown, void, undefined> {
        for (;;) {
          while (queue.length > 0) yield queue.shift();
          if (done) break;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
        if (failure !== undefined) throw failure;
      })();
    },
    notify: (tag, payload) => {
      send({ _tag: 'Request', id: '', tag, payload, headers: [], isNotification: true });
    },
    interrupt: (requestId) => {
      if (!pending.has(requestId)) return;
      send({ _tag: 'Interrupt', requestId });
    },
    ping: () => {
      send({ _tag: 'Ping' });
      return new Promise<void>((resolve) => {
        pongWaiters.push(resolve);
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      });
    },
    close: () => {
      try {
        options.transport.close(1000, 'forgon bridge closed');
      } finally {
        finishClosed({ code: 1000, reason: 'forgon bridge closed' }, transportFailed('websocket', new Error('Closed by Forgon.')));
      }
    },
    closed,
  };
};
