import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadEventMapper, parseDiffPaths } from '../src/index.js';
import type { AgentEvent } from '@forgon/project-schema';

const NOW = '2024-01-01T00:00:00.000Z';
const THREAD = 'th-1';

const streamEvent = (
  sequence: number,
  type: string,
  payload: unknown,
  occurredAt = NOW,
): Record<string, unknown> => ({
  kind: 'event',
  sequence,
  event: { id: `evt-${sequence}`, threadId: THREAD, occurredAt, type, payload },
});

const run = (id: string, status: string, ordinal = 1): Record<string, unknown> => ({
  id,
  threadId: THREAD,
  ordinal,
  providerInstanceId: 'codex',
  status,
  userMessageId: 'msg-1',
  requestedAt: NOW,
  completedAt: null,
});

const turnItem = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 'item-1',
  threadId: THREAD,
  runId: 'run-1',
  ordinal: 0,
  status: 'running',
  updatedAt: NOW,
  ...overrides,
});

const makeMapper = (): { mapper: ThreadEventMapper; events: AgentEvent[] } => {
  const events: AgentEvent[] = [];
  const mapper = new ThreadEventMapper({
    threadId: THREAD,
    provider: 'codex',
    now: () => NOW,
    onEvent: (event) => events.push(event),
  });
  return { mapper, events };
};

test('a run reports started once and completed once, in order', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-1', 'running')));
  mapper.applyStreamItem(streamEvent(2, 'run.updated', run('run-1', 'completed')));

  assert.deepEqual(
    events.map((event) => event.type),
    ['started', 'completed'],
  );
  assert.equal(events[0]?.runId, 'run-1');
  assert.deepEqual(events[1], {
    runId: 'run-1',
    threadId: THREAD,
    sequence: 2,
    timestamp: NOW,
    type: 'completed',
    outcome: 'succeeded',
    message: 'T3 run completed',
  });
});

test('repeated non-terminal run updates do not re-emit started', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-1', 'running')));
  mapper.applyStreamItem(streamEvent(2, 'run.updated', run('run-1', 'running')));
  mapper.applyStreamItem(streamEvent(3, 'run.updated', run('run-1', 'waiting')));
  assert.deepEqual(
    events.map((event) => event.type),
    ['started'],
  );
});

test('sequence is monotonic per run and independent across runs', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-1', 'running', 1)));
  mapper.applyStreamItem(
    streamEvent(2, 'turn-item.updated', turnItem({ runId: 'run-1', type: 'assistant_message', text: 'a', messageId: 'm', streaming: true })),
  );
  mapper.applyStreamItem(streamEvent(3, 'run.created', run('run-2', 'running', 2)));
  mapper.applyStreamItem(
    streamEvent(4, 'turn-item.updated', turnItem({ runId: 'run-1', type: 'assistant_message', text: 'ab', messageId: 'm', streaming: true })),
  );

  const run1 = events.filter((event) => event.runId === 'run-1');
  const run2 = events.filter((event) => event.runId === 'run-2');
  assert.deepEqual(run1.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(run2.map((event) => event.sequence), [1]);
});

test('assistant text is emitted as deltas, not repeated snapshots', () => {
  const { mapper, events } = makeMapper();
  const item = (text: string): Record<string, unknown> =>
    turnItem({ type: 'assistant_message', text, messageId: 'm', streaming: true });
  mapper.applyStreamItem(streamEvent(1, 'turn-item.updated', item('Hello')));
  mapper.applyStreamItem(streamEvent(2, 'turn-item.updated', item('Hello world')));
  mapper.applyStreamItem(streamEvent(3, 'turn-item.updated', item('Hello world')));

  assert.deepEqual(
    events.map((event) => (event.type === 'text' ? event.text : event.type)),
    ['Hello', ' world'],
  );
});

test('a non-prefix rewrite emits the whole new text rather than nothing', () => {
  const { mapper, events } = makeMapper();
  const item = (text: string): Record<string, unknown> =>
    turnItem({ type: 'assistant_message', text, messageId: 'm', streaming: true });
  mapper.applyStreamItem(streamEvent(1, 'turn-item.updated', item('Hello')));
  mapper.applyStreamItem(streamEvent(2, 'turn-item.updated', item('Rewritten')));
  assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text), [
    'Hello',
    'Rewritten',
  ]);
});

