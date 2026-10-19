import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentBridgeError } from '@forgon/agent-bridge';
import type { AgentContext, AgentEvent, AgentRunRequest } from '@forgon/project-schema';
import { createAgentService, type ThreadRef, type ThreadRefStore } from '../src/index.js';
import { NOW, createFakeConnection, event, models, projection, run, serverProvider, tick } from './helpers.js';

const context = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  files: [],
  entityIds: [],
  assetIds: [],
  ...overrides,
});

const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  threadId: 'th-1',
  provider: 'codex',
  prompt: 'Fix the save bug',
  projectRoot: 'C:/work',
  permissionMode: 'supervised',
  context: context(),
  ...overrides,
});

const createStore = (): { store: ThreadRefStore; refs: Map<string, ThreadRef> } => {
  const refs = new Map<string, ThreadRef>();
  const store: ThreadRefStore = {
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
  };
  return { store, refs };
};

const codexProvider = () =>
  serverProvider({ instanceId: 'codex', driver: 'codex', models: models('gpt-5', true) });

const setup = (config: Parameters<typeof createFakeConnection>[0] = {
  providers: [codexProvider()],
  projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
}) => {
  const fake = createFakeConnection(config);
  const { store, refs } = createStore();
  return { fake, store, refs };
};

test('start launches a thread with the mapped runtime mode and always sends the prompt', async () => {
  const { fake, store, refs } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });

  const { runId } = await service.start(request());
  assert.equal(runId, 'run-1');

  const launch = fake.calls.launches[0];
  assert.ok(launch !== undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(launch, 'createdBy'), false);
  assert.equal(launch['creationSource'], 'web');
  assert.equal(launch['runtimeMode'], 'approval-required');
  assert.equal(launch['threadId'], 'th-1');
  assert.equal(launch['interactionMode'], 'default');
  assert.deepEqual(launch['workspaceStrategy'], { type: 'root' });
  assert.deepEqual(launch['modelSelection'], { instanceId: 'codex', model: 'gpt-5' });
  const initialMessage = launch['initialMessage'] as { text: string; attachments: unknown[] };
  assert.ok(initialMessage.text.startsWith('Fix the save bug\n\n'));
  assert.match(initialMessage.text, /clean, meaningful hierarchy using parentId/);
  assert.match(initialMessage.text, /preserve existing world transforms, stable IDs/);
  assert.deepEqual(initialMessage.attachments, []);

  const ref = refs.get('run-1');
  assert.equal(ref?.provider, 'codex');
  assert.equal(ref?.permissionMode, 'supervised');
  assert.equal(ref?.projectRoot, 'C:/work');
  assert.equal(fake.calls.subscribes[0]?.threadId, 'th-1');
  service.close();
});

test('start sends composer context only when there is something to send', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });

  await service.start(request({ context: context({ files: ['src/a.ts'], sceneId: 'scene-1' }) }));
  const launch = fake.calls.launches[0];
  assert.ok(launch !== undefined);
  const initialMessage = launch['initialMessage'] as { text: string; context?: { records: unknown[] } };
  assert.ok(initialMessage.text.startsWith('Fix the save bug\n\n'));
  assert.equal(initialMessage.context?.records.length, 2);
  service.close();
});

test('start refuses inspect when Forgon does not enforce it, before any launch', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  await assert.rejects(
    service.start(request({ permissionMode: 'inspect' })),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'unsupported_permission_mode',
  );
  assert.equal(fake.calls.launches.length, 0);
  service.close();
});

test('start allows inspect only when Forgon enforces it', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({
    connection: fake.connection,
    store,
    now: () => NOW,
    forgonEnforcesInspect: true,
    idFactory: (prefix) => `${prefix}-1`,
  });
  await service.start(request({ permissionMode: 'inspect' }));
  assert.equal(fake.calls.launches[0]?.['runtimeMode'], 'approval-required');
  service.close();
});

test('start refuses to fabricate a default model when the provider reports none', async () => {
  const { fake, store } = setup({
    providers: [serverProvider({ instanceId: 'codex', driver: 'codex', models: [] })],
    projection: projection({ threadId: 'th-1', runs: [run('run-1', 'running')] }),
  });
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  await assert.rejects(
    service.start(request()),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'unsupported_provider',
  );
  assert.equal(fake.calls.launches.length, 0);
  service.close();
});

