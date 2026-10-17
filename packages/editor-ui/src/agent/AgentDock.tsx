import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Bookmark, Braces, ChevronRight, Circle, FileDiff, LoaderCircle, Paperclip, Plus, Search, ShieldCheck, Square, Terminal, TriangleAlert, X } from 'lucide-react';
import type { AssetRecord, SceneDocument } from '@forgon/project-schema';
import { Banner, Button, IconButton, StatusText, cx, type Tone } from '../primitives/primitives.js';
import { ModelPicker } from './ModelPicker.js';
import { PermissionPicker } from './PermissionPicker.js';
import { Markdown } from './Markdown.js';
import { attachmentReferences, buildContext, chipStatus, clipboardFiles, insertMention, isSendKey, mentionOptions, mentionQuery, recallPrompt, type ContextChip, type HistoryRecall } from './composerModel.js';
import type { AgentController } from './useAgentSessions.js';
import { activityDuration, activityGroupLabel, commandLabel, groupActivity, lastPrompt, workStatusLabel, type ActivityGroup, type ActivityRow, type ActivityStep } from './activityModel.js';
import { threadStatus, threadStatusLabels, type AgentThread, type ThreadStatus } from './threadState.js';

export interface AgentDockProps {
  agent: AgentController | null;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  focusToken: number;
  transcriptOpen?: boolean;
  onCloseTranscript?(): void;
  onOpenTranscript?(): void;
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
  const rows = groupActivity(thread.transcript, thread.activeRunId);
  const lastAnswers = new Map<string, string>();
  for (const item of rows) if (item.kind === 'assistant') lastAnswers.set(item.runId, item.id);
  return (
    <ol className="fg-transcript" aria-label="Transcript" aria-live="polite">
      {rows.map(item => <TranscriptRow key={item.id} item={item} final={item.kind === 'assistant' && item.runId !== thread.activeRunId && lastAnswers.get(item.runId) === item.id} onApprove={onApprove} />)}
      <li ref={endRef} aria-hidden="true" />
    </ol>
  );
}

const activityIcons = { command: Terminal, search: Search, edit: FileDiff, approval: ShieldCheck, checkpoint: Bookmark, tool: Circle, diagnostic: TriangleAlert };

export function ActivityStepRow({ step }: { step: ActivityStep }) {
  const [open, setOpen] = useState(false);
  const Icon = activityIcons[step.kind];
  const duration = activityDuration(step);
  return <li className="fg-activity-step">
    <button type="button" className="fg-activity-toggle" aria-expanded={open} disabled={!step.detail}
      title={step.detail || step.label} onClick={() => setOpen(value => !value)}>
      <Icon size={14} aria-hidden="true" />
      <span className="fg-activity-label">{step.label}</span>
      <span className={`fg-activity-state is-${step.state}`} role="img" aria-label={step.state === 'running' ? 'Running' : step.state === 'failed' ? 'Failed' : 'Done'}>
        {step.state === 'running' ? <LoaderCircle size={12} className="fg-activity-spinner" aria-hidden="true" /> : <Circle size={6} fill="currentColor" aria-hidden="true" />}
      </span>
      {duration ? <span className="fg-mono fg-small fg-muted">{duration}</span> : null}
    </button>
    {step.failureReason ? <p className="fg-activity-failure">{step.failureReason}</p> : null}
    {open && step.detail ? <pre className="fg-code fg-activity-detail">{step.detail}</pre> : null}
  </li>;
}

