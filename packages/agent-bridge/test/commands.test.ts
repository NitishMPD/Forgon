import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGON_CREATION,
  MAX_CONTEXT_FILES,
  approvalDecisionFor,
  buildCheckpointRollback,
  buildLaunchThreadInput,
  buildMessageContext,
  buildMessageDispatch,
  buildProviderSwitch,
  buildRunInterrupt,
  buildRuntimeRequestRespond,
  buildThreadInteractionModeSet,
  buildThreadModelSelectionSet,
  buildThreadRuntimeModeSet,
  defaultIdFactory,
  sessionApprovalDecision,
} from '../src/index.js';
import type { AgentContext } from '@forgon/project-schema';

const context = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  files: [],
  entityIds: [],
  assetIds: [],
  ...overrides,
});

test('buildLaunchThreadInput never sends createdBy but sends creationSource', () => {
  const input = buildLaunchThreadInput({
    commandId: 'cmd-1',
    projectId: 'proj-1',
    title: 'Fix the save bug',
    modelSelection: { instanceId: 'codex', model: 'gpt-5' },
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    workspaceStrategy: { type: 'root' },
  });
  assert.equal(input['createdBy'], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'createdBy'), false);
  assert.equal(input['creationSource'], 'web');
  assert.deepEqual(input['workspaceStrategy'], { type: 'root' });
});

test('buildLaunchThreadInput includes an initialMessage with an empty attachments array', () => {
  const input = buildLaunchThreadInput({
    commandId: 'cmd-1',
    projectId: 'proj-1',
    title: 't',
    modelSelection: { instanceId: 'codex', model: 'gpt-5' },
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    workspaceStrategy: { type: 'root' },
    initialMessage: { text: 'hello', messageId: 'msg-1' },
  });
  assert.deepEqual(input['initialMessage'], { text: 'hello', attachments: [], messageId: 'msg-1' });
});

test('buildLaunchThreadInput omits initialMessage when not supplied', () => {
  const input = buildLaunchThreadInput({
    commandId: 'cmd-1',
    projectId: 'proj-1',
    title: 't',
    modelSelection: { instanceId: 'codex', model: 'gpt-5' },
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    workspaceStrategy: { type: 'root' },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'initialMessage'), false);
});

test('buildMessageDispatch sends a start_immediately dispatch by default', () => {
  const command = buildMessageDispatch({
    threadId: 'th-1',
    messageId: 'msg-1',
    text: 'do it',
    commandId: 'cmd-1',
    creation: FORGON_CREATION,
  });
  assert.equal(command['type'], 'message.dispatch');
  assert.equal(command['createdBy'], 'user');
  assert.equal(command['creationSource'], 'web');
  assert.deepEqual(command['attachments'], []);
  assert.deepEqual(command['dispatchMode'], { type: 'start_immediately' });
});

test('buildRunInterrupt is the only cancel path and carries the run id', () => {
  const command = buildRunInterrupt({ commandId: 'cmd-1', threadId: 'th-1', runId: 'run-1', reason: 'stop' });
  assert.equal(command['type'], 'run.interrupt');
  assert.equal(command['runId'], 'run-1');
  assert.equal(command['reason'], 'stop');
});

test('buildRuntimeRequestRespond needs a decision or answers', () => {
  assert.throws(() =>
    buildRuntimeRequestRespond({ commandId: 'cmd-1', threadId: 'th-1', requestId: 'req-1' }),
  );
  const withDecision = buildRuntimeRequestRespond({
    commandId: 'cmd-1',
    threadId: 'th-1',
    requestId: 'req-1',
    decision: 'accept',
  });
  assert.equal(withDecision['decision'], 'accept');
});

test('approvalDecisionFor maps allow/deny to accept/decline and never to acceptAlways', () => {
  assert.equal(approvalDecisionFor(true), 'accept');
  assert.equal(approvalDecisionFor(false), 'decline');
  assert.equal(sessionApprovalDecision(), 'acceptForSession');
  assert.notEqual(approvalDecisionFor(true), 'acceptAlways');
});

test('buildCheckpointRollback requires an explicit restoreFiles flag', () => {
  const command = buildCheckpointRollback({
    commandId: 'cmd-1',
    threadId: 'th-1',
    scopeId: 'scope-1',
    checkpointId: 'cp-1',
    restoreFiles: false,
  });
  assert.equal(command['type'], 'checkpoint.rollback');
  assert.equal(command['restoreFiles'], false);
});

test('thread control commands carry the fields T3 expects', () => {
  assert.deepEqual(
    buildThreadModelSelectionSet({
      commandId: 'c',
      threadId: 't',
      modelSelection: { instanceId: 'codex', model: 'gpt-5' },
    }),
    {
      type: 'thread.model-selection.set',
      commandId: 'c',
      threadId: 't',
      modelSelection: { instanceId: 'codex', model: 'gpt-5' },
    },
  );
  assert.equal(
    buildThreadRuntimeModeSet({ commandId: 'c', threadId: 't', runtimeMode: 'full-access' })['runtimeMode'],
    'full-access',
  );
  assert.equal(
    buildThreadInteractionModeSet({ commandId: 'c', threadId: 't', interactionMode: 'plan' })['interactionMode'],
    'plan',
  );
  assert.equal(
    buildProviderSwitch({ commandId: 'c', threadId: 't', modelSelection: { instanceId: 'x', model: 'y' } })['type'],
    'provider.switch',
  );
});

test('buildMessageContext returns undefined for empty context', () => {
  assert.equal(buildMessageContext(context()), undefined);
});

test('buildMessageContext maps files to mention records and scene ids to one record', () => {
  const built = buildMessageContext(
    context({ files: ['src/a.ts', 'src/b.ts'], sceneId: 'scene-1', entityIds: ['e1'], assetIds: ['a1'] }),
  );
  assert.ok(built !== undefined);
  assert.equal(built.version, 1);
  assert.equal(built.records.length, 3);
  assert.deepEqual(built.records[0], {
    version: 1,
    contextId: 'forgon-file-0',
    label: 'src/a.ts',
    kind: 'mention',
    path: 'src/a.ts',
  });
  assert.deepEqual(built.records[2], {
    version: 1,
    contextId: 'forgon-scene',
    label: 'Forgon scene context',
    kind: 'forgon-scene',
    payload: { sceneId: 'scene-1', entityIds: ['e1'], assetIds: ['a1'] },
  });
});

test('buildMessageContext caps the number of file records', () => {
  const files = Array.from({ length: MAX_CONTEXT_FILES + 10 }, (_v, index) => `src/f${index}.ts`);
  const built = buildMessageContext(context({ files }));
  assert.ok(built !== undefined);
  assert.equal(built.records.length, MAX_CONTEXT_FILES);
});

test('defaultIdFactory produces a unique prefixed id', () => {
  const first = defaultIdFactory('cmd');
  const second = defaultIdFactory('cmd');
  assert.match(first, /^cmd-/);
  assert.notEqual(first, second);
});
