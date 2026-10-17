import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ConsoleLog, LogSeverity } from '../../model/consoleLog.js';
import { Button, EmptyState, Segmented, cx } from '../../primitives/primitives.js';

export interface ConsolePanelProps {
  log: ConsoleLog;
  onClear?: (() => void) | undefined;
}

type SeverityFilter = 'all' | LogSeverity;

const maxRows = 500;

const severityOptions: ReadonlyArray<{ value: SeverityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'info', label: 'Info' },
];

const severityWords: Record<LogSeverity, string> = { error: 'Error', warning: 'Warning', info: 'Info' };

export function ConsolePanel({ log, onClear }: ConsolePanelProps) {
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matching = log.entries.filter(entry => (
    (severity === 'all' || entry.severity === severity)
    && (needle === '' || entry.message.toLowerCase().includes(needle) || (entry.file ?? '').toLowerCase().includes(needle))
  ));
  const shown = matching.slice(-maxRows);

  return (
    <section className="fg-dock-panel" aria-label="Console">
      <div className="fg-toolbar">
        <Segmented<SeverityFilter> label="Severity" options={severityOptions} value={severity} onChange={setSeverity} />
        <input
          className="fg-input fg-input-search"
          type="search"
          aria-label="Search console"
          placeholder="Search messages"
          value={query}
          onChange={event => setQuery(event.currentTarget.value)}
        />
        <span className="fg-composer-spacer" />
        <Button onClick={onClear} disabled={!onClear || (log.entries.length === 0 && log.droppedCount === 0)} title="Clear all console messages">
          <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />Clear
        </Button>
      </div>
      <p className="fg-muted fg-small">Opening a project never runs its scripts. Scripts run only when you press Play.</p>
      {log.droppedCount > 0 ? <p className="fg-muted fg-small">Older lines dropped: {log.droppedCount}.</p> : null}
      {matching.length > maxRows ? <p className="fg-muted fg-small">Showing the latest {maxRows} of {matching.length} messages.</p> : null}
      {log.entries.length === 0 ? (
        <EmptyState title="No messages">Errors from validation, saves and agent runs appear here.</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="No matching messages" />
      ) : (
        <ol className="fg-log" aria-live="polite" aria-label="Messages">
          {shown.map(entry => (
            <li key={entry.id} className={cx('fg-log-row', `fg-log-${entry.severity}`)}>
              <span className="fg-mono fg-muted">{entry.time}</span>
              <span className="fg-muted">{entry.source}</span>
              <span className="fg-log-severity">{severityWords[entry.severity]}</span>
              <span className="fg-log-message">{entry.message}</span>
              {entry.file ? <span className="fg-mono fg-muted">{entry.line !== null ? `${entry.file}:${entry.line}` : entry.file}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