export function ActivityGroupRow({ group }: { group: ActivityGroup }) {
  const [open, setOpen] = useState(false);
  const failed = group.steps.some(step => step.state === 'failed');
  const running = group.steps.some(step => step.state === 'running');
  return <li className="fg-activity-group">
    <button type="button" className="fg-activity-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronRight size={14} className={open ? 'is-open' : undefined} aria-hidden="true" />
      {running ? <LoaderCircle size={14} className="fg-activity-spinner" aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
      <span className="fg-activity-label">{activityGroupLabel(group)}</span>
      {failed ? <span className="fg-tone-danger fg-small">Failed step</span> : null}
    </button>
    <ul className="fg-activity-steps" hidden={!open}>
      {group.steps.map(step => <ActivityStepRow key={step.id} step={step} />)}
    </ul>
  </li>;
}

export function PendingApproval({ item, onApprove }: {
  item: Extract<ActivityRow, { kind: 'approval' }>;
  onApprove(runId: string, requestId: string, allow: boolean): void;
}) {
  return <li className="fg-approval" role="group" aria-label="Approval request">
    <p className="fg-approval-title"><ShieldCheck size={14} aria-hidden="true" />Approval needed</p>
    <p>{commandLabel(item.description)}</p>
    <details><summary>Request details</summary><pre className="fg-code fg-activity-detail">{item.description}</pre></details>
    <div className="fg-toolbar">
      <Button variant="primary" onClick={() => onApprove(item.runId, item.requestId, true)}>Approve once</Button>
      <Button onClick={() => onApprove(item.runId, item.requestId, false)}>Deny</Button>
    </div>
  </li>;
}

function TranscriptRow({ item, final, onApprove }: {
  item: ActivityRow;
  final: boolean;
  onApprove(runId: string, requestId: string, allow: boolean): void;
}) {
  switch (item.kind) {
    case 'user':
      return <li className="fg-message fg-message-user"><span className="fg-message-label">You</span><p>{item.text}</p></li>;
    case 'assistant':
      return <li className={cx('fg-message', final && 'fg-message-final')}><span className="fg-message-label">{final ? 'Answer' : 'Agent'}</span><Markdown text={item.text} /></li>;
    case 'activity':
      return <ActivityGroupRow group={item} />;
    case 'approval':
      return <PendingApproval item={item} onApprove={onApprove} />;
    case 'status':
      return <li className="fg-status-line fg-tone-danger">{item.text}</li>;
  }
}

function Composer({ agent, scene, assets, projectOpen, focusToken, onOpenTranscript }: {
  onOpenTranscript?: (() => void) | undefined;
  agent: AgentController;
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
  projectOpen: boolean;
  focusToken: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const history = useRef<{ threadId: string; recall: HistoryRecall } | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeMention, setActiveMention] = useState(0);
  const [attachmentNote, setAttachmentNote] = useState('');
  const thread = agent.activeThread;
  const status = thread ? threadStatus(thread) : 'idle';
  const running = thread !== null && (thread.starting || thread.activeRunId !== null);
  const provider = agent.activeProvider;
  const context = buildContext(agent.chips);
  const query = mentionDismissed ? null : mentionQuery(agent.draft, Math.min(caret ?? agent.draft.length, agent.draft.length));
  const matches = query ? mentionOptions(scene, assets, query.query) : [];
  const suggestions = matches.slice(0, 30);
  const highlighted = Math.min(activeMention, Math.max(0, suggestions.length - 1));

  useEffect(() => {
    history.current = null;
    setCaret(null);
    setMentionDismissed(true);
    setAttachmentNote('');
  }, [thread?.id]);

  useEffect(() => {
    if (query) document.getElementById(`agent-mention-${highlighted}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, query?.query]);

  useEffect(() => {
    if (focusToken > 0) inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    if (pendingCaret.current !== null) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [agent.draft]);

  const chooseMention = (chip: ContextChip): void => {
    if (!query) return;
    const inserted = insertMention(agent.draft, query);
    agent.addChip(chip);
    agent.setDraft(inserted.text);
    pendingCaret.current = inserted.caret;
    setCaret(inserted.caret);
    setMentionDismissed(true);
    inputRef.current?.focus();
  };

  const addFiles = (files: readonly File[]): void => {
    if (!projectOpen || !thread) return;
    const { chips, rejected } = attachmentReferences(files, assets);
    chips.forEach(chip => agent.addChip(chip));
    setAttachmentNote([
      chips.length ? `Referenced ${chips.map(chip => chip.label).join(', ')} from the project. File contents are not uploaded.` : '',
      rejected.length ? `Cannot reference ${rejected.join(', ')}: import it into project assets first, or use @ to choose an unambiguous file.` : '',
    ].filter(Boolean).join(' '));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const key = event.nativeEvent;
    if (key.isComposing || key.keyCode === 229) return;
    if (query && key.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setMentionDismissed(true); return;
    }
    if (query && suggestions.length && !key.ctrlKey && !key.altKey && !key.metaKey && !key.shiftKey) {
      if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
        event.preventDefault();
        setActiveMention((highlighted + (key.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (key.key === 'Enter' || key.key === 'Tab') {
        event.preventDefault(); chooseMention(suggestions[highlighted]!); return;
      }
    }
    if (key.key === 'Enter' && key.ctrlKey && !key.altKey && !key.metaKey) {
      event.preventDefault();
      const start = event.currentTarget?.selectionStart ?? agent.draft.length;
      const end = event.currentTarget?.selectionEnd ?? start;
      agent.setDraft(`${agent.draft.slice(0, start)}\n${agent.draft.slice(end)}`);
      pendingCaret.current = start + 1;
      setCaret(start + 1);
      setMentionDismissed(true);
      history.current = null;
      return;
    }
    if (thread && (key.key === 'ArrowUp' || key.key === 'ArrowDown') && !key.ctrlKey && !key.altKey && !key.metaKey && !key.shiftKey
      && event.currentTarget?.selectionStart === event.currentTarget?.selectionEnd) {
      const prompts = [...thread.transcript.flatMap(item => item.kind === 'user' ? [item.text] : []), ...thread.queue.map(item => item.text)];
      const recalled = recallPrompt(prompts, agent.draft, history.current?.threadId === thread.id ? history.current.recall : null, key.key);
      if (recalled) {
        event.preventDefault(); history.current = { threadId: thread.id, recall: recalled };
        agent.setDraft(recalled.text); pendingCaret.current = recalled.text.length; setCaret(null); setMentionDismissed(true); return;
      }
    }
    if (!isSendKey(key)) return;
    event.preventDefault();
    if (agent.canSend && agent.draft.trim()) { history.current = null; agent.send(); setAttachmentNote(''); setCaret(null); setMentionDismissed(true); }
  };

  const [showContext, setShowContext] = useState(false);
  const workLabel = thread ? workStatusLabel(thread) : null;

  return (
    <div className={cx('fg-composer', workLabel !== null && 'is-working')} onDragOver={event => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
    }} onDrop={event => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); addFiles(Array.from(event.dataTransfer.files));
    }}>
      {thread && workLabel !== null ? (
        // Work stays visible at the prompt even while the conversation card is collapsed.
        <button type="button" className="fg-work-status" onClick={onOpenTranscript} disabled={!onOpenTranscript} title={lastPrompt(thread)}>
          <span className="fg-typing" data-waiting={workLabel === 'Needs your approval' ? 'true' : undefined} aria-hidden="true"><i /><i /><i /></span>
          <span className="fg-work-status-text">
            <strong>{lastPrompt(thread) || thread.title}</strong>
            <span role="status">{provider?.name ?? thread.provider} · {workLabel}</span>
          </span>
        </button>
      ) : null}
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
      {query ? <div className="fg-mention-popover">
        <ul id="agent-mentions" role="listbox" aria-label="Context suggestions">
          {suggestions.map((chip, index) => <li key={chip.id} role="presentation"><button type="button" role="option"
            id={`agent-mention-${index}`} aria-selected={index === highlighted} tabIndex={-1}
            onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(chip)}>
            <span>{chip.label}</span><span className="fg-muted fg-small">{chip.kind}</span>
          </button></li>)}
        </ul>
        {!suggestions.length ? <p className="fg-small fg-muted" role="status">No matching context</p> : null}
        {matches.length > suggestions.length ? <p className="fg-small fg-muted">{matches.length - suggestions.length} more — refine search</p> : null}
      </div> : null}
      <label className="fg-sr-only" htmlFor="agent-composer">Message to the agent</label>
      <textarea
        id="agent-composer"
        ref={inputRef}
        className="fg-textarea"
        rows={Math.min(5, Math.max(1, agent.draft.split("\n").length))}
        value={agent.draft}
        disabled={!projectOpen || thread === null}
        aria-describedby="agent-composer-help agent-composer-blockers"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={query !== null}
        aria-controls={query ? 'agent-mentions' : undefined}
        aria-activedescendant={query && suggestions.length ? `agent-mention-${highlighted}` : undefined}
        placeholder={projectOpen ? 'Ask for a change…' : 'Open a project to use agents'}
        onChange={event => {
          agent.setDraft(event.currentTarget.value); setCaret(event.currentTarget.selectionStart);
          setMentionDismissed(false); setActiveMention(0); history.current = null;
        }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setMentionDismissed(true)}
        onPaste={event => {
          const files = clipboardFiles(event.clipboardData);
          if (!files.length) return;
          event.preventDefault(); addFiles(files);
        }}
        onKeyDown={onKeyDown}
      />
      {attachmentNote ? <p className="fg-small fg-muted fg-composer-note" role="status">{attachmentNote}</p> : null}
      <div id="agent-composer-help" className="fg-sr-only">Press Enter to {running ? 'queue' : 'send'}. Control+Enter or Shift+Enter inserts a new line. Type @ to find context. ArrowUp and ArrowDown recall prompts in an empty or unedited recalled draft.</div>
      <div className="fg-composer-footer">
        {thread ? <>
          <PermissionPicker key={`permissions-${thread.id}`} provider={provider} value={thread.permissionMode} starting={thread.starting} onSelect={agent.setPermissionMode} />
          <ModelPicker key={thread.id} providers={agent.connection.providers} thread={thread} onSelect={agent.setModel} />
        </> : null}
        <IconButton label="What will be sent" aria-expanded={showContext} onClick={() => setShowContext(open => !open)}>
          <Braces size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <IconButton label="Reference project file" title="Reference a project asset file (no upload). Paste, drop, or choose a file." disabled={!projectOpen || !thread} onClick={() => fileRef.current?.click()}>
          <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <input ref={fileRef} type="file" multiple hidden onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
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
            <Button title="Queue message (Enter)" onClick={agent.send} disabled={!agent.canSend}>Queue</Button>
            <Button variant="danger" title={thread?.activeRunId ? 'Stop agent (Ctrl+.)' : 'Waiting for the agent to start before it can be stopped'} className="fg-send-stop" disabled={!thread?.activeRunId} onClick={agent.cancel} aria-label="Stop">
              <Square size={12} strokeWidth={2} fill="currentColor" aria-hidden="true" />
              Stop
            </Button>
          </>
        ) : (
          <IconButton label="Send" title="Send (Enter)" className="fg-send" onClick={agent.send} disabled={!agent.canSend}>
            <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

export function AgentDock({ agent, scene, assets, projectOpen, focusToken, transcriptOpen = true, onCloseTranscript, onOpenTranscript }: AgentDockProps) {
  if (!agent) {
    return (
      <section className="fg-dock-panel" aria-label="Agent">
        <section id="agent-conversation" className="fg-conversation fg-floating-card" aria-label="Chat" hidden={!transcriptOpen} inert={!transcriptOpen}>
          <header className="fg-agent-head"><span className="fg-agent-title">Chat</span>
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
      <section id="agent-conversation" className="fg-conversation fg-floating-card" aria-label="Chat" hidden={!transcriptOpen} inert={!transcriptOpen}>
        <header className="fg-agent-head">
          <span className="fg-agent-title">{thread ? thread.title : 'No thread'}</span>
          {thread ? <StatusText tone={statusTone[threadStatus(thread)]}>{threadStatusLabels[threadStatus(thread)]}</StatusText> : null}
          <IconButton label="New thread" className="fg-agent-new" onClick={agent.newThread}><Plus size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>
          {onCloseTranscript ? <IconButton label="Close conversation" title="Close (Escape)" onClick={onCloseTranscript}><X size={14} aria-hidden="true" /></IconButton> : null}
        </header>
        {thread ? <Transcript thread={thread} onApprove={(runId, requestId, allow) => agent.approve(thread.id, runId, requestId, allow)} /> : null}
      </section>
      <Composer agent={agent} scene={scene} assets={assets} projectOpen={projectOpen} focusToken={focusToken} onOpenTranscript={onOpenTranscript} />
    </section>
  );
}
