import type { AgentThread, TranscriptItem } from './threadState.js';

export interface ActivityStep {
  id: string;
  runId: string;
  kind: 'command' | 'search' | 'edit' | 'approval' | 'checkpoint' | 'tool' | 'diagnostic';
  label: string;
  detail: string;
  state: 'running' | 'done' | 'failed';
  timestamp?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface ActivityGroup {
  id: string;
  kind: 'activity';
  runId: string;
  steps: ActivityStep[];
}

export type ActivityRow = ActivityGroup | Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'approval' | 'status' }>;

// Service diagnostic paths can contain the transport's thread id, not a project file.
export function activityText(text: string): string {
  return text.replace(/\bthread[_:][\w-]+\b/gi, '').trim();
}

export function unwrapCommand(text: string): string {
  const clean = activityText(text);
  const wrapper = /^(?:&\s*)?(?:"[^"]*\b(?:powershell|pwsh)(?:\.exe)?"|'[^']*\b(?:powershell|pwsh)(?:\.exe)?'|\S*\b(?:powershell|pwsh)(?:\.exe)?)\s+(?:[^\r\n]*?\s)?-(?:Command|c)\s+/i.exec(clean);
  if (!wrapper) return clean;
  const command = clean.slice(wrapper[0].length);
  const quote = command[0];
  if (quote === '"' || quote === "'") {
    const end = command.split(/\r?\n/)[0]!.lastIndexOf(quote);
    if (end > 0) return command.slice(1, end) + command.slice(end + 1);
    return command.slice(1);
  }
  return command;
}

export function commandLabel(text: string): string {
  const line = unwrapCommand(text).split(/\r?\n/)[0]?.trim().replace(/\s+/g, ' ') || 'Run command';
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
}

export function activityDuration(step: Pick<ActivityStep, 'timestamp' | 'completedAt'>): string | null {
  if (!step.timestamp || !step.completedAt) return null;
  const ms = Date.parse(step.completedAt) - Date.parse(step.timestamp);
  return Number.isFinite(ms) && ms >= 0 ? `${Math.floor(ms / 1000)}s` : null;
}

export function activityGroupLabel(group: ActivityGroup): string {
  const running = group.steps.some(step => step.state === 'running');
  const times = group.steps.flatMap(step => [step.timestamp, step.completedAt]).filter((time): time is string => !!time && Number.isFinite(Date.parse(time)));
  const duration = times.length > 1 ? activityDuration({ timestamp: times.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b), completedAt: times.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) }) : null;
  return `${running ? 'Working' : 'Worked'}${duration ? ` for ${duration}` : ''} · ${group.steps.length} ${group.steps.length === 1 ? 'step' : 'steps'}`;
}

function toolKind(name: string): ActivityStep['kind'] {
  if (/command|terminal|exec/i.test(name)) return 'command';
  if (/search|\brg\b/i.test(name)) return 'search';
  if (/edit|write|patch|file.change/i.test(name)) return 'edit';
  if (/checkpoint/i.test(name)) return 'checkpoint';
  return 'tool';
}

/** Pure presentation: keep messages in order and put only adjacent work into disclosures. */
export function groupActivity(items: readonly TranscriptItem[], activeRunId: string | null): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const commands = new Map<string, ActivityStep>();
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'assistant' || (item.kind === 'approval' && item.state === 'pending')) {
      rows.push(item.kind === 'approval' ? { ...item, description: activityText(item.description) } : item);
      continue;
    }
    const exitReason = item.kind === 'diagnostic' ? item.diagnostic.message : item.kind === 'status' ? item.text : '';
    if (/command exited with code\s+-?\d+/i.test(exitReason)) {
      const command = commands.get(item.runId);
      if (command) {
        command.state = 'failed';
        command.failureReason = activityText(exitReason).replace(/^failed:\s*/i, '');
        continue;
      }
    }
    if (item.kind === 'status') {
      // The header owns lifecycle status; preserve actionable start/completion failures.
      if (/^Failed to start:|^failed:/i.test(item.text)) rows.push({ ...item, text: activityText(item.text) });
      continue;
    }
    const step: ActivityStep = { id: item.id, runId: item.runId, kind: 'tool', label: '', detail: '', state: 'done',
      ...(item.timestamp ? { timestamp: item.timestamp } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}) };
    if (item.kind === 'tool') {
      step.kind = toolKind(item.name);
      step.detail = activityText(item.text ?? '');
      step.label = step.kind === 'command' ? commandLabel(step.detail) : step.kind === 'search' ? (/web/i.test(item.name) ? 'Search the web' : 'Search files') : step.kind === 'checkpoint' ? 'Saved checkpoint' : activityText(item.name).replace(/[-_]/g, ' ');
      step.state = item.state === 'failed' ? 'failed' : item.state === 'started' && item.runId === activeRunId ? 'running' : 'done';
      if (step.kind === 'command') commands.set(item.runId, step);
    } else if (item.kind === 'approval') {
      step.kind = 'approval';
      step.label = item.state === 'allowed' ? 'Approved once' : item.state === 'denied' ? 'Denied' : 'Approval closed';
      step.detail = activityText(item.description);
      step.state = item.state === 'denied' ? 'failed' : 'done';
    } else if (item.kind === 'diff') {
      step.kind = 'edit';
      step.label = `Changed ${item.paths.length} ${item.paths.length === 1 ? 'file' : 'files'}`;
      step.detail = item.paths.map(activityText).join('\n');
    } else if (item.kind === 'diagnostic') {
      step.kind = 'diagnostic';
      step.label = activityText(item.diagnostic.message);
      step.detail = activityText(item.diagnostic.path ?? '');
      step.state = /command exited with code|\berror\b|\bfailed\b/i.test(step.label) ? 'failed' : 'done';
    }
    const last = rows.at(-1);
    if (last?.kind === 'activity' && last.runId === item.runId) last.steps.push(step);
    else rows.push({ id: item.id, kind: 'activity', runId: item.runId, steps: [step] });
  }
  return rows;
}

/** One line for the composer's live status, like Needle's work status: what the agent is doing right now. */
export function workStatusLabel(thread: Pick<AgentThread, 'starting' | 'activeRunId' | 'transcript'>): string | null {
  if (!thread.starting && thread.activeRunId === null) return null;
  if (thread.starting) return 'Starting';
  const items = thread.transcript.filter(item => 'runId' in item && item.runId === thread.activeRunId);
  if (items.some(item => item.kind === 'approval' && item.state === 'pending')) return 'Needs your approval';
  const running = [...items].reverse().find(item => item.kind === 'tool' && item.state === 'started');
  if (running && running.kind === 'tool') return running.name === 'command' && running.text ? commandLabel(running.text) : `Using ${running.name}`;
  return items.at(-1)?.kind === 'assistant' ? 'Writing a response' : 'Working';
}

/** The prompt the active run is answering, for the status strip's title line. */
export function lastPrompt(thread: Pick<AgentThread, 'transcript'>): string {
  const user = [...thread.transcript].reverse().find(item => item.kind === 'user');
  return user && user.kind === 'user' ? user.text.split(/\r?\n/)[0]!.trim() : '';
}
