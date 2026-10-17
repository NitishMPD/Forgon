import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@forgon/project-schema';
import { createEntity, createScene, parseScene } from '@forgon/project-schema';
import { attachmentReferences, buildContext, chipStatus, clipboardFiles, insertMention, isSendKey, mentionOptions, mentionQuery, recallPrompt, sendBlockers, type ContextChip, type KeyLike } from '../src/agent/composerModel.js';
import { defaultPermissionMode, enforcementNote, providerLimitsNote } from '../src/agent/permissions.js';
import { agentReducer, newThread, threadStatus, type AgentState, type PendingRequest } from '../src/agent/threadState.js';
import type { AgentProviderInfo } from '../src/services.js';

const key = (overrides: Partial<KeyLike>): KeyLike => ({
  key: 'Enter', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...overrides,
});

test('Enter sends; modified Enter and IME composition never send', () => {
  assert.equal(isSendKey(key({})), true);
  assert.equal(isSendKey(key({ ctrlKey: true })), false);
  assert.equal(isSendKey(key({ shiftKey: true })), false);
  assert.equal(isSendKey(key({ altKey: true })), false);
  assert.equal(isSendKey(key({ metaKey: true })), false);
  assert.equal(isSendKey(key({ shiftKey: true, ctrlKey: true })), false);
  assert.equal(isSendKey(key({ isComposing: true })), false);
  assert.equal(isSendKey(key({ keyCode: 229 })), false);
  assert.equal(isSendKey(key({ key: 'a' })), false);
});

const provider: AgentProviderInfo = { id: 'codex', name: 'Codex', readiness: 'ready', models: [], permissionModes: ['inspect', 'supervised'] };

function scene() {
  const entity = createEntity('Desk');
  return { doc: parseScene({ ...createScene('Lobby'), entities: [entity] }), entity };
}

test('send blockers name every reason and never block on an empty draft', () => {
  const { doc, entity } = scene();
  const chips: ContextChip[] = [{ id: 'c1', kind: 'entity', ref: 'entity_gone', label: 'Gone' }];
  const base = { projectOpen: true, provider, permissionMode: 'supervised' as const, chips: [], scene: doc, assets: [] };
  assert.deepEqual(sendBlockers(base), []);
  assert.match(sendBlockers({ ...base, projectOpen: false })[0] ?? '', /Open a project/);
  assert.match(sendBlockers({ ...base, provider: null })[0] ?? '', /No provider/);
  assert.match(sendBlockers({ ...base, provider: { ...provider, readiness: 'not-ready', message: 'Log in first.' } })[0] ?? '', /not ready\. Log in first\./);
  assert.match(sendBlockers({ ...base, permissionMode: 'full-local' })[0] ?? '', /permission mode that Codex supports/);
  assert.match(sendBlockers({ ...base, chips })[0] ?? '', /1 context reference is no longer/);
  const live: ContextChip[] = [{ id: 'c2', kind: 'entity', ref: entity.id, label: 'Desk' }];
  assert.deepEqual(sendBlockers({ ...base, chips: live }), []);
});

test('unknown provider readiness is allowed to attempt a run, and the reason is not invented', () => {
  const { doc } = scene();
  const unknown = { ...provider, readiness: 'unknown' as const };
  assert.deepEqual(sendBlockers({ projectOpen: true, provider: unknown, permissionMode: 'supervised', chips: [], scene: doc, assets: [] }), []);
});

test('context chips map only onto AgentContext v1 fields and report missing targets', () => {
  const { doc, entity } = scene();
  const chips: ContextChip[] = [
    { id: 'a', kind: 'entity', ref: entity.id, label: 'Desk' },
    { id: 'b', kind: 'scene', ref: doc.sceneId, label: 'Lobby' },
    { id: 'c', kind: 'asset', ref: 'asset_1', label: 'Guest' },
  ];
  assert.deepEqual(buildContext(chips), { files: [], sceneId: doc.sceneId, entityIds: [entity.id], assetIds: ['asset_1'] });
  assert.equal(chipStatus(chips[0]!, doc, []), 'ok');
  assert.equal(chipStatus({ id: 'x', kind: 'entity', ref: 'entity_missing', label: 'x' }, doc, []), 'missing');
  assert.equal(chipStatus(chips[2]!, doc, []), 'missing');
});