test('reasoning becomes tool activity, never assistant text', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'reasoning', text: 'thinking', streaming: true })),
  );
  assert.equal(events[0]?.type, 'tool');
  assert.equal((events[0] as { name: string }).name, 'reasoning');
});

test('proposed_plan is surfaced as text', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'proposed_plan', markdown: 'step 1', streaming: true })),
  );
  assert.deepEqual(events[0], {
    runId: 'run-1',
    threadId: THREAD,
    sequence: 1,
    timestamp: NOW,
    type: 'text',
    text: 'step 1',
  });
});

test('file_change becomes a diff with its paths', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'file_change', fileName: 'src/a.ts', status: 'completed' })),
  );
  assert.deepEqual(events[0], {
    runId: 'run-1',
    threadId: THREAD,
    sequence: 1,
    timestamp: NOW,
    type: 'diff',
    paths: ['src/a.ts'],
  });
});

test('approval_request is bound and can be consumed exactly once', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'approval_request', requestId: 'req-1', requestKind: 'command', prompt: 'Run rm -rf?' })),
  );
  assert.equal(events[0]?.type, 'approval');
  assert.equal((events[0] as { requestId: string }).requestId, 'req-1');

  const consumed = mapper.consumeApproval('req-1');
  assert.ok(consumed !== undefined);
  assert.equal(consumed.requestId, 'req-1');
  assert.equal(mapper.consumeApproval('req-1'), undefined);
  assert.equal(mapper.consumeApproval('never-issued'), undefined);
});

test('a completed run clears its unanswered approvals', () => {
  const { mapper } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'approval_request', requestId: 'req-1', requestKind: 'command' })),
  );
  assert.equal(mapper.pendingApprovals().length, 1);
  mapper.applyStreamItem(streamEvent(2, 'run.updated', { ...run('run-1', 'failed'), id: 'run-1' }));
  assert.equal(mapper.pendingApprovals().length, 0);
  assert.equal(mapper.consumeApproval('req-1'), undefined);
});

test('a runtime-request.updated pending record is offered and removed when resolved', () => {
  const { mapper } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'runtime-request.updated', { id: 'req-2', status: 'pending', kind: 'file-change' }));
  assert.equal(mapper.pendingApprovals().length, 1);
  mapper.applyStreamItem(streamEvent(2, 'runtime-request.updated', { id: 'req-2', status: 'resolved', kind: 'file-change' }));
  assert.equal(mapper.pendingApprovals().length, 0);
});

test('a cancelled run reports the cancelled outcome', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-1', 'running')));
  mapper.applyStreamItem(streamEvent(2, 'run.updated', run('run-1', 'cancelled')));
  const completed = events.find((event) => event.type === 'completed');
  assert.equal((completed as { outcome: string }).outcome, 'cancelled');
});

test('an unknown event advances the cursor without surfacing anything', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-1', 'running')));
  mapper.applyStreamItem({ kind: 'unknown-event', sequence: 5, eventType: 'future.event' });
  mapper.applyStreamItem(streamEvent(6, 'turn-item.updated', turnItem({ type: 'assistant_message', text: 'hi', messageId: 'm', streaming: true })));
  assert.equal(mapper.cursor, 6);
  assert.equal(events.filter((event) => event.type === 'text').length, 1);
});

test('a malformed stream item becomes a diagnostic instead of an exception', () => {
  const { mapper, events } = makeMapper();
  assert.doesNotThrow(() => mapper.applyStreamItem({ kind: 'event' }));
  assert.equal(events[0]?.type, 'diagnostic');
});

test('a snapshot primes the text baseline without replaying history', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem({
    kind: 'snapshot',
    snapshotSequence: 9,
    projection: {
      thread: { id: THREAD, projectId: 'p1', providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'gpt-5' }, runtimeMode: 'approval-required', worktreePath: null },
      runs: [run('run-9', 'running')],
      turnItems: [turnItem({ id: 'item-9', type: 'assistant_message', text: 'prior text', messageId: 'm9', streaming: true })],
    },
  });
  assert.equal(mapper.cursor, 9);
  assert.deepEqual(
    events.map((event) => event.type),
    ['started'],
  );

  mapper.applyStreamItem(
    streamEvent(10, 'turn-item.updated', turnItem({ id: 'item-9', type: 'assistant_message', text: 'prior text and more', messageId: 'm9', streaming: true })),
  );
  const text = events.find((event) => event.type === 'text');
  assert.equal((text as { text: string }).text, ' and more');
});

