import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentReducer, newThread, type AgentState } from '../src/agent/threadState.js';
import type { AgentEvent } from '@forgon/project-schema';

test('a checkpoint arriving after a run completes does not mark the thread running again', () => {
  let state: AgentState = { threads: [newThread('t1', 'codex', 'supervised', null)], activeThreadId: 't1' };
  const at = '2026-10-17T12:00:00.000Z';
  const send = (event: AgentEvent) => {
    state = agentReducer(state, { type: 'event', event });
  };
  send({ runId: 'run:1', threadId: 't1', sequence: 1, timestamp: at, type: 'started', provider: 'codex' });
  assert.equal(state.threads[0]!.activeRunId, 'run:1');
  send({ runId: 'run:1', threadId: 't1', sequence: 2, timestamp: at, type: 'completed', outcome: 'cancelled', message: 'T3 run interrupted' });
  assert.equal(state.threads[0]!.activeRunId, null);
  // T3 reports the checkpoint under a thread-level id, after the run has ended.
  send({ runId: 'thread:t1', threadId: 't1', sequence: 1, timestamp: at, type: 'tool', name: 'checkpoint', state: 'completed', text: '0 file(s) captured' });
  assert.equal(state.threads[0]!.activeRunId, null, 'the composer must accept a new prompt after Stop');
});
