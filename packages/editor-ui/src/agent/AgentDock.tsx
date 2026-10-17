import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Braces, ChevronDown, Plus, Square, TriangleAlert, X } from 'lucide-react';
import type { AssetRecord, PermissionMode, SceneDocument } from '@forgon/project-schema';
import { Banner, Button, IconButton, StatusText, cx, type Tone } from '../primitives/primitives.js';
import { buildContext, chipStatus, isSendKey } from './composerModel.js';
import type { AgentController } from './useAgentSessions.js';
import { enforcementNote, permissionLabels, providerLimitsNote } from './permissions.js';
import { threadStatus, threadStatusLabels, type AgentThread, type ThreadStatus, type TranscriptItem } from './threadState.js';

export interface AgentDockProps {
  agent: AgentController | null;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  focusToken: number;
  transcriptOpen?: boolean;
  onCloseTranscript?(): void;
}

export const statusTone: Record<ThreadStatus, Tone> = {
  idle: 'neutral',
  done: 'success',
  starting: 'info',
  running: 'info',
  awaiting_approval: 'warning',
  failed: 'danger',
  stopped: 'neutral',
  changes: 'accent',
};

function Transcript({ thread, onApprove }: { thread: AgentThread; onApprove(runId: string, requestId: string, allow: boolean): void }) {
  const endRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [thread.transcript.length]);
  if (thread.transcript.length === 0) {
    return <p className="fg-transcript-empty">No messages yet</p>;
  }
  return (
    <ol className="fg-transcript" aria-label="Transcript" aria-live="polite">
      {thread.transcript.map(item => <TranscriptRow key={item.id} item={item} mode={thread.permissionMode} onApprove={onApprove} />)}
      <li ref={endRef} aria-hidden="true" />
    </ol>
  );
}

function TranscriptRow({ item, mode, onApprove }: {
  item: TranscriptItem;
  mode: PermissionMode | null;
  onApprove(runId: string, requestId: string, allow: boolean): void;
}) {
  switch (item.kind) {
    case 'user':
      return <li className="fg-message fg-message-user"><span className="fg-message-label">You</span><p>{item.text}</p></li>;
    case 'assistant':
      return <li className="fg-message"><span className="fg-message-label">Agent</span><p>{item.text}</p></li>;
    case 'tool':
      return (
        <li className="fg-tool-line">
          <span className="fg-mono">{item.name}</span>
          <StatusText tone={item.state === 'failed' ? 'danger' : item.state === 'completed' ? 'success' : 'info'}>
            {item.state === 'started' ? 'Started' : item.state === 'completed' ? 'Completed' : 'Failed'}
          </StatusText>
          {item.text ? <details><summary>Details</summary><pre className="fg-code">{item.text}</pre></details> : null}
        </li>
      );
    case 'diagnostic':
      return (
        <li className="fg-tool-line">
          <StatusText tone="warning">Warning</StatusText>
          <span className="fg-mono">{item.diagnostic.path}</span>
          <span>{item.diagnostic.message}</span>
        </li>
      );
    case 'approval':
      return (
        <li className="fg-approval" role="group" aria-label="Approval request">
          <p>{item.description}</p>
          <p className="fg-muted fg-small" title={mode ? enforcementNote(mode) : undefined}>{mode ? permissionLabels[mode] : 'No mode chosen'}</p>
          {item.state === 'pending' ? (
            <div className="fg-toolbar">
              <Button variant="primary" onClick={() => onApprove(item.runId, item.requestId, true)}>Approve once</Button>
              <Button onClick={() => onApprove(item.runId, item.requestId, false)}>Deny</Button>
            </div>
          ) : (
            <StatusText tone="neutral">{item.state === 'allowed' ? 'Approved once' : item.state === 'denied' ? 'Denied' : 'Closed'}</StatusText>
          )}
        </li>
      );
    case 'diff':
      return (
        <li className="fg-tool-line">
          <StatusText tone="accent">Changed {item.paths.length} {item.paths.length === 1 ? 'file' : 'files'}</StatusText>
          <span className="fg-mono fg-muted">{item.paths.join(', ')}</span>
        </li>
      );
    case 'status':
      return <li className="fg-status-line fg-muted">{item.text}</li>;
  }
}