test('a snapshot with a pending runtime request offers that approval', () => {
  const { mapper } = makeMapper();
  mapper.applyStreamItem({
    kind: 'snapshot',
    snapshotSequence: 1,
    projection: {
      thread: { id: THREAD, projectId: 'p1', providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'gpt-5' }, runtimeMode: 'approval-required', worktreePath: null },
      runs: [],
      runtimeRequests: [{ id: 'req-snap', status: 'pending', kind: 'permission' }],
    },
  });
  assert.equal(mapper.consumeApproval('req-snap')?.requestId, 'req-snap');
});

test('free-form text is redacted before it reaches an event', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'assistant_message', text: 'use token=abc123 now', messageId: 'm', streaming: true })),
  );
  const text = events.find((event) => event.type === 'text');
  assert.equal((text as { text: string }).text, 'use token="[redacted]" now');
});

test('text longer than the ceiling is clamped', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'assistant_message', text: 'x'.repeat(20_000), messageId: 'm', streaming: true })),
  );
  const text = events.find((event) => event.type === 'text');
  assert.match((text as { text: string }).text, /\[truncated\]$/);
});

test('a command execution surfaces its output and flags a non-zero exit', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(
    streamEvent(1, 'turn-item.updated', turnItem({ type: 'command_execution', input: 'run build', output: 'boom', exitCode: 1, status: 'completed' })),
  );
  assert.equal(events[0]?.type, 'tool');
  assert.equal((events[0] as { name: string }).name, 'command');
  const diagnostic = events.find((event) => event.type === 'diagnostic');
  assert.ok(diagnostic !== undefined);
  assert.match((diagnostic as { diagnostic: { message: string } }).diagnostic.message, /exited with code 1/);
});

test('parseDiffPaths names post-images, keeps deletions and de-duplicates', () => {
  assert.deepEqual(
    parseDiffPaths('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'),
    ['src/a.ts'],
  );
  // A pure deletion shows `+++ /dev/null`, so the pre-image supplies the path.
  assert.deepEqual(parseDiffPaths('diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n'), ['gone.ts']);
  // One entry per path even when several hunks repeat it.
  assert.deepEqual(
    parseDiffPaths('--- a/x.ts\n+++ b/x.ts\n@@\n--- a/x.ts\n+++ b/x.ts\n'),
    ['x.ts'],
  );
  // The header alone covers rename/binary patches; a headerless diff genuinely names nothing.
  assert.deepEqual(parseDiffPaths('diff --git a/old.ts b/new.ts\n'), ['new.ts']);
  assert.deepEqual(parseDiffPaths(''), []);
});

test('applyDiff emits a diff for the run last seen and carries the parsed paths', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-7', 'running')));
  mapper.applyDiff({ diff: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n' });

  assert.deepEqual(events, [
    { runId: 'run-7', threadId: THREAD, sequence: 1, timestamp: NOW, type: 'started', provider: 'codex' },
    {
      runId: 'run-7',
      threadId: THREAD,
      sequence: 2,
      timestamp: NOW,
      type: 'diff',
      paths: ['src/b.ts'],
      diff: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n',
    },
  ]);
});

test('applyDiff falls back to the thread pseudo-run when no run was seen', () => {
  const { mapper, events } = makeMapper();
  mapper.applyDiff({ diff: '--- a/a.ts\n+++ b/a.ts\n' });
  assert.equal(events[0]?.type, 'diff');
  assert.match(events[0]?.runId ?? '', /^thread:/);
});

test('applyDiff honours an explicit runId over the last-seen run', () => {
  const { mapper, events } = makeMapper();
  mapper.applyStreamItem(streamEvent(1, 'run.created', run('run-7', 'running')));
  mapper.applyDiff({ diff: '--- a/a.ts\n+++ b/a.ts\n', runId: 'run-99' });
  assert.equal(events.at(-1)?.runId, 'run-99');
});