test('file attachments reference only unique project assets, never guessed paths or uploaded bytes', () => {
  const assets = [
    { id: 'a1', name: 'Rock', kind: 'model' as const, path: 'assets/rock.glb' },
    { id: 'a2', name: 'Brick', kind: 'texture' as const, path: 'assets/brick.png' },
    { id: 'a3', name: 'Other brick', kind: 'texture' as const, path: 'other/brick.png' },
  ];
  const file = (name: string, webkitRelativePath = '') => ({ name, webkitRelativePath });
  const { chips, rejected } = attachmentReferences([file('rock.glb'), file('rock.glb'), file('brick.png'), file('outside.txt'), file('../secret'), file('brick.png', 'assets/brick.png')], assets);
  assert.deepEqual(chips.map(chip => chip.ref), ['assets/rock.glb', 'assets/brick.png']);
  assert.deepEqual(rejected, ['brick.png', 'outside.txt', '../secret']);
  assert.deepEqual(buildContext([...chips, chips[0]!]), { files: ['assets/rock.glb', 'assets/brick.png'], entityIds: [], assetIds: [] });
  assert.equal(chipStatus(chips[0]!, null, assets), 'ok');
  assert.equal(chipStatus(chips[0]!, null, []), 'missing');
  assert.equal(attachmentReferences([file('rock.glb', '../assets/rock.glb')], assets).chips.length, 0);
});

test('paste reads files once and falls back to file items without swallowing ordinary text', () => {
  const file = new File(['x'], 'image.png', { type: 'image/png' });
  const item = { kind: 'file', getAsFile: () => file };
  const data = (files: File[], items: unknown[]) => ({ files, items }) as unknown as Pick<DataTransfer, 'files' | 'items'>;
  assert.deepEqual(clipboardFiles(data([file], [item])), [file]);
  assert.deepEqual(clipboardFiles(data([], [item, { kind: 'string' }, { kind: 'file', getAsFile: () => null }])), [file]);
  assert.deepEqual(clipboardFiles(data([], [{ kind: 'string' }])), []);
});

test('@ filtering finds entities, scenes, asset names and project paths; insertion preserves surrounding text', () => {
  const { doc, entity } = scene();
  const assets = [{ id: 'tex', name: 'Stone', kind: 'texture' as const, path: 'assets/wall.png' }];
  assert.equal(mentionOptions(doc, assets, 'DESK')[0]?.ref, entity.id);
  assert.equal(mentionOptions(doc, assets, 'lobby')[0]?.kind, 'scene');
  assert.equal(mentionOptions(doc, assets, 'stone')[0]?.kind, 'asset');
  assert.equal(mentionOptions(doc, assets, 'wall.png')[0]?.kind, 'file');
  assert.deepEqual(mentionOptions(doc, assets, 'missing'), []);
  assert.equal(mentionQuery('mail@example.com', 16), null);
  assert.equal(mentionQuery('hello @', 7)?.query, '');
  const query = mentionQuery('Change @desk tomorrow', 12);
  assert.deepEqual(query, { start: 7, end: 12, query: 'desk' });
  assert.deepEqual(insertMention('Change @desk tomorrow', query!), { text: 'Change  tomorrow', caret: 7 });
});

