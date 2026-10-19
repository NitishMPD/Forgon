import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityGroupRow, ActivityStepRow, PendingApproval, PendingInput } from '../src/agent/AgentDock.js';
import { activityDuration, activityGroupLabel, activityText, commandLabel, groupActivity, unwrapCommand, type ActivityGroup } from '../src/agent/activityModel.js';
import { agentReducer, newThread, type AgentState, type TranscriptItem } from '../src/agent/threadState.js';

const tool = (id: string, name = 'command', text = 'rg --files'): Extract<TranscriptItem, { kind: 'tool' }> => ({ id, kind: 'tool', runId: 'run', name, text, state: 'completed' });
const group = (items: TranscriptItem[], runId: string | null = null): ActivityGroup => {
  const rows = groupActivity(items, runId);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, 'activity');
  return row as ActivityGroup;
};

test('consecutive commands, searches, edits and checkpoints group; assistant and user text split groups', () => {
  const items: TranscriptItem[] = [tool('a'), tool('b', 'file-search'), { id: 'c', kind: 'diff', runId: 'run', paths: ['src/app.ts'] }, tool('d', 'checkpoint')];
  const result = group(items);
  assert.deepEqual(result.steps.map(step => step.kind), ['command', 'search', 'edit', 'checkpoint']);
  assert.equal(activityGroupLabel(result), 'Worked · 4 steps');
  const assistant: TranscriptItem = { id: 'text', kind: 'assistant', runId: 'run', text: 'Checking this.' };
  const user: TranscriptItem = { id: 'user', kind: 'user', text: 'Continue' };
  assert.deepEqual(groupActivity([tool('a'), assistant, tool('b'), user, tool('c')], null).map(row => row.kind), ['activity', 'assistant', 'activity', 'user', 'activity']);
  assert.equal(groupActivity([assistant], null)[0], assistant);
  assert.equal(groupActivity([tool('a'), { ...tool('b'), runId: 'other' }], null).length, 2);
});

test('command labels strip PowerShell executable/options and truncate without losing full detail', () => {
  for (const wrapper of ['powershell.exe -Command', 'pwsh -NoProfile -Command', '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NonInteractive -Command']) {
    assert.equal(commandLabel(`${wrapper} "rg --files"\nREADME.md`), 'rg --files');
    assert.equal(commandLabel(`${wrapper} "rg --files"\n"quoted output"`), 'rg --files');
    assert.equal(commandLabel(`${wrapper} 'Get-ChildItem'`), 'Get-ChildItem');
  }
  assert.equal(unwrapCommand('powershell.exe -Command "Get-ChildItem"'), 'Get-ChildItem');
  assert.equal(commandLabel('rg --files\noutput'), 'rg --files');
  assert.equal(commandLabel(''), 'Run command');
  const command = `rg ${'long-path/'.repeat(20)}`;
  assert.equal(commandLabel(command).length, 72);
  assert.ok(commandLabel(command).endsWith('…'));
  assert.equal(group([tool('a', 'command', command)]).steps[0]!.detail, command);
  assert.equal(activityText('  script\n    indented output'), 'script\n    indented output');
});

test('answered approvals are quiet steps; pending approvals break groups and retain actions', () => {
  const approval: TranscriptItem = { id: 'approval', kind: 'approval', runId: 'run', requestId: 'request', description: 'powershell.exe -Command "rg --files"', state: 'allowed' };
  const answered = group([tool('a'), approval, tool('b')]);
  assert.equal(answered.steps[1]!.label, 'Approved once');
  const html = renderToStaticMarkup(<ActivityGroupRow group={answered} />);
  assert.match(html, /Approved once/);
  assert.doesNotMatch(html, /Approval request|Supervised|Approve once|Deny/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /<ul[^>]*hidden=""/);
  const pending = { ...approval, state: 'pending' as const };
  assert.deepEqual(groupActivity([tool('a'), pending, tool('b')], 'run').map(row => row.kind), ['activity', 'approval', 'activity']);
  const answers: unknown[][] = [];
  const card = PendingApproval({ item: pending, onApprove: (...args) => answers.push(args) });
  const markup = renderToStaticMarkup(card);
  assert.match(markup, /Approval request/);
  assert.match(markup, /Approve once/);
  assert.match(markup, /Deny/);
  // Buttons retain the original run/request addressing.
  const toolbar = card.props.children[3];
  toolbar.props.children[0].props.onClick();
  toolbar.props.children[1].props.onClick();
  assert.deepEqual(answers, [['run', 'request', true], ['run', 'request', false]]);
  assert.equal(group([{ ...approval, state: 'denied' }]).steps[0]!.state, 'failed');
});

