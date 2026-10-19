import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isAgentBridgeError } from '@forgon/agent-bridge';
import {
  assertNoSecrets,
  createThreadRefStore,
  defaultThreadRefPath,
  type ThreadRef,
  type ThreadRefIo,
} from '../src/index.js';

const FILE = path.resolve('C:/forgon/state/forgon-threads.json');

const ref = (overrides: Partial<ThreadRef> = {}): ThreadRef => ({
  runId: 'run-1',
  threadId: 'th-1',
  projectId: 'project-1',
  projectRoot: 'C:/work',
  provider: 'codex',
  instanceId: 'codex',
  model: 'gpt-5',
  permissionMode: 'supervised',
  title: 'Fix it',
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const createMemoryIo = (): { io: ThreadRefIo; files: Map<string, string>; renamed: string[] } => {
  const files = new Map<string, string>();
  const renamed: string[] = [];
  const io: ThreadRefIo = {
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) {
        const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw error;
      }
      return value;
    },
    writeFile: async (filePath, data) => {
      files.set(filePath, data);
    },
    rename: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing temp ${from}`);
      files.delete(from);
      files.set(to, value);
      renamed.push(`${from} -> ${to}`);
    },
  };
  return { io, files, renamed };
};

test('a missing store file loads as empty without a warning', async () => {
  const { io } = createMemoryIo();
  const warnings: string[] = [];
  const store = createThreadRefStore({ filePath: FILE, io, onWarning: (message) => warnings.push(message) });
  assert.deepEqual(await store.load(), []);
  assert.deepEqual(warnings, []);
});

test('save writes atomically through a temp file and a rename', async () => {
  const { io, files, renamed } = createMemoryIo();
  const store = createThreadRefStore({ filePath: FILE, io });
  await store.save(ref());
  const written = files.get(FILE);
  assert.ok(written !== undefined);
  assert.deepEqual(JSON.parse(written), { version: 1, refs: [ref()] });
  assert.equal(renamed.length, 1);
  assert.match(renamed[0] ?? '', /\.tmp -> /);
});

test('a saved ref round-trips through load, get and byThreadId', async () => {
  const { io } = createMemoryIo();
  const store = createThreadRefStore({ filePath: FILE, io });
  await store.save(ref());
  await store.save(ref({ runId: 'run-2', threadId: 'th-2' }));

  const reloaded = createThreadRefStore({ filePath: FILE, io });
  const refs = await reloaded.load();
  assert.equal(refs.length, 2);
  assert.equal(reloaded.get('run-1')?.model, 'gpt-5');
  assert.equal(reloaded.byThreadId('th-2')?.runId, 'run-2');
});

test('remove deletes a ref and rewrites the store', async () => {
  const { io } = createMemoryIo();
  const store = createThreadRefStore({ filePath: FILE, io });
  await store.save(ref());
  await store.remove('run-1');
  assert.deepEqual(store.all(), []);
  const reloaded = createThreadRefStore({ filePath: FILE, io });
  assert.deepEqual(await reloaded.load(), []);
});

test('removing an unknown run id is a no-op', async () => {
  const { io, renamed } = createMemoryIo();
  const store = createThreadRefStore({ filePath: FILE, io });
  await store.remove('ghost');
  assert.equal(renamed.length, 0);
});

test('a malformed store file warns and starts empty', async () => {
  const { io } = createMemoryIo();
  await io.writeFile(FILE, '{ not json');
  const warnings: string[] = [];
  const store = createThreadRefStore({ filePath: FILE, io, onWarning: (message) => warnings.push(message) });
  assert.deepEqual(await store.load(), []);
  assert.equal(warnings.length, 1);
});

test('a store with an unexpected shape warns and starts empty', async () => {
  const { io } = createMemoryIo();
  await io.writeFile(FILE, JSON.stringify({ version: 1, refs: 'nope' }));
  const warnings: string[] = [];
  const store = createThreadRefStore({ filePath: FILE, io, onWarning: (message) => warnings.push(message) });
  assert.deepEqual(await store.load(), []);
  assert.equal(warnings.length, 1);
});

test('entries that are missing a field are skipped, not loaded as partial refs', async () => {
  const { io } = createMemoryIo();
  await io.writeFile(FILE, JSON.stringify({ version: 1, refs: [ref(), { runId: 'run-2' }] }));
  const store = createThreadRefStore({ filePath: FILE, io });
  const refs = await store.load();
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.runId, 'run-1');
});

test('assertNoSecrets refuses a ref carrying a secret-shaped key', () => {
  assert.doesNotThrow(() => assertNoSecrets(ref()));
  assert.throws(
    () => assertNoSecrets({ ...ref(), token: 'abc' } as unknown as ThreadRef),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'containment_violation',
  );
});

test('save refuses a secret-shaped field through the store', async () => {
  const { io } = createMemoryIo();
  const store = createThreadRefStore({ filePath: FILE, io });
  await assert.rejects(
    store.save({ ...ref(), access_token: 'abc' } as unknown as ThreadRef),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'containment_violation',
  );
});

test('defaultThreadRefPath lives inside the isolated home', () => {
  const home = path.resolve('C:/forgon/state/t3');
  const refPath = defaultThreadRefPath(home);
  assert.equal(path.dirname(refPath), home);
  assert.match(path.basename(refPath), /forgon-threads\.json$/);
});

test('thread lookup restores the latest run settings while preserving older run references', async () => {
  const { io } = createMemoryIo();
  const store = createThreadRefStore({ filePath: FILE, io });
  await store.save(ref());
  await store.save({ ...ref(), runId: 'latest', model: 'new-model', permissionMode: 'full-local' });
  const reloaded = createThreadRefStore({ filePath: FILE, io });
  await reloaded.load();
  assert.equal(reloaded.get('run-1')?.model, 'gpt-5');
  assert.equal(reloaded.byThreadId('th-1')?.model, 'new-model');
  assert.equal(reloaded.byThreadId('th-1')?.permissionMode, 'full-local');
});