test('start refuses an unsupported provider', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  await assert.rejects(
    service.start(request({ provider: 'gemini' as AgentRunRequest['provider'] })),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'unsupported_provider',
  );
  service.close();
});

test('cancel refuses an untracked run and interrupts a tracked one', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });

  await assert.rejects(
    service.cancel('ghost'),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'run_not_found',
  );

  const { runId } = await service.start(request());
  await service.cancel(runId);
  const command = fake.calls.commands.at(-1);
  assert.equal(command?.['type'], 'run.interrupt');
  assert.equal(command?.['runId'], 'run-1');
  assert.equal(command?.['threadId'], 'th-1');
  service.close();
});

test('approve refuses a request this session never received', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });
  const { runId } = await service.start(request());

  await assert.rejects(
    service.approve(runId, 'never-issued', true),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'approval_unbound',
  );
  assert.equal(fake.calls.commands.length, 0);
  service.close();
});

test('approve binds to the pending request and cannot be replayed', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });
  const { runId } = await service.start(request());

  fake.push(
    event(1, 'turn-item.updated', {
      id: 'item-1',
      threadId: 'th-1',
      runId,
      ordinal: 0,
      status: 'waiting',
      updatedAt: NOW,
      type: 'approval_request',
      requestId: 'req-1',
      requestKind: 'command',
      prompt: 'Run the build?',
    }),
  );
  await tick();

  await service.approve(runId, 'req-1', true);
  const command = fake.calls.commands.at(-1);
  assert.equal(command?.['type'], 'runtime-request.respond');
  assert.equal(command?.['requestId'], 'req-1');
  assert.equal(command?.['decision'], 'accept');

  await assert.rejects(
    service.approve(runId, 'req-1', true),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'approval_unbound',
  );
  service.close();
});

test('approve with allow=false declines', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });
  const { runId } = await service.start(request());
  fake.push(
    event(1, 'turn-item.updated', {
      id: 'item-1',
      threadId: 'th-1',
      runId,
      ordinal: 0,
      status: 'waiting',
      updatedAt: NOW,
      type: 'approval_request',
      requestId: 'req-2',
      requestKind: 'permission',
    }),
  );
  await tick();
  await service.approve(runId, 'req-2', false);
  assert.equal(fake.calls.commands.at(-1)?.['decision'], 'decline');
  service.close();
});

test('events from the subscribed thread reach subscribers', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });
  const events: AgentEvent[] = [];
  service.subscribe((event) => events.push(event));

  await service.start(request());
  fake.push(event(1, 'run.updated', { ...run('run-1', 'running'), id: 'run-1' }));
  fake.push(
    event(2, 'turn-item.updated', {
      id: 'item-1',
      threadId: 'th-1',
      runId: 'run-1',
      ordinal: 0,
      status: 'running',
      updatedAt: NOW,
      type: 'assistant_message',
      text: 'Working on it',
      messageId: 'm-1',
      streaming: true,
    }),
  );
  await tick();

  assert.deepEqual(events.map((entry) => entry.type), ['started', 'text']);
  assert.equal((events[1] as { text: string }).text, 'Working on it');
  service.close();
});

test('listProviders reports readiness, models and reported limits', async () => {
  const { fake, store } = setup({
    providers: [
      serverProvider({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', models: models('gpt-5', true) }),
      serverProvider({
        instanceId: 'claude-agent',
        driver: 'claudeAgent',
        displayName: 'Claude Code',
        auth: { status: 'unauthenticated' },
      }),
      serverProvider({
        instanceId: 'opencode',
        driver: 'opencode',
        displayName: 'OpenCode',
        models: models('o1'),
        reportsContextWindow: false,
        supportsConversationRollback: false,
      }),
      serverProvider({ instanceId: 'other', driver: 'gemini' }),
    ],
    projection: projection({ threadId: 'th-1', runs: [] }),
  });
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });

  const infos = await service.listProviders();
  assert.equal(infos.length, 3);

  const codex = infos.find((info) => info.id === 'codex');
  assert.equal(codex?.readiness, 'ready');
  assert.deepEqual(codex?.models, ['gpt-5']);
  assert.deepEqual(codex?.permissionModes, ['supervised', 'auto-edits', 'auto', 'full-local']);

  const claude = infos.find((info) => info.id === 'claude-code');
  assert.equal(claude?.readiness, 'not-ready');
  assert.match(claude?.message ?? '', /Sign in/);

  const opencode = infos.find((info) => info.id === 'opencode');
  assert.deepEqual(opencode?.limits, [
    'Context window not reported by the provider.',
    'Conversation rollback is not supported by this provider.',
  ]);
  service.close();
});

