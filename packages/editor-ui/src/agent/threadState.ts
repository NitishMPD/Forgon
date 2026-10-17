import type { AgentContext, AgentEvent, Diagnostic, PermissionMode, ProviderId } from '@forgon/project-schema';

export interface PendingRequest {
  id: string;
  text: string;
  provider: ProviderId;
  model: string | null;
  permissionMode: PermissionMode;
  context: AgentContext;
}

export type TranscriptItem = (
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; runId: string; text: string }
  | { id: string; kind: 'tool'; runId: string; name: string; state: 'started' | 'completed' | 'failed'; text: string | null }
  | { id: string; kind: 'diagnostic'; runId: string; diagnostic: Diagnostic }
  | { id: string; kind: 'approval'; runId: string; requestId: string; description: string; state: 'pending' | 'allowed' | 'denied' | 'closed' }
  | { id: string; kind: 'diff'; runId: string; paths: string[] }
  | { id: string; kind: 'status'; runId: string; text: string }
) & { timestamp?: string; completedAt?: string };

export interface AgentThread {
  id: string;
  title: string;
  provider: ProviderId;
  model: string | null;
  // Null until the user picks a mode. Forgon never chooses full-local for the user.
  permissionMode: PermissionMode | null;
  transcript: TranscriptItem[];
  queue: PendingRequest[];
  // A request was submitted and no run id is known yet.
  starting: boolean;
  activeRunId: string | null;
  sequences: Record<string, number>;
  outcome: 'none' | 'succeeded' | 'failed' | 'cancelled';
  changedPaths: string[];
}

export interface AgentState {
  threads: AgentThread[];
  activeThreadId: string | null;
}

export type ThreadStatus = 'idle' | 'done' | 'starting' | 'running' | 'awaiting_approval' | 'failed' | 'stopped' | 'changes';

export const threadStatusLabels: Record<ThreadStatus, string> = {
  idle: 'Idle',
  done: 'Done',
  starting: 'Starting',
  running: 'Running',
  awaiting_approval: 'Waiting for approval',
  failed: 'Failed',
  stopped: 'Stopped',
  changes: 'Changes to review',
};

export type AgentAction =
  | { type: 'thread/add'; thread: AgentThread }
  | { type: 'thread/ensure'; thread: AgentThread }
  | { type: 'thread/select'; threadId: string }
  | { type: 'thread/settings'; threadId: string; provider?: ProviderId; model?: string | null; permissionMode?: PermissionMode | null }
  | { type: 'run/requested'; threadId: string; request: PendingRequest; fromQueue: boolean }
  | { type: 'queue/add'; threadId: string; request: PendingRequest }
  | { type: 'run/started'; threadId: string; runId: string }
  | { type: 'run/failed'; threadId: string; requestId: string; message: string }
  | { type: 'approval/answered'; threadId: string; runId: string; requestId: string; allow: boolean }
  | { type: 'event'; event: AgentEvent };

export function newThread(id: string, provider: ProviderId, permissionMode: PermissionMode | null, model: string | null): AgentThread {
  return {
    id,
    title: 'New thread',
    provider,
    model,
    permissionMode,
    transcript: [],
    queue: [],
    starting: false,
    activeRunId: null,
    sequences: {},
    outcome: 'none',
    changedPaths: [],
  };
}

export function canChangeProvider(thread: AgentThread): boolean {
  return !thread.starting && thread.activeRunId === null && thread.transcript.length === 0
    && thread.queue.length === 0 && Object.keys(thread.sequences).length === 0 && thread.outcome === 'none';
}

export function threadStatus(thread: AgentThread): ThreadStatus {
  if (thread.activeRunId !== null) {
    const waiting = thread.transcript.some(item => item.kind === 'approval' && item.runId === thread.activeRunId && item.state === 'pending');
    return waiting ? 'awaiting_approval' : 'running';
  }
  if (thread.starting) return 'starting';
  if (thread.outcome === 'failed') return 'failed';
  if (thread.outcome === 'cancelled') return 'stopped';
  if (thread.changedPaths.length > 0) return 'changes';
  if (thread.outcome === 'succeeded') return 'done';
  return 'idle';
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}