function Composer({ agent, scene, assets, projectOpen, focusToken }: {
  agent: AgentController;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  focusToken: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const thread = agent.activeThread;
  const status = thread ? threadStatus(thread) : 'idle';
  const running = thread !== null && (thread.starting || thread.activeRunId !== null);
  const provider = agent.activeProvider;
  const context = buildContext(agent.chips);

  useEffect(() => {
    if (focusToken > 0) inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }, [agent.draft]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!isSendKey(event.nativeEvent)) return;
    event.preventDefault();
    if (agent.canSend) agent.send();
  };

  const [showContext, setShowContext] = useState(false);
  const modeNote = thread?.permissionMode ? `${enforcementNote(thread.permissionMode)}${provider ? ` ${providerLimitsNote(provider)}` : ''}` : 'Choose a permission mode before sending.';

  return (
    <div className="fg-composer">
      {showContext ? <pre className="fg-code" aria-label="What will be sent">{JSON.stringify(context, null, 2)}</pre> : null}
      {thread && thread.queue.length > 0 ? <p className="fg-small fg-muted" role="status">{thread.queue.length} queued</p> : null}
      {agent.chips.length > 0 ? (
        <ul className="fg-chip-row" aria-label="Context references">
          {agent.chips.map(chip => {
            const missing = chipStatus(chip, scene, assets) === 'missing';
            return (
              <li key={chip.id} className={cx('fg-chip', missing && 'is-missing')} title={`@${chip.kind} ${chip.label}`}>
                <span className="fg-chip-label">{chip.label.split(' · ')[0]}</span>
                {missing ? <span className="fg-chip-state">missing</span> : null}
                <button type="button" className="fg-chip-remove" aria-label={`Remove ${chip.label}`} onClick={() => agent.removeChip(chip.id)}><X size={12} strokeWidth={2} aria-hidden="true" /></button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <label className="fg-sr-only" htmlFor="agent-composer">Message to the agent</label>
      <textarea
        id="agent-composer"
        ref={inputRef}
        className="fg-textarea"
        rows={Math.min(5, Math.max(1, agent.draft.split("\n").length))}
        value={agent.draft}
        disabled={!projectOpen || thread === null}
        aria-describedby="agent-composer-help agent-composer-blockers"
        placeholder={projectOpen ? 'Ask for a change…' : 'Open a project to use agents'}
        onChange={event => agent.setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <p id="agent-composer-help" className="fg-sr-only">Press Control and Enter to send. Enter inserts a new line.</p>
      <div className="fg-composer-footer">
        <details className="fg-agent-options" onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}>
          <summary aria-label="Agent settings" title="Provider, model and permissions">{provider?.name ?? 'Provider'}<ChevronDown size={12} aria-hidden="true" /></summary>
          <div className="fg-agent-options-popover">
            <select
              className="fg-select fg-select-quiet"
              aria-label="Provider"
              value={thread?.provider ?? ''}
              disabled={running || thread === null}
              onChange={event => agent.setProvider(event.currentTarget.value as AgentThread['provider'])}
            >
              {agent.connection.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {provider && provider.models.length > 0 ? (
              <select
                className="fg-select fg-select-quiet"
                aria-label="Model"
                value={thread?.model ?? ''}
                disabled={running || thread === null}
                onChange={event => agent.setModel(event.currentTarget.value === '' ? null : event.currentTarget.value)}
              >
                <option value="">Default model</option>
                {provider.models.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            ) : null}
            <select
              className="fg-select fg-select-quiet"
              aria-label="Permission mode"
              title={modeNote}
              value={thread?.permissionMode ?? ''}
              disabled={running || !provider || provider.permissionModes.length === 0}
              onChange={event => agent.setPermissionMode(event.currentTarget.value as PermissionMode)}
            >
              {thread?.permissionMode === null || thread?.permissionMode === undefined ? <option value="" disabled>Mode</option> : null}
              {provider?.permissionModes.map(mode => <option key={mode} value={mode}>{permissionLabels[mode]}</option>)}
            </select>
            <p className="fg-small fg-muted">{modeNote}</p>
          </div>
        </details>
        <IconButton label="What will be sent" aria-expanded={showContext} onClick={() => setShowContext(open => !open)}>
          <Braces size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <span className="fg-composer-spacer" />
        {agent.blockers.length > 0 ? (
          <span id="agent-composer-blockers" className="fg-composer-blocker" role="status" title={agent.blockers.join('\n')}>
            <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />
            <span aria-hidden="true">Can't send</span>
            <span className="fg-sr-only">{agent.blockers.join(' ')}</span>
          </span>
        ) : <span id="agent-composer-blockers" className="fg-sr-only" />}
        <span className="fg-sr-only">{thread ? threadStatusLabels[status] : 'No thread'}</span>
        {running ? (
          <>
            <Button title="Queue message (Ctrl+Enter)" onClick={agent.send} disabled={!agent.canSend}>Queue</Button>
            <IconButton label="Stop" title="Stop agent (Ctrl+.)" className="fg-send fg-send-stop" disabled={!thread?.activeRunId} onClick={agent.cancel}>
              <Square size={12} strokeWidth={2} fill="currentColor" aria-hidden="true" />
            </IconButton>
          </>
        ) : (
          <IconButton label="Send" title="Send (Ctrl+Enter)" className="fg-send" onClick={agent.send} disabled={!agent.canSend}>
            <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

export function AgentDock({ agent, scene, assets, projectOpen, focusToken, transcriptOpen = true, onCloseTranscript }: AgentDockProps) {
  if (!agent) {
    return (
      <section className="fg-dock-panel" aria-label="Agent">
        <section id="agent-conversation" className="fg-conversation fg-floating-card" aria-label="Conversation" hidden={!transcriptOpen} inert={!transcriptOpen}>
          <header className="fg-agent-head"><span className="fg-agent-title">Conversation</span>
            {onCloseTranscript ? <IconButton label="Close conversation" title="Close (Escape)" onClick={onCloseTranscript}><X size={14} aria-hidden="true" /></IconButton> : null}
          </header>
          <Banner tone="neutral">Agent service not connected</Banner>
        </section>
        <div className="fg-composer">
          <textarea id="agent-composer" className="fg-textarea" rows={1} disabled aria-label="Message to the agent (unavailable)" placeholder="Agent service not connected" value="" readOnly />
        </div>
      </section>
    );
  }
  const thread = agent.activeThread;
  return (
    <section className="fg-dock-panel fg-agent" aria-label="Agent">
      <section id="agent-conversation" className="fg-conversation fg-floating-card" aria-label="Conversation" hidden={!transcriptOpen} inert={!transcriptOpen}>
        <header className="fg-agent-head">
          <span className="fg-agent-title">{thread ? thread.title : 'No thread'}</span>
          {thread ? <StatusText tone={statusTone[threadStatus(thread)]}>{threadStatusLabels[threadStatus(thread)]}</StatusText> : null}
          <IconButton label="New thread" className="fg-agent-new" onClick={agent.newThread}><Plus size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>
          {onCloseTranscript ? <IconButton label="Close conversation" title="Close (Escape)" onClick={onCloseTranscript}><X size={14} aria-hidden="true" /></IconButton> : null}
        </header>
        {thread ? <Transcript thread={thread} onApprove={(runId, requestId, allow) => agent.approve(thread.id, runId, requestId, allow)} /> : null}
      </section>
      <Composer agent={agent} scene={scene} assets={assets} projectOpen={projectOpen} focusToken={focusToken} />
    </section>
  );
}