test('listProviders marks a ready provider with no models as not-ready', async () => {
  const { fake, store } = setup({
    providers: [serverProvider({ instanceId: 'codex', driver: 'codex', models: [] })],
    projection: projection({ threadId: 'th-1', runs: [] }),
  });
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  const infos = await service.listProviders();
  assert.equal(infos[0]?.readiness, 'not-ready');
  assert.match(infos[0]?.message ?? '', /no models/);
  service.close();
});

test('refreshProviders returns a fresh snapshot', async () => {
  const { fake, store } = setup({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [] }),
  });
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  assert.deepEqual((await service.listProviders()).map((info) => info.id), ['codex']);

  fake.setProviders([
    codexProvider(),
    serverProvider({ instanceId: 'opencode', driver: 'opencode', models: models('o1') }),
  ]);
  assert.deepEqual((await service.refreshProviders()).map((info) => info.id), ['codex', 'opencode']);
  service.close();
});

test('availableProviders lists only Forgon adapters that are installed and enabled', async () => {
  const { fake, store } = setup({
    providers: [codexProvider(), serverProvider({ instanceId: 'opencode', driver: 'opencode', installed: false })],
    projection: projection({ threadId: 'th-1', runs: [] }),
  });
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  assert.deepEqual(await service.availableProviders(), ['codex']);
  service.close();
});

test('connection() carries the last provider snapshot and a working refresh', async () => {
  const { fake, store } = setup({
    providers: [codexProvider()],
    projection: projection({ threadId: 'th-1', runs: [] }),
  });
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });

  const beforeDiscovery = service.connection();
  assert.deepEqual(beforeDiscovery.providers, []);

  await service.listProviders();
  const connection = service.connection();
  assert.deepEqual(connection.providers.map((info) => info.id), ['codex']);
  assert.ok(connection.refreshProviders !== undefined);
  assert.deepEqual((await connection.refreshProviders()).map((info) => info.id), ['codex']);
  service.close();
});

test('threadRefs returns persisted refs after a start', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW, idFactory: (prefix) => `${prefix}-1` });
  await service.start(request());
  const refs = await service.threadRefs();
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.runId, 'run-1');
  service.close();
});

test('close clears listeners and closes the connection', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  const events: AgentEvent[] = [];
  service.subscribe((event) => events.push(event));
  service.close();
  assert.equal(fake.closeCalls(), 1);

  fake.push(event(1, 'run.updated', run('run-1', 'running')));
  await tick();
  assert.deepEqual(events, []);
});

test('Full local questions require answers, retain provider values and remain retryable after failure', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  const events: AgentEvent[] = [];
  service.subscribe(event => events.push(event));
  const { runId } = await service.start(request({ permissionMode: 'full-local' }));
  assert.equal(fake.calls.launches[0]?.['runtimeMode'], 'full-access');
  fake.push(event(1, 'runtime-request.updated', { id: 'question-1', kind: 'user_input', status: 'pending' }));
  fake.push(event(2, 'turn-item.updated', { id: 'item-q', threadId: 'th-1', runId, ordinal: 0, status: 'waiting', updatedAt: NOW,
    type: 'user_input_request', requestId: 'question-1', questions: [
      { id: 'direction', header: 'Direction', question: 'Which direction?', allowCustomAnswer: false,
        options: [{ label: 'North', description: 'Towards the station', value: 'north-id' }] },
      { id: 'details', header: 'Details', question: 'Anything else?', options: [] },
      { id: 'optional', header: 'Optional', question: 'Extra notes?', options: [], required: false },
      { id: 'features', header: 'Features', question: 'Choose features', multiSelect: true, allowCustomAnswer: false, options: [{ label: 'Trees', description: 'Plant trees', value: 'trees' }, { label: 'Water', description: 'Add water', value: 'water' }] },
    ] }));
  await tick();
  assert.equal(events.some(event => event.type === 'approval'), false);
  assert.equal(events.some(event => event.type === 'input'), true);
  await assert.rejects(service.approve(runId, 'question-1', true));
  await assert.rejects(service.answer(runId, 'question-1', { direction: 'made-up', details: 'Trees' }));
  await assert.rejects(service.answer(runId, 'question-1', { direction: 'north-id' }));
  await assert.rejects(service.answer(runId, 'question-1', { direction: 'north-id', details: 'Trees', unknown: 'x' }));
  const dispatch = fake.connection.orchestration.dispatchCommand;
  fake.connection.orchestration.dispatchCommand = async () => { throw new Error('Disconnected'); };
  const answers = { direction: 'north-id', details: 'Add trees', features: ['trees', 'water'] };
  await assert.rejects(service.answer(runId, 'question-1', answers), /Disconnected/);
  fake.connection.orchestration.dispatchCommand = dispatch;
  await service.answer(runId, 'question-1', answers);
  assert.deepEqual(fake.calls.commands.at(-1)?.['answers'], answers);
  assert.equal(fake.calls.commands.at(-1)?.['decision'], undefined);
  await assert.rejects(service.answer(runId, 'question-1', answers));
  service.close();
});

