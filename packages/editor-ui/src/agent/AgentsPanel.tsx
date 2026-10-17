import { Plus, Settings } from 'lucide-react';
import { Banner, IconButton, StatusText, cx } from '../primitives/primitives.js';
import { statusTone } from './AgentDock.js';
import { threadStatus, threadStatusLabels } from './threadState.js';
import type { AgentController } from './useAgentSessions.js';

export interface AgentsPanelProps {
  agent: AgentController | null;
  // Opens the composer for the chosen thread.
  onOpenThread(): void;
  onOpenSettings(): void;
}

export function AgentsPanel({ agent, onOpenThread, onOpenSettings }: AgentsPanelProps) {
  if (!agent) {
    return (
      <section className="fg-dock-panel" aria-label="Agents">
        <Banner tone="neutral">Agent service not connected</Banner>
      </section>
    );
  }
  const activeId = agent.activeThread?.id ?? null;
  return (
    <section className="fg-dock-panel" aria-label="Agents">
      <header className="fg-agent-head">
        <span className="fg-agent-title">Threads</span>
        <span className="fg-muted">{agent.state.threads.length}</span>
        <IconButton label="New thread" className="fg-agent-new" onClick={() => { agent.newThread(); onOpenThread(); }}>
          <Plus aria-hidden="true" size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Provider settings" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={14} strokeWidth={1.75} />
        </IconButton>
      </header>
      {agent.state.threads.length === 0 ? <p className="fg-muted fg-small">No threads</p> : (
        <ul className="fg-thread-list">
          {agent.state.threads.map(thread => {
            const status = threadStatus(thread);
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className={cx('fg-thread-row', thread.id === activeId && 'is-selected')}
                  aria-current={thread.id === activeId ? 'true' : undefined}
                  onClick={() => { agent.selectThread(thread.id); onOpenThread(); }}
                >
                  <span className="fg-thread-avatar" aria-hidden="true">{(agent.connection.providers.find(item => item.id === thread.provider)?.name ?? thread.provider).slice(0, 1)}</span>
                  <span className="fg-thread-title">{thread.title}</span>
                  <StatusText tone={statusTone[status]}>{threadStatusLabels[status]}</StatusText>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
