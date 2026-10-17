import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { AssetRecord, PermissionMode, SceneDocument } from '@forgon/project-schema';
import { Banner, Button, EmptyState, StatusText, cx, type Tone } from '../primitives/primitives.js';
import { buildContext, chipStatus, isSendKey } from './composerModel.js';
import type { AgentController } from './useAgentSessions.js';
import { ProviderSetup } from './ProviderSetup.js';
import { enforcementNote, permissionLabels, providerLimitsNote } from './permissions.js';
import { threadStatus, threadStatusLabels, type AgentThread, type ThreadStatus, type TranscriptItem } from './threadState.js';

export interface AgentDockProps {
  agent: AgentController | null;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  providersOpen: boolean;
  onCloseProviders(): void;
  focusToken: number;
}

const statusTone: Record<ThreadStatus, Tone> = {
  idle: 'neutral',
  starting: 'info',
  running: 'info',
  awaiting_approval: 'warning',
  failed: 'danger',
  stopped: 'neutral',
  changes: 'accent',
};

function Transcript({ thread, onApprove }: { thread: AgentThread; onApprove(runId: string, requestId: string, allow: boolean): void }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [thread.transcript.length]);
  if (thread.transcript.length === 0) {
    return <EmptyState title="No messages yet">Ask for a change. Agent replies and file changes appear here.</EmptyState>;
  }
  return (
    <ol className="fg-transcript" aria-label="Transcript" aria-live="polite">
      {thread.transcript.map(item => <TranscriptRow key={item.id} item={item} mode={thread.permissionMode} onApprove={onApprove} />)}
      <div ref={endRef} />
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
          {item.text ? <span className="fg-muted">{item.text}</span> : null}
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
          <p className="fg-muted fg-small">Mode: {mode ? permissionLabels[mode] : 'none chosen'}. {mode ? enforcementNote(mode) : 'Choose a mode to continue.'}</p>
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!isSendKey(event.nativeEvent)) return;
    event.preventDefault();
    if (agent.canSend) agent.send();
  };

  return (
    <div className="fg-composer">
      {thread && thread.queue.length > 0 ? (
        <p className="fg-small fg-muted" role="status">{thread.queue.length} queued. Queued prompts start when the current run finishes.</p>
      ) : null}
      {agent.chips.length > 0 ? (
        <ul className="fg-chip-row" aria-label="Context references">
          {agent.chips.map(chip => {
            const missing = chipStatus(chip, scene, assets) === 'missing';
            return (
              <li key={chip.id} className={cx('fg-chip', missing && 'is-missing')}>
                <span className="fg-mono">@{chip.kind}</span> {chip.label}
                {missing ? <span className="fg-chip-state">missing</span> : null}
                <button type="button" className="fg-chip-remove" aria-label={`Remove ${chip.label}`} onClick={() => agent.removeChip(chip.id)}>×</button>
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
        rows={3}
        value={agent.draft}
        disabled={!projectOpen || thread === null}
        aria-describedby="agent-composer-help agent-composer-blockers"
        placeholder={projectOpen ? 'Ask the agent. Ctrl+Enter sends. Enter adds a new line.' : 'Open a project to use agents.'}
        onChange={event => agent.setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <p id="agent-composer-help" className="fg-sr-only">Press Control and Enter to send. Enter inserts a new line.</p>
      {agent.blockers.length > 0 ? (
        <ul id="agent-composer-blockers" className="fg-blockers" role="status">
          {agent.blockers.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
      ) : <span id="agent-composer-blockers" className="fg-sr-only" />}
      <details className="fg-details">
        <summary>What will be sent</summary>
        <pre className="fg-code">{JSON.stringify(context, null, 2)}</pre>
      </details>
      <div className="fg-composer-footer">
        <select
          className="fg-select"
          aria-label="Provider"
          value={thread?.provider ?? ''}
          disabled={running || thread === null}
          onChange={event => agent.setProvider(event.currentTarget.value as AgentThread['provider'])}
        >
          {agent.connection.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {provider && provider.models.length > 0 ? (
          <select
            className="fg-select"
            aria-label="Model"
            value={thread?.model ?? ''}
            disabled={running || thread === null}
            onChange={event => agent.setModel(event.currentTarget.value === '' ? null : event.currentTarget.value)}
          >
            <option value="">Provider default</option>
            {provider.models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        ) : null}
        <select
          className="fg-select"
          aria-label="Permission mode"
          value={thread?.permissionMode ?? ''}
          disabled={running || !provider || provider.permissionModes.length === 0}
          onChange={event => agent.setPermissionMode(event.currentTarget.value as PermissionMode)}
        >
          {thread?.permissionMode === null || thread?.permissionMode === undefined ? <option value="" disabled>Choose a mode</option> : null}
          {provider?.permissionModes.map(mode => <option key={mode} value={mode}>{permissionLabels[mode]}</option>)}
        </select>
        <StatusText tone={statusTone[status]}>{thread ? threadStatusLabels[status] : 'No thread'}</StatusText>
        {running ? (
          <>
            <Button onClick={agent.send} disabled={!agent.canSend}>Queue</Button>
            <Button variant="danger" disabled={!thread?.activeRunId} onClick={agent.cancel}>Stop</Button>
          </>
        ) : (
          <Button variant="primary" onClick={agent.send} disabled={!agent.canSend}>Send</Button>
        )}
      </div>
      {thread ? (
        <p className="fg-small fg-muted">
          {thread.permissionMode ? enforcementNote(thread.permissionMode) : 'Choose a permission mode before sending.'}
          {provider ? <> {providerLimitsNote(provider)}</> : null}
        </p>
      ) : null}
    </div>
  );
}

export function AgentDock({ agent, scene, assets, projectOpen, providersOpen, onCloseProviders, focusToken }: AgentDockProps) {
  if (!agent) {
    return (
      <section className="fg-dock-panel" aria-label="Agent">
        <Banner tone="neutral">
          The agent service is not connected in this build. The editor works without an agent.
        </Banner>
        <div className="fg-composer">
          <textarea className="fg-textarea" rows={3} disabled aria-label="Message to the agent (unavailable)" value="" readOnly />
        </div>
      </section>
    );
  }
  const thread = agent.activeThread;
  return (
    <section className="fg-dock-panel fg-agent" aria-label="Agent">
      <div className="fg-toolbar">
        <label className="fg-sr-only" htmlFor="thread-select">Thread</label>
        <select
          id="thread-select"
          className="fg-select"
          value={thread?.id ?? ''}
          onChange={event => agent.selectThread(event.currentTarget.value)}
        >
          {agent.state.threads.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <Button onClick={agent.newThread}>New thread</Button>
      </div>
      {providersOpen ? <ProviderSetup providers={agent.connection.providers} onClose={onCloseProviders} onRefresh={agent.refreshProviders} /> : null}
      {thread ? <Transcript thread={thread} onApprove={(runId, requestId, allow) => agent.approve(thread.id, runId, requestId, allow)} /> : null}
      <Composer agent={agent} scene={scene} assets={assets} projectOpen={projectOpen} focusToken={focusToken} />
    </section>
  );
}