test('approval dispatch failure permits a retry but not simultaneous or cross-run responses', async () => {
  const { fake, store } = setup();
  const service = await createAgentService({ connection: fake.connection, store, now: () => NOW });
  const { runId } = await service.start(request());
  fake.push(event(1, 'turn-item.updated', { id: 'item-a', threadId: 'th-1', runId, ordinal: 0, status: 'waiting', updatedAt: NOW,
    type: 'approval_request', requestId: 'approve-1', requestKind: 'command', prompt: 'Run command?' }));
  fake.push(event(2, 'turn-item.updated', { id: 'item-other', threadId: 'th-1', runId: 'another-run', ordinal: 1, status: 'waiting', updatedAt: NOW,
    type: 'approval_request', requestId: 'other-request', requestKind: 'command', prompt: 'Run other command?' }));
  await tick();
  await assert.rejects(service.approve(runId, 'other-request', true));
  const dispatch = fake.connection.orchestration.dispatchCommand;
  let rejectDispatch!: (error: Error) => void;
  fake.connection.orchestration.dispatchCommand = () => new Promise((_resolve, reject) => { rejectDispatch = reject; });
  const response = service.approve(runId, 'approve-1', true);
  await assert.rejects(service.approve(runId, 'approve-1', true));
  rejectDispatch(new Error('Connection lost'));
  await assert.rejects(response, /Connection lost/);
  fake.connection.orchestration.dispatchCommand = dispatch;
  await service.approve(runId, 'approve-1', true);
  service.close();
});

test('reported reasoning choices reach initial and subsequent messages with selected permissions', async () => {
  const descriptor = { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] };
  const { fake, store } = setup({ providers: [serverProvider({ instanceId: 'codex', driver: 'codex', supportedRuntimeModes: ['approval-required', 'auto', 'full-access'],
    models: [{ ...models('gpt-5', true)[0]!, capabilities: { optionDescriptors: [descriptor] } }] })],
    projects: [{ id: 'project-1', workspaceRoot: 'C:/work' }], projection: projection({ threadId: 'th-1', runs: [run('run-1', 'completed')] }) });
  const service = await createAgentService({ connection: fake.connection, store });
  const info = (await service.listProviders())[0]!;
  assert.equal(info.defaultModel, 'gpt-5'); assert.equal(info.modelOptions?.['gpt-5']?.[0]?.id, 'reasoningEffort');
  const modelOptions = [{ id: 'reasoningEffort', value: 'high' }];
  await service.start(request({ permissionMode: 'auto', modelOptions }));
  assert.equal(fake.calls.launches[0]?.['runtimeMode'], 'auto');
  assert.deepEqual(fake.calls.launches[0]?.['modelSelection'], { instanceId: 'codex', model: 'gpt-5', options: modelOptions });
  const next = await service.start(request({ permissionMode: 'full-local', modelOptions: [{ id: 'reasoningEffort', value: 'low' }] }));
  assert.notEqual(next.runId, 'run-1');
  assert.equal(fake.calls.commands.at(-2)?.['runtimeMode'], 'full-access');
  assert.deepEqual(fake.calls.commands.at(-1)?.['modelSelection'], { instanceId: 'codex', model: 'gpt-5', options: [{ id: 'reasoningEffort', value: 'low' }] });
  const count = fake.calls.commands.length;
  await assert.rejects(service.start(request({ modelOptions: [{ id: 'reasoningEffort', value: 'invented' }] })), /does not support/);
  await assert.rejects(service.start(request({ permissionMode: 'auto-edits' })), /does not support/);
  assert.equal(fake.calls.commands.length, count);
  service.close();
});
