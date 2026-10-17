/**
 * Effect RPC JSON framing, as used by T3's `/ws` endpoint.
 *
 * Source of truth: `.repos/effect-smol/packages/effect/src/rpc/{RpcMessage,RpcSerialization}.ts`
 * and `RpcServer.ts` (`makeSocketProtocol`). T3 serves `/ws` with
 * `RpcSerialization.layerJson` (apps/server/src/ws.ts). For that serialization
 * `includesFraming === false` and `encode = (response) => JSON.stringify(response)`, so
 * every socket frame is exactly one JSON envelope, and a JSON *array* decodes to several
 * envelopes. Holes (payload, chunk values, exit) are JSON, not bytes, because a JSON
 * serialization fills schema holes with `Schema.toCodecJson`.
 *
 * Only the envelopes a client can send or receive are modelled. Anything else is a
 * protocol-shape failure: the bridge validates the frame instead of guessing.
 */
import { z } from 'zod';
import { protocolShape } from './errors.js';

export type RequestId = string | number;

export interface RpcRequestFrame {
  readonly _tag: 'Request';
  readonly id: RequestId;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly isNotification?: true;
}

export interface RpcAckFrame {
  readonly _tag: 'Ack';
  readonly requestId: RequestId;
}

export interface RpcInterruptFrame {
  readonly _tag: 'Interrupt';
  readonly requestId: RequestId;
}

export interface RpcPingFrame {
  readonly _tag: 'Ping';
}

export interface RpcEofFrame {
  readonly _tag: 'Eof';
}

/** Client → server envelopes (RpcMessage.FromClientEncoded). */
export type RpcClientFrame = RpcRequestFrame | RpcAckFrame | RpcInterruptFrame | RpcPingFrame | RpcEofFrame;

/** One entry of a failure cause. Mirrors RpcMessage.ExitEncoded's cause union. */
export type RpcCauseEntry =
  | { readonly _tag: 'Fail'; readonly error: unknown }
  | { readonly _tag: 'Die'; readonly defect: unknown }
  | { readonly _tag: 'Interrupt'; readonly fiberId?: number | null };

export type RpcExit =
  | { readonly _tag: 'Success'; readonly value: unknown }
  | { readonly _tag: 'Failure'; readonly cause: ReadonlyArray<RpcCauseEntry> };

export interface RpcChunkFrame {
  readonly _tag: 'Chunk';
  readonly requestId: RequestId;
  /** Non-empty per RpcMessage.ResponseChunkEncoded's NonEmptyReadonlyArray contract. */
  readonly values: ReadonlyArray<unknown>;
}

export interface RpcExitFrame {
  readonly _tag: 'Exit';
  readonly requestId: RequestId;
  readonly exit: RpcExit;
}

export interface RpcDefectFrame {
  readonly _tag: 'Defect';
  readonly defect: unknown;
}

export interface RpcPongFrame {
  readonly _tag: 'Pong';
}

export interface RpcClientProtocolErrorFrame {
  readonly _tag: 'ClientProtocolError';
  readonly error: unknown;
}

/**
 * A server-originated request. `FromServerEncoded` includes `RequestEncoded` because a
 * server can act as an RPC client (notifications, or asking the client to do work).
 * The client must answer with `Chunk`/`Exit` frames, not ignore it.
 */
export interface RpcServerRequestFrame {
  readonly _tag: 'Request';
  readonly id: RequestId;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly isNotification?: true;
}

/** Server → client envelopes (RpcMessage.FromServerEncoded). */
export type RpcServerFrame =
  | RpcChunkFrame
  | RpcExitFrame
  | RpcDefectFrame
  | RpcPongFrame
  | RpcClientProtocolErrorFrame
  | RpcServerRequestFrame;

const requestIdSchema = z.union([z.string(), z.number()]);

const clientFrameSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('Request'),
    id: requestIdSchema,
    tag: z.string(),
    payload: z.unknown(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    isNotification: z.literal(true).optional(),
  }),
  z.object({ _tag: z.literal('Ack'), requestId: requestIdSchema }),
  z.object({ _tag: z.literal('Interrupt'), requestId: requestIdSchema }),
  z.object({ _tag: z.literal('Ping') }),
  z.object({ _tag: z.literal('Eof') }),
]);

const causeEntrySchema = z.union([
  z.object({ _tag: z.literal('Fail'), error: z.unknown() }),
  z.object({ _tag: z.literal('Die'), defect: z.unknown() }),
  z.object({ _tag: z.literal('Interrupt'), fiberId: z.union([z.number(), z.null()]).optional() }),
]);

const serverFrameSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Chunk'), requestId: requestIdSchema, values: z.array(z.unknown()).min(1) }),
  z.object({
    _tag: z.literal('Exit'),
    requestId: requestIdSchema,
    exit: z.union([
      z.object({ _tag: z.literal('Success'), value: z.unknown() }),
      z.object({ _tag: z.literal('Failure'), cause: z.array(causeEntrySchema) }),
    ]),
  }),
  z.object({ _tag: z.literal('Defect'), defect: z.unknown() }),
  z.object({ _tag: z.literal('Pong') }),
  z.object({ _tag: z.literal('ClientProtocolError'), error: z.unknown() }),
  z.object({
    _tag: z.literal('Request'),
    id: requestIdSchema,
    tag: z.string(),
    payload: z.unknown(),
    headers: z.array(z.tuple([z.string(), z.string()])).optional(),
    isNotification: z.literal(true).optional(),
  }),
]);

/** @internal exported for tests */
export const __internalFrameSchemas = { clientFrameSchema, serverFrameSchema };

/**
 * Envelopes a client sends *in reply to* a server-originated request. The wire tags are
 * the same as the server's response tags (`Chunk`/`Exit`/`Defect`) because both directions
 * reuse `RpcMessage`.
 */
export type RpcClientResponseFrame = RpcChunkFrame | RpcExitFrame | RpcDefectFrame;

const clientResponseSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Chunk'), requestId: requestIdSchema, values: z.array(z.unknown()).min(1) }),
  z.object({
    _tag: z.literal('Exit'),
    requestId: requestIdSchema,
    exit: z.union([
      z.object({ _tag: z.literal('Success'), value: z.unknown() }),
      z.object({ _tag: z.literal('Failure'), cause: z.array(causeEntrySchema) }),
    ]),
  }),
  z.object({ _tag: z.literal('Defect'), defect: z.unknown() }),
]);

const decodeText = (data: string | Uint8Array): string =>
  typeof data === 'string' ? data : new TextDecoder().decode(data);

/** Serialize one client envelope for a socket text frame. Throws `protocol_shape` on bad input. */
export const encodeClientFrame = (frame: RpcClientFrame): string => {
  const parsed = clientFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw protocolShape('client RPC envelope', parsed.error.message);
  }
  return JSON.stringify(parsed.data);
};

/** Serialize a reply to a server-originated request. Throws `protocol_shape` on bad input. */
export const encodeClientResponseFrame = (frame: RpcClientResponseFrame): string => {
  const parsed = clientResponseSchema.safeParse(frame);
  if (!parsed.success) {
    throw protocolShape('client response envelope', parsed.error.message);
  }
  return JSON.stringify(parsed.data);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse a socket frame into server envelopes.
 *
 * A frame may carry one envelope or a JSON array of them (RpcSerialization.json decodes
 * both). Malformed JSON, a non-object entry, or an unknown `_tag` are protocol failures
 * rather than something to skip: silently dropping a frame would desynchronise a stream.
 */
export const parseServerFrame = (data: string | Uint8Array): ReadonlyArray<RpcServerFrame> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeText(data));
  } catch (cause) {
    throw protocolShape('websocket frame', 'Frame is not valid JSON.', cause);
  }
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  const frames: RpcServerFrame[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      throw protocolShape('websocket frame', 'Frame entry is not an object.');
    }
    const tag = entry['_tag'];
    if (typeof tag !== 'string') {
      throw protocolShape('websocket frame', 'Frame entry has no _tag.');
    }
    const parsed = serverFrameSchema.safeParse(entry);
    if (!parsed.success) {
      throw protocolShape('websocket frame', `Invalid ${tag} envelope: ${parsed.error.message}`);
    }
    frames.push(parsed.data as RpcServerFrame);
  }
  return frames;
};

/** The first `Fail` error in an exit cause, if any. `Die`/`Interrupt` are cause-only. */
export const firstFailure = (exit: RpcExit): unknown | undefined => {
  if (exit._tag !== 'Failure') return undefined;
  for (const entry of exit.cause) {
    if (entry._tag === 'Fail') return entry.error;
  }
  return undefined;
};

export const exitSucceeded = (exit: RpcExit): boolean => exit._tag === 'Success';

/** A stable, human-readable reason for a non-`Fail` failure cause. */
export const describeFailure = (exit: RpcExit): string => {
  if (exit._tag === 'Success') return 'succeeded';
  const parts = exit.cause.map((entry) => {
    switch (entry._tag) {
      case 'Fail':
        return `Fail(${describeError(entry.error)})`;
      case 'Die':
        return `Die(${entry.defect === undefined ? 'unknown defect' : String(entry.defect)})`;
      case 'Interrupt':
        return `Interrupt(${entry.fiberId ?? 'unknown'})`;
    }
  });
  return parts.length === 0 ? 'failed with an empty cause' : parts.join(', ');
};

/** Best-effort message/`_tag` extraction for a tagged Effect error or any thrown value. */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const tag = typeof error['_tag'] === 'string' ? error['_tag'] : undefined;
    const message = typeof error['message'] === 'string' ? error['message'] : undefined;
    if (tag !== undefined && message !== undefined) return `${tag}: ${message}`;
    if (tag !== undefined) return tag;
    if (message !== undefined) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return 'unserializable error';
    }
  }
  return String(error);
};