function applyEvent(thread: AgentThread, event: AgentEvent): AgentThread {
  const last = thread.sequences[event.runId] ?? 0;
  if (event.sequence <= last) return thread;
  const base: AgentThread = {
    ...thread,
    sequences: { ...thread.sequences, [event.runId]: event.sequence },
    // Only a start (or anything during a launch) opens a run; late events such as a checkpoint
    // captured after completion must not mark a finished thread as running again.
    activeRunId: thread.activeRunId ?? (event.type === 'started' || (thread.starting && event.type !== 'completed') ? event.runId : null),
    starting: thread.starting && event.type !== 'started' ? false : thread.starting,
  };
  const id = `${event.runId}:${event.sequence}`;
  const transcript = [...thread.transcript];
  switch (event.type) {
    case 'started':
      transcript.push({ id, timestamp: event.timestamp, kind: 'status', runId: event.runId, text: `Started ${event.provider}` });
      return { ...base, transcript, starting: false, outcome: 'none', changedPaths: [] };
    case 'text': {
      const previous = transcript.at(-1);
      if (previous && previous.kind === 'assistant' && previous.runId === event.runId) {
        transcript[transcript.length - 1] = { ...previous, text: previous.text + event.text };
      } else {
        transcript.push({ id, timestamp: event.timestamp, kind: 'assistant', runId: event.runId, text: event.text });
      }
      return { ...base, transcript };
    }
    case 'tool': {
      const index = lastIndexWhere(transcript, item => item.kind === 'tool' && item.runId === event.runId && item.name === event.name && item.state === 'started');
      if (event.state !== 'started' && index !== -1) {
        const previous = transcript[index];
        if (previous && previous.kind === 'tool') {
          transcript[index] = { ...previous, completedAt: event.timestamp, state: event.state, text: event.text ?? previous.text };
        }
      } else {
        transcript.push({ id, timestamp: event.timestamp, kind: 'tool', runId: event.runId, name: event.name, state: event.state, text: event.text ?? null });
      }
      return { ...base, transcript };
    }
    case 'diagnostic':
      transcript.push({ id, timestamp: event.timestamp, kind: 'diagnostic', runId: event.runId, diagnostic: event.diagnostic });
      return { ...base, transcript };
    case 'approval':
      transcript.push({ id, timestamp: event.timestamp, kind: 'approval', runId: event.runId, requestId: event.requestId, description: event.description, state: 'pending' });
      return { ...base, transcript };
    case 'diff': {
      transcript.push({ id, timestamp: event.timestamp, kind: 'diff', runId: event.runId, paths: event.paths });
      const changedPaths = [...new Set([...thread.changedPaths, ...event.paths])];
      return { ...base, transcript, changedPaths };
    }
    case 'completed': {
      const closed = transcript.map(item => (item.kind === 'approval' && item.runId === event.runId && item.state === 'pending' ? { ...item, state: 'closed' as const } : item));
      closed.push({ id, timestamp: event.timestamp, kind: 'status', runId: event.runId, text: event.message ? `${event.outcome}: ${event.message}` : event.outcome });
      const sameRun = thread.activeRunId === null || thread.activeRunId === event.runId;
      return {
        ...base,
        transcript: closed,
        activeRunId: sameRun ? null : thread.activeRunId,
        starting: sameRun ? false : thread.starting,
        outcome: event.outcome,
      };
    }
  }
}

function updateThread(state: AgentState, threadId: string, update: (thread: AgentThread) => AgentThread): AgentState {
  let changed = false;
  const threads = state.threads.map(thread => {
    if (thread.id !== threadId) return thread;
    changed = true;
    return update(thread);
  });
  return changed ? { ...state, threads } : state;
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'thread/add':
      return { threads: [...state.threads, action.thread], activeThreadId: action.thread.id };
    case 'thread/ensure':
      return state.threads.length === 0 ? { threads: [action.thread], activeThreadId: action.thread.id } : state;
    case 'thread/select':
      return state.threads.some(thread => thread.id === action.threadId) ? { ...state, activeThreadId: action.threadId } : state;
    case 'thread/settings':
      return updateThread(state, action.threadId, thread => {
        if (thread.starting) return thread;
        if (action.provider !== undefined && action.provider !== thread.provider && !canChangeProvider(thread)) return thread;
        return {
          ...thread,
          provider: action.provider ?? thread.provider,
          model: action.model !== undefined ? action.model : thread.model,
          permissionMode: action.permissionMode !== undefined ? action.permissionMode : thread.permissionMode,
        };
      });
    case 'queue/add':
      return updateThread(state, action.threadId, thread => ({ ...thread, queue: [...thread.queue, action.request] }));
    case 'run/requested':
      return updateThread(state, action.threadId, thread => {
        const title = thread.transcript.length === 0 && thread.title === 'New thread'
          ? action.request.text.slice(0, 48) || thread.title
          : thread.title;
        const transcript: TranscriptItem[] = [...thread.transcript, { id: `user-${action.request.id}`, kind: 'user', text: action.request.text }];
        return {
          ...thread,
          title,
          transcript,
          queue: action.fromQueue ? thread.queue.filter(item => item.id !== action.request.id) : thread.queue,
          starting: true,
          activeRunId: null,
          outcome: 'none',
          changedPaths: [],
        };
      });
    case 'run/started':
      return updateThread(state, action.threadId, thread => (
        thread.starting && thread.activeRunId === null ? { ...thread, activeRunId: action.runId } : thread
      ));
    case 'run/failed':
      return updateThread(state, action.threadId, thread => ({
        ...thread,
        starting: false,
        outcome: 'failed',
        transcript: [...thread.transcript, { id: `failed-${action.requestId}`, kind: 'status', runId: action.requestId, text: `Failed to start: ${action.message}` }],
      }));
    case 'approval/answered':
      return updateThread(state, action.threadId, thread => ({
        ...thread,
        transcript: thread.transcript.map(item => (
          item.kind === 'approval' && item.runId === action.runId && item.requestId === action.requestId
            ? { ...item, state: action.allow ? 'allowed' as const : 'denied' as const }
            : item
        )),
      }));
    case 'event': {
      const { threadId } = action.event;
      return updateThread(state, threadId, thread => applyEvent(thread, action.event));
    }
  }
}