test('exit diagnostics attach to the command, omit thread IDs and do not mutate input', () => {
  const command = tool('a');
  const diagnostic: TranscriptItem = { id: 'd', kind: 'diagnostic', runId: 'run', diagnostic: { path: 'thread_1234-5678', message: 'thread_1234-5678 command exited with code 1' } };
  const result = group([command, diagnostic]);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.state, 'failed');
  assert.equal(result.steps[0]!.failureReason, 'command exited with code 1');
  assert.equal(command.kind === 'tool' && command.state, 'completed');
  const html = renderToStaticMarkup(<ActivityGroupRow group={result} />);
  assert.doesNotMatch(html, /thread_1234|Warning/);
  assert.match(html, /command exited with code 1/);
  assert.match(html, /Failed step/);
  const standalone = group([diagnostic]);
  assert.equal(standalone.steps[0]!.label, 'command exited with code 1');
  assert.equal(standalone.steps[0]!.detail, '');
  const completion = group([command, { id: 'status', kind: 'status', runId: 'run', text: 'failed: thread_1234-5678 command exited with code 1' }]);
  assert.equal(completion.steps[0]!.failureReason, 'command exited with code 1');
});

test('duration uses event timestamps and running state ends with the run', () => {
  const started: TranscriptItem = { ...tool('a'), kind: 'tool', name: 'command', text: 'rg --files', state: 'started', timestamp: '2026-10-17T12:00:00Z', completedAt: '2026-10-17T12:00:12Z' };
  const running = group([started], 'run');
  assert.equal(activityDuration(running.steps[0]!), '12s');
  assert.equal(activityGroupLabel(running), 'Working for 12s · 1 step');
  assert.equal(group([started]).steps[0]!.state, 'done');
  assert.equal(activityDuration({ timestamp: 'invalid', completedAt: 'invalid' }), null);
  assert.equal(activityDuration({ timestamp: '2026-10-17T12:00:12Z', completedAt: '2026-10-17T12:00:00Z' }), null);
  const markup = renderToStaticMarkup(<ActivityStepRow step={running.steps[0]!} />);
  assert.match(markup, /aria-label="Running"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /<pre/);
});

test('reducer retains a tool start and completion timestamp for presentation', () => {
  let state: AgentState = { threads: [newThread('thread', 'codex', 'supervised', null)], activeThreadId: 'thread' };
  for (const [sequence, timestamp, status] of [[1, '2026-10-17T12:00:00Z', 'started'], [2, '2026-10-17T12:00:12Z', 'completed']] as const) {
    state = agentReducer(state, { type: 'event', event: { type: 'tool', runId: 'run', threadId: 'thread', sequence, timestamp, name: 'command', text: 'rg --files', state: status } });
  }
  const result = group(state.threads[0]!.transcript);
  assert.equal(activityDuration(result.steps[0]!), '12s');
  assert.equal(result.steps.length, 1);
});

test('pending questions expose labelled choices and free text without approve/deny actions', () => {
  const item: Extract<TranscriptItem, { kind: 'input' }> = { id: 'q', kind: 'input', runId: 'run', requestId: 'q1', state: 'pending', questions: [
    { id: 'style', header: 'Style', question: 'Choose the city style', allowCustomAnswer: false, multiSelect: true, options: [{ label: 'Modern', description: 'Glass and steel', value: 'modern-id' }] },
    { id: 'details', header: 'Details', question: 'What should change?', options: [] },
  ] };
  const rows = groupActivity([item], 'run');
  assert.equal(rows[0]?.kind, 'input');
  const html = renderToStaticMarkup(<PendingInput item={item} onAnswer={async () => {}} />);
  assert.match(html, /Choose the city style/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /Glass and steel/);
  assert.match(html, /<textarea/);
  assert.match(html, /Send answers/);
  assert.doesNotMatch(html, /Approve once|Deny|Approval needed/);
});