test('prompt history walks backward and forward to empty, clamps at oldest, and never overwrites edits', () => {
  const prompts = ['First', 'Second'];
  const latest = recallPrompt(prompts, '', null, 'ArrowUp');
  assert.deepEqual(latest, { index: 1, text: 'Second' });
  const oldest = recallPrompt(prompts, latest!.text, latest, 'ArrowUp');
  assert.deepEqual(oldest, { index: 0, text: 'First' });
  assert.deepEqual(recallPrompt(prompts, oldest!.text, oldest, 'ArrowUp'), oldest);
  assert.deepEqual(recallPrompt(prompts, oldest!.text, oldest, 'ArrowDown'), latest);
  assert.deepEqual(recallPrompt(prompts, latest!.text, latest, 'ArrowDown'), { index: 2, text: '' });
  assert.equal(recallPrompt(prompts, 'Edited', latest, 'ArrowUp'), null);
  assert.equal(recallPrompt(prompts, 'New draft', null, 'ArrowUp'), null);
  assert.equal(recallPrompt(prompts, '', null, 'ArrowDown'), null);
  assert.equal(recallPrompt([], '', null, 'ArrowUp'), null);
});

test('permission descriptions never claim operating-system confinement or blanket enforcement', () => {
  for (const mode of ['inspect', 'supervised', 'auto-edits', 'full-local'] as const) {
    assert.doesNotMatch(enforcementNote(mode), /Enforced by Forgon/);
  }
  assert.match(enforcementNote('full-local'), /cannot limit what it does/i);
  assert.match(enforcementNote('inspect'), /not an operating-system sandbox/);
  assert.match(enforcementNote('supervised'), /cannot see provider actions/);
});

test('default permission mode never picks full-local on the user behalf', () => {
  assert.equal(defaultPermissionMode(['inspect', 'supervised']), 'supervised');
  assert.equal(defaultPermissionMode(['inspect']), 'inspect');
  assert.equal(defaultPermissionMode(['auto-edits', 'full-local']), 'auto-edits');
  assert.equal(defaultPermissionMode(['full-local']), null);
  assert.equal(defaultPermissionMode([]), null);
});

test('provider limits show what the adapter reported, and say so when nothing was reported', () => {
  assert.match(providerLimitsNote({ limits: ['Cannot roll back edits.'] }), /Cannot roll back edits\./);
  assert.match(providerLimitsNote({}), /did not report its limits/);
});

function request(id: string): PendingRequest {
  return { id, text: `Do ${id}`, provider: 'codex', model: null, permissionMode: 'supervised', context: { files: [], entityIds: [], assetIds: [] } };
}

function event(sequence: number, body: { type: string } & Record<string, unknown>): AgentEvent {
  return { runId: 'run_1', threadId: 'thread_1', sequence, timestamp: '2026-10-17T00:00:00.000Z', ...body } as AgentEvent;
}

function start(): AgentState {
  const initial: AgentState = { threads: [], activeThreadId: null };
  const created = agentReducer(initial, { type: 'thread/ensure', thread: newThread('thread_1', 'codex', 'supervised', null) });
  return agentReducer(created, { type: 'run/requested', threadId: 'thread_1', request: request('r1'), fromQueue: false });
}

test('thread ensure is idempotent so StrictMode cannot create two threads', () => {
  const once = agentReducer({ threads: [], activeThreadId: null }, { type: 'thread/ensure', thread: newThread('thread_1', 'codex', 'supervised', null) });
  const twice = agentReducer(once, { type: 'thread/ensure', thread: newThread('thread_2', 'codex', 'supervised', null) });
  assert.equal(twice.threads.length, 1);
  assert.equal(twice, once);
});

