/**
 * Durable thread/run references for Forgon sessions.
 *
 * Forgon needs to reconnect a project's conversation across crashes and restarts, so it records
 * the routing keys it needs to reattach: the Forgon thread id, the T3 thread id (they are the
 * same value here), the T3 project id, and the provider/instance/model. It deliberately does not
 * persist prompts, transcripts, provider output or any token — the T3 sidecar owns conversation
 * history, and `contracts.md` requires no secrets leave the bridge. A defensive guard rejects a
 * ref that carries a secret-shaped key so a future field cannot leak by accident.
 *
 * Writes are atomic (sibling temp file + rename) so a crash cannot truncate the store.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentBridgeError,
  SECRET_KEYS,
} from '@forgon/agent-bridge';
import type { PermissionMode, ProviderId } from '@forgon/project-schema';

export interface ThreadRef {
  readonly runId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly provider: ProviderId;
  readonly instanceId: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly title: string;
  readonly createdAt: string;
}

export interface ThreadRefFile {
  readonly version: 1;
  readonly refs: readonly ThreadRef[];
}

export interface ThreadRefIo {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const defaultThreadRefIo: ThreadRefIo = {
  readFile: (filePath) => readFile(filePath, 'utf8'),
  writeFile: (filePath, data) => writeFile(filePath, data, 'utf8'),
  rename: (from, to) => rename(from, to),
};

const forbiddenKey = (key: string): boolean =>
  SECRET_KEYS.some((secret) => secret.toLowerCase() === key.toLowerCase());

/**
 * Reject a ref whose own fields, or any nested value, carry a secret-shaped key. The ref has no
 * such fields today; this is a tripwire for a future edit, not a data-shaping step.
 */
export const assertNoSecrets = (ref: ThreadRef): void => {
  for (const key of Object.keys(ref)) {
    if (forbiddenKey(key)) {
      throw new AgentBridgeError(
        'containment_violation',
        `Refusing to persist a thread reference with secret field "${key}".`,
      );
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asRef = (value: unknown): ThreadRef | undefined => {
  if (!isRecord(value)) return undefined;
  const keys: ReadonlyArray<keyof ThreadRef> = [
    'runId',
    'threadId',
    'projectId',
    'projectRoot',
    'provider',
    'instanceId',
    'model',
    'permissionMode',
    'title',
    'createdAt',
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out as unknown as ThreadRef;
};

export interface ThreadRefStore {
  load(): Promise<readonly ThreadRef[]>;
  all(): readonly ThreadRef[];
  get(runId: string): ThreadRef | undefined;
  byThreadId(threadId: string): ThreadRef | undefined;
  save(ref: ThreadRef): Promise<void>;
  remove(runId: string): Promise<void>;
}

export interface ThreadRefStoreOptions {
  /** Absolute path to the JSON store file. */
  readonly filePath: string;
  readonly io?: ThreadRefIo;
  /** Called when an existing file could not be read or parsed; the store then starts empty. */
  readonly onWarning?: (message: string) => void;
}

export const createThreadRefStore = (options: ThreadRefStoreOptions): ThreadRefStore => {
  const io = options.io ?? defaultThreadRefIo;
  const refs = new Map<string, ThreadRef>();
  let loaded = false;

  const load = async (): Promise<readonly ThreadRef[]> => {
    if (loaded) return [...refs.values()];
    loaded = true;
    try {
      const raw = await io.readFile(options.filePath);
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && Array.isArray(parsed['refs'])) {
        for (const entry of parsed['refs']) {
          const ref = asRef(entry);
          if (ref !== undefined) refs.set(ref.runId, ref);
        }
      } else {
        options.onWarning?.(`ThreadRef store at "${options.filePath}" had an unexpected shape.`);
      }
    } catch (cause) {
      // A missing file is the normal first run; a malformed one must not block startup.
      const code = isRecord(cause) ? cause['code'] : undefined;
      if (code !== 'ENOENT') {
        options.onWarning?.(
          `ThreadRef store at "${options.filePath}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    return [...refs.values()];
  };

  const flush = async (): Promise<void> => {
    const file: ThreadRefFile = { version: 1, refs: [...refs.values()] };
    const temporary = `${options.filePath}.${process.pid}.tmp`;
    await io.writeFile(temporary, JSON.stringify(file, null, 2));
    await io.rename(temporary, options.filePath);
  };

  return {
    load,
    all: () => [...refs.values()],
    get: (runId) => refs.get(runId),
    byThreadId: (threadId) => [...refs.values()].reverse().find((ref) => ref.threadId === threadId),
    save: async (ref) => {
      assertNoSecrets(ref);
      refs.set(ref.runId, ref);
      await flush();
    },
    remove: async (runId) => {
      if (!refs.delete(runId)) return;
      await flush();
    },
  };
};

/** Default store location: inside the isolated sidecar home, never the live T3 home. */
export const defaultThreadRefPath = (isolatedHomeDir: string): string =>
  path.join(isolatedHomeDir, 'forgon-threads.json');
