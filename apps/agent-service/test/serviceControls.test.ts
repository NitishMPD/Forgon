/**
 * Coverage for the facade surfaces added after the first cut: resume/reattach, turn diffs, live
 * thread controls, and the per-provider permission intersection. Every case drives the real
 * `createAgentService` over the in-memory fake connection — no live server, no fabricated answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentBridgeError } from '@forgon/agent-bridge';
import type { AgentEvent, AgentRunRequest } from '@forgon/project-schema';
import { createAgentService, type ThreadRef, type ThreadRefStore } from '../src/index.js';
import { NOW, createFakeConnection, models, projection, run, serverProvider } from './helpers.js';

const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  threadId: 'th-1',
  provider: 'codex',
  prompt: 'Fix the save bug',
  projectRoot: 'C:/work',
  permissionMode: 'supervised',
  context: { files: [], entityIds: [], assetIds: [] },
  ...overrides,
});

const codexProvider = () => serverProvider({ instanceId: 'codex', driver: 'codex', models: models('gpt-5', true) });
const opencodeProvider = () =>
  serverProvider({ instanceId: 'opencode', driver: 'opencode', models: models('mini', true) });

const createStore = (): { store: ThreadRefStore; refs: Map<string, ThreadRef> } => {
  const refs = new Map<string, ThreadRef>();
  return {
    refs,
    store: {
      load: async () => [...refs.values()],
      all: () => [...refs.values()],
      get: (runId) => refs.get(runId),
      byThreadId: (threadId) => [...refs.values()].reverse().find((ref) => ref.threadId === threadId),
      save: async (ref) => {
        refs.set(ref.runId, ref);
      },
      remove: async (runId) => {
        refs.delete(runId);
      },
    },
  };
};

const refFor = (threadId: string, runId = `run-${threadId}`): ThreadRef => ({
  runId,
  threadId,
  projectId: 'project-1',
  projectRoot: 'C:/work',
  provider: 'codex',
  instanceId: 'codex',
  model: 'gpt-5',
  permissionMode: 'supervised',
  title: 'Resumed thread',
  createdAt: NOW,
});

const codeOf = (error: unknown): string | undefined =>
  isAgentBridgeError(error) ? error.code : undefined;

const runningService = async (config: Parameters<typeof createFakeConnection>[0]) => {
  const fake = createFakeConnection(config);
  const { store, refs } = createStore();
  const service = await createAgentService({
    connection: fake.connection,
    store,
    now: () => NOW,
    idFactory: (prefix) => `${prefix}-1`,
  });
  return { fake, store, refs, service };
};

// --- resume / reattach -----------------------------------------------------------------------

test('resumeThread reattaches a persisted thread, adopts the projection and streams it once', async () => {
  const { fake, refs, service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  refs.set('run-1', refFor('th-1', 'run-1'));

  const result = await service.resumeThread('th-1');
  assert.deepEqual(result, { threadId: 'th-1', resumed: true, runId: 'run-1' });
  assert.equal(service.instanceIdForThread('th-1'), 'codex');
  assert.equal(fake.calls.subscribes.filter((entry) => entry.threadId === 'th-1').length, 1);

  // A second resume must not open a second stream for the same thread.
  await service.resumeThread('th-1');
  assert.equal(fake.calls.subscribes.filter((entry) => entry.threadId === 'th-1').length, 1);
  service.close();
});

test('resumeThread refuses to label a thread with a provider it cannot resolve', async () => {
  const { service } = await runningService({
    providers: [],
    projection: {
      ...projection({ threadId: 'th-9', runs: [run('run-9', 'running')] }),
      thread: {
        id: 'th-9',
        projectId: 'project-1',
        providerInstanceId: 'mystery-driver',
        modelSelection: { instanceId: 'mystery-driver', model: 'x' },
        runtimeMode: 'approval-required',
        worktreePath: null,
      },
    } as never,
  });

  await assert.rejects(() => service.resumeThread('th-9'), (error) => codeOf(error) === 'unsupported_provider');
  service.close();
});

test('reattachPersistedThreads reports a per-thread failure without throwing the whole reattach', async () => {
  const { fake, refs, service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
    projectionErrorFor: ['th-2'],
  });
  refs.set('run-1', refFor('th-1', 'run-1'));
  refs.set('run-2', refFor('th-2', 'run-2'));

  const outcomes = await service.reattachPersistedThreads();
  const byThread = new Map(outcomes.map((outcome) => [outcome.threadId, outcome]));
  assert.equal(byThread.get('th-1')?.resumed, true);
  assert.equal(byThread.get('th-1')?.runId, 'run-1');
  assert.equal(byThread.get('th-2')?.resumed, false);
  assert.match(byThread.get('th-2')?.error ?? '', /projection unavailable for th-2/);
  assert.ok(fake.calls.subscribes.some((entry) => entry.threadId === 'th-1'));
  service.close();
});

// --- diffs -----------------------------------------------------------------------------------

test('turnDiff refuses an untracked thread and never asks the server for it', async () => {
  const { fake, service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
    diffs: { 'th-1': DIFF },
  });

  await assert.rejects(
    () => service.turnDiff({ threadId: 'th-1', fromTurnCount: 0, toTurnCount: 1 }),
    (error) => codeOf(error) === 'run_not_found',
  );
  assert.equal(fake.calls.commands.length, 0);
  service.close();
});

test('turnDiff returns the diff and its parsed paths, and folds it into the thread stream', async () => {
  const { service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
    diffs: { 'th-1': DIFF },
  });
  const events: AgentEvent[] = [];
  service.subscribe((event) => events.push(event));
  await service.start(request());

  const result = await service.turnDiff({ threadId: 'th-1', fromTurnCount: 0, toTurnCount: 1 });
  assert.equal(result.diff, DIFF);
  assert.deepEqual(result.paths, ['src/a.ts']);
  assert.equal(result.fromTurnCount, 0);
  assert.equal(result.toTurnCount, 1);

  const diffEvent = events.find((event) => event.type === 'diff');
  assert.ok(diffEvent !== undefined);
  assert.deepEqual(diffEvent.paths, ['src/a.ts']);
  assert.equal((diffEvent as { diff?: string }).diff, DIFF);
  assert.equal(diffEvent.runId, 'run-1');
  service.close();
});

test('fullThreadDiff uses the full-thread diff and is refused for an untracked thread', async () => {
  const { service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
    diffs: { 'th-1': DIFF },
  });
  await service.start(request());

  const result = await service.fullThreadDiff({ threadId: 'th-1', toTurnCount: 3 });
  assert.equal(result.diff, DIFF);
  assert.deepEqual(result.paths, ['src/a.ts']);
  assert.equal(result.toTurnCount, 3);

  await assert.rejects(
    () => service.fullThreadDiff({ threadId: 'nope', toTurnCount: 3 }),
    (error) => codeOf(error) === 'run_not_found',
  );
  service.close();
});

// --- live thread controls --------------------------------------------------------------------

test('setModel switches the model on the tracked thread instance', async () => {
  const { fake, service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.start(request());

  await service.setModel({ threadId: 'th-1', model: 'gpt-5-mini' });
  const command = fake.calls.commands.at(-1);
  assert.equal(command?.['type'], 'thread.model-selection.set');
  assert.deepEqual(command?.['modelSelection'], { instanceId: 'codex', model: 'gpt-5-mini' });
  service.close();
});

test('setModel refuses when the provider requires a new thread for a model change', async () => {
  const provider = serverProvider({
    instanceId: 'codex',
    driver: 'codex',
    models: models('gpt-5', true),
    requiresNewThreadForModelChange: true,
  });
  const { service } = await runningService({
    providers: [provider],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.start(request());

  await assert.rejects(
    () => service.setModel({ threadId: 'th-1', model: 'gpt-5-mini' }),
    (error) => codeOf(error) === 'unsupported_control',
  );
  service.close();
});

test('setModel refuses when no provider instance is known for the thread', async () => {
  // Reattach without a persisted ref learns the provider from the projection but not the instance.
  const { service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.resumeThread('th-1');
  assert.equal(service.instanceIdForThread('th-1'), undefined);

  await assert.rejects(
    () => service.setModel({ threadId: 'th-1', model: 'gpt-5-mini' }),
    (error) => codeOf(error) === 'unsupported_control',
  );
  service.close();
});

test('setRuntimeMode maps the permission mode and refuses a mode the provider does not list', async () => {
  const permissive = serverProvider({ instanceId: 'codex', driver: 'codex', models: models('gpt-5', true) });
  const { fake, service } = await runningService({
    providers: [permissive],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.start(request());
  await service.setRuntimeMode({ threadId: 'th-1', permissionMode: 'auto-edits' });
  assert.deepEqual(fake.calls.commands.at(-1)?.['type'], 'thread.runtime-mode.set');
  assert.equal(fake.calls.commands.at(-1)?.['runtimeMode'], 'auto-accept-edits');
  service.close();

  const restrictive = serverProvider({
    instanceId: 'codex',
    driver: 'codex',
    models: models('gpt-5', true),
    supportedRuntimeModes: ['approval-required'],
  });
  const second = await runningService({
    providers: [restrictive],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await second.service.start(request());
  await assert.rejects(
    () => second.service.setRuntimeMode({ threadId: 'th-1', permissionMode: 'auto-edits' }),
    (error) => codeOf(error) === 'unsupported_control',
  );
  second.service.close();
});

test('setInteractionMode dispatches the plan mode for a tracked thread', async () => {
  const { fake, service } = await runningService({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.start(request());

  await service.setInteractionMode({ threadId: 'th-1', interactionMode: 'plan' });
  const command = fake.calls.commands.at(-1);
  assert.equal(command?.['type'], 'thread.interaction-mode.set');
  assert.equal(command?.['interactionMode'], 'plan');
  service.close();
});

test('switchProvider dispatches provider.switch and updates the thread instance', async () => {
  const { fake, service } = await runningService({
    providers: [codexProvider(), opencodeProvider()],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.start(request());

  await service.switchProvider({ threadId: 'th-1', provider: 'opencode', model: 'mini' });
  const command = fake.calls.commands.at(-1);
  assert.equal(command?.['type'], 'provider.switch');
  assert.deepEqual(command?.['modelSelection'], { instanceId: 'opencode', model: 'mini' });
  assert.equal(service.instanceIdForThread('th-1'), 'opencode');
  service.close();
});

test('switchProvider refuses a provider with no models and no explicit model', async () => {
  const { service } = await runningService({
    providers: [codexProvider(), serverProvider({ instanceId: 'claudeAgent', driver: 'claudeAgent', models: [] })],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  await service.start(request());

  await assert.rejects(
    () => service.switchProvider({ threadId: 'th-1', provider: 'claude-code' }),
    (error) => codeOf(error) === 'unsupported_provider',
  );
  service.close();
});

// --- permission intersection -----------------------------------------------------------------

test('permissionModesFor intersects the connection modes with what the provider reports', async () => {
  const provider = serverProvider({
    instanceId: 'codex',
    driver: 'codex',
    models: models('gpt-5', true),
    supportedRuntimeModes: ['approval-required', 'full-access'],
  });
  const { service } = await runningService({
    providers: [provider],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });

  assert.deepEqual(await service.permissionModesFor('codex'), ['supervised', 'full-local']);
  // An undiscovered provider falls back to the connection's enforceable set, never widened.
  assert.deepEqual(await service.permissionModesFor('opencode'), ['supervised', 'auto-edits', 'auto', 'full-local']);
  service.close();
});

// --- launch reuse ----------------------------------------------------------------------------

test('follow-up messages dispatch on the existing thread after applying selected permissions', async () => {
  const { fake, refs, service } = await runningService({
    providers: [codexProvider()], projects: [{ id: 'project-1', workspaceRoot: 'C:/work' }], projection: projection({ threadId: 'th-1', runs: [{ ...run('run-1', 'completed', 1), userMessageId: 'previous-message' }] }),
  });
  refs.set('run-1', refFor('th-1', 'run-1'));
  const result = await service.start(request({ permissionMode: 'full-local' }));
  assert.equal(fake.calls.launches.length, 0);
  assert.deepEqual(fake.calls.commands.map(command => command.type), ['thread.runtime-mode.set', 'message.dispatch']);
  assert.equal(fake.calls.commands[0]?.['runtimeMode'], 'full-access');
  assert.match(String(fake.calls.commands[1]?.['text']), /^Fix the save bug\n\n\[Forgon scene authoring guidance:/);
  assert.match(String(fake.calls.commands[1]?.['text']), /clean, meaningful hierarchy using parentId/);
  assert.notEqual(result.runId, 'run-1');
  assert.equal(refs.get(result.runId)?.permissionMode, 'full-local');
  service.close();
});
