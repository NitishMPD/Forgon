export type LogSource = 'project' | 'schema' | 'asset' | 'agent' | 'editor' | 'save';
export type LogSeverity = 'error' | 'warning' | 'info';

export interface LogEntry {
  id: number;
  time: string;
  source: LogSource;
  severity: LogSeverity;
  message: string;
  file: string | null;
  line: number | null;
}

export interface ConsoleLog {
  entries: readonly LogEntry[];
  nextId: number;
  droppedCount: number;
}

export const logCap = 10000;

export const emptyLog: ConsoleLog = { entries: [], nextId: 1, droppedCount: 0 };

export interface LogInput {
  source: LogSource;
  severity: LogSeverity;
  message: string;
  file?: string;
  line?: number;
}

export function appendLog(log: ConsoleLog, input: LogInput, time: string): ConsoleLog {
  const entry: LogEntry = {
    id: log.nextId,
    time,
    source: input.source,
    severity: input.severity,
    message: input.message,
    file: input.file ?? null,
    line: input.line ?? null,
  };
  const entries = [...log.entries, entry];
  const overflow = Math.max(0, entries.length - logCap);
  return {
    entries: overflow > 0 ? entries.slice(overflow) : entries,
    nextId: log.nextId + 1,
    droppedCount: log.droppedCount + overflow,
  };
}

export function countBySeverity(entries: readonly LogEntry[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const entry of entries) {
    if (entry.severity === 'error') errors++;
    else if (entry.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}
