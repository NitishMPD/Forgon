import type { WebSocketCloseInfo, WebSocketTransport } from '../src/wsClient.js';
import type { RequestId } from '../src/rpcFraming.js';

/** A controllable in-memory transport: the test drives inbound frames and inspects outbound. */
export interface FakeTransport extends WebSocketTransport {
  readonly sent: string[];
  /** Outbound frames parsed back to objects, for assertions. */
  sentFrames(): unknown[];
  emit(data: string): void;
  emitError(error: unknown): void;
  emitClose(info: WebSocketCloseInfo): void;
  readonly closeCalls: ReadonlyArray<{ code: number | undefined; reason: string | undefined }>;
}

export const createFakeTransport = (): FakeTransport => {
  const messageListeners: Array<(data: string) => void> = [];
  const closeListeners: Array<(info: WebSocketCloseInfo) => void> = [];
  const errorListeners: Array<(error: unknown) => void> = [];
  const sent: string[] = [];
  const closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];

  return {
    sent,
    send: (data) => {
      sent.push(data);
    },
    close: (code, reason) => {
      closeCalls.push({ code, reason });
      closeListeners.forEach((listener) => listener({ code: code ?? 1000, reason: reason ?? '' }));
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onError: (listener) => {
      errorListeners.push(listener);
    },
    sentFrames: () => sent.map((frame) => JSON.parse(frame)),
    emit: (data) => messageListeners.forEach((listener) => listener(data)),
    emitError: (error) => errorListeners.forEach((listener) => listener(error)),
    emitClose: (info) => closeListeners.forEach((listener) => listener(info)),
    closeCalls,
  };
};

export const serverChunk = (requestId: RequestId, values: ReadonlyArray<unknown>): string =>
  JSON.stringify({ _tag: 'Chunk', requestId, values });

export const serverExitSuccess = (requestId: RequestId, value: unknown): string =>
  JSON.stringify({ _tag: 'Exit', requestId, exit: { _tag: 'Success', value } });

export const serverExitFailure = (requestId: RequestId, error: unknown): string =>
  JSON.stringify({
    _tag: 'Exit',
    requestId,
    exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error }] },
  });

export const serverRequest = (
  requestId: RequestId,
  tag: string,
  payload: unknown,
): string => JSON.stringify({ _tag: 'Request', id: requestId, tag, payload });

export const serverPong = (): string => JSON.stringify({ _tag: 'Pong' });

/** The last outbound frame, parsed. Throws when nothing was sent. */
export const lastSent = (transport: FakeTransport): Record<string, unknown> => {
  const frames = transport.sentFrames();
  const last = frames.at(-1);
  if (last === undefined || typeof last !== 'object' || last === null) {
    throw new Error('No outbound frame was sent.');
  }
  return last as Record<string, unknown>;
};