test('events fold into one transcript: text merges, tool lines update, approvals close on completion', () => {
  let state = start();
  const dispatch = (action: Parameters<typeof agentReducer>[1]) => { state = agentReducer(state, action); };
  dispatch({ type: 'run/started', threadId: 'thread_1', runId: 'run_1' });
  dispatch({ type: 'event', event: event(1, { type: 'started', provider: 'codex' }) });
  dispatch({ type: 'event', event: event(2, { type: 'text', text: 'Hello ' }) });
  dispatch({ type: 'event', event: event(3, { type: 'text', text: 'there' }) });
  dispatch({ type: 'event', event: event(4, { type: 'tool', name: 'forge scene validate', state: 'started' }) });
  dispatch({ type: 'event', event: event(5, { type: 'tool', name: 'forge scene validate', state: 'completed', text: 'exit 0' }) });
  dispatch({ type: 'event', event: event(6, { type: 'approval', requestId: 'req_1', description: 'Write scenes/lobby.scene.json' }) });
  dispatch({ type: 'event', event: event(7, { type: 'diff', paths: ['scenes/lobby.scene.json'] }) });
  const thread = state.threads[0]!;
  const assistant = thread.transcript.find(item => item.kind === 'assistant');
  assert.equal(assistant?.kind === 'assistant' ? assistant.text : null, 'Hello there');
  const tool = thread.transcript.find(item => item.kind === 'tool');
  assert.equal(tool?.kind === 'tool' ? tool.state : null, 'completed');
  assert.equal(threadStatus(thread), 'awaiting_approval');
  assert.deepEqual(thread.changedPaths, ['scenes/lobby.scene.json']);

  dispatch({ type: 'event', event: event(8, { type: 'completed', outcome: 'succeeded' }) });
  const done = state.threads[0]!;
  assert.equal(threadStatus(done), 'changes');
  assert.equal(done.activeRunId, null);
  const approval = done.transcript.find(item => item.kind === 'approval');
  assert.equal(approval?.kind === 'approval' ? approval.state : null, 'closed');
});

test('duplicate and out-of-order sequences are ignored; events never approve on their own', () => {
  let state = start();
  state = agentReducer(state, { type: 'event', event: event(2, { type: 'text', text: 'b' }) });
  state = agentReducer(state, { type: 'event', event: event(1, { type: 'text', text: 'a' }) });
  state = agentReducer(state, { type: 'event', event: event(2, { type: 'text', text: 'dup' }) });
  const assistant = state.threads[0]!.transcript.find(item => item.kind === 'assistant');
  assert.equal(assistant?.kind === 'assistant' ? assistant.text : null, 'b');
  const approvals = state.threads[0]!.transcript.filter(item => item.kind === 'approval');
  assert.equal(approvals.length, 0);
});

test('approval answers are recorded only after the caller sends them, and cancel marks the thread stopped', () => {
  let state = start();
  state = agentReducer(state, { type: 'event', event: event(1, { type: 'approval', requestId: 'req_1', description: 'Run forge test' }) });
  state = agentReducer(state, { type: 'approval/answered', threadId: 'thread_1', runId: 'run_1', requestId: 'req_1', allow: false });
  const denied = state.threads[0]!.transcript.find(item => item.kind === 'approval');
  assert.equal(denied?.kind === 'approval' ? denied.state : null, 'denied');
  state = agentReducer(state, { type: 'event', event: event(2, { type: 'completed', outcome: 'cancelled' }) });
  assert.equal(threadStatus(state.threads[0]!), 'stopped');
});

test('failed start is reported on the thread, and a new request can start afterwards', () => {
  let state = start();
  state = agentReducer(state, { type: 'run/failed', threadId: 'thread_1', requestId: 'r1', message: 'spawn ENOENT' });
  assert.equal(threadStatus(state.threads[0]!), 'failed');
  const last = state.threads[0]!.transcript.at(-1);
  assert.equal(last?.kind === 'status' ? last.text : null, 'Failed to start: spawn ENOENT');
  state = agentReducer(state, { type: 'run/requested', threadId: 'thread_1', request: request('r2'), fromQueue: false });
  assert.equal(threadStatus(state.threads[0]!), 'starting');
});

test('queued prompts leave the queue only when they start', () => {
  let state = start();
  state = agentReducer(state, { type: 'queue/add', threadId: 'thread_1', request: request('q1') });
  assert.equal(state.threads[0]!.queue.length, 1);
  state = agentReducer(state, { type: 'event', event: event(1, { type: 'completed', outcome: 'succeeded' }) });
  state = agentReducer(state, { type: 'run/requested', threadId: 'thread_1', request: request('q1'), fromQueue: true });
  assert.equal(state.threads[0]!.queue.length, 0);
});
