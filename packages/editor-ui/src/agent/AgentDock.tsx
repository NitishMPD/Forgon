import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Archive, ArrowUp, Braces, Paperclip, Plus, RotateCcw, Square, TriangleAlert, X } from 'lucide-react';
import type { AssetRecord, PermissionMode, SceneDocument } from '@forgon/project-schema';
import { Banner, Button, IconButton, StatusText, cx, type Tone } from '../primitives/primitives.js';
import { ModelPicker } from './ModelPicker.js';
import { Markdown } from './Markdown.js';
import { attachmentReferences, buildContext, chipStatus, clipboardFiles, insertMention, isSendKey, mentionOptions, mentionQuery, recallPrompt, swapStashedDraft, type ComposerDraft, type ContextChip, type HistoryRecall } from './composerModel.js';
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
      return <li className="fg-message"><span className="fg-message-label">Agent</span><Markdown text={item.text} /></li>;
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
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const history = useRef<{ threadId: string; recall: HistoryRecall } | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeMention, setActiveMention] = useState(0);
  const [attachmentNote, setAttachmentNote] = useState('');
  const [stash, setStash] = useState<Record<string, ComposerDraft>>({});
  const thread = agent.activeThread;
  const status = thread ? threadStatus(thread) : 'idle';
  const running = thread !== null && (thread.starting || thread.activeRunId !== null);
  const provider = agent.activeProvider;
  const context = buildContext(agent.chips);
  const query = mentionDismissed ? null : mentionQuery(agent.draft, Math.min(caret ?? agent.draft.length, agent.draft.length));
  const matches = query ? mentionOptions(scene, assets, query.query) : [];
  const suggestions = matches.slice(0, 30);
  const highlighted = Math.min(activeMention, Math.max(0, suggestions.length - 1));
  const stashed = thread ? stash[thread.id] : undefined;
  const hasDraft = agent.draft !== '' || agent.chips.length > 0;

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
  const modeNote = thread?.permissionMode ? `${enforcementNote(thread.permissionMode)}${provider ? ` ${providerLimitsNote(provider)}` : ''}` : 'Choose a permission mode before sending.';

  return (
    <div className="fg-composer" onDragOver={event => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
    }} onDrop={event => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); addFiles(Array.from(event.dataTransfer.files));
    }}>
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
      <div id="agent-composer-help" className="fg-composer-hint fg-small fg-muted">
        <span>{agent.draft.length.toLocaleString()} characters</span>
        <span aria-hidden="true">Enter to {running ? 'queue' : 'send'} · Ctrl/Shift+Enter newline · @ context · ↑/↓ history</span>
        <span className="fg-sr-only">Press Enter to {running ? 'queue' : 'send'}. Control+Enter or Shift+Enter inserts a new line. Type @ to find context. ArrowUp and ArrowDown recall prompts in an empty or unedited recalled draft.</span>
      </div>
      <div className="fg-composer-footer">
        {thread ? <ModelPicker key={thread.id} providers={agent.connection.providers} thread={thread} onSelect={agent.setModel}>
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
        </ModelPicker> : null}
        <IconButton label="What will be sent" aria-expanded={showContext} onClick={() => setShowContext(open => !open)}>
          <Braces size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <IconButton label="Reference project file" title="Reference a project asset file (no upload). Paste, drop, or choose a file." disabled={!projectOpen || !thread} onClick={() => fileRef.current?.click()}>
          <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <input ref={fileRef} type="file" multiple hidden onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
        <IconButton label={stashed ? 'Restore stashed draft' : 'Stash draft'}
          title={stashed && hasDraft ? 'Clear or send the current draft before restoring. One saved draft per thread, for this session.' : stashed ? 'Restore saved text and context' : 'Save draft and context for later in this thread'}
          disabled={!thread || (stashed ? hasDraft : !hasDraft)} onClick={() => {
            if (!thread) return;
            const swapped = swapStashedDraft({ text: agent.draft, chips: agent.chips }, stashed);
            if (!swapped) return;
            setStash(current => {
              const next = { ...current };
              if (swapped.saved) next[thread.id] = swapped.saved;
              else delete next[thread.id];
              return next;
            });
            agent.setDraft(swapped.draft.text);
            agent.chips.forEach(chip => agent.removeChip(chip.id));
            swapped.draft.chips.forEach(chip => agent.addChip(chip));
            history.current = null; setCaret(null); setMentionDismissed(true); inputRef.current?.focus();
          }}>
          {stashed ? <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" /> : <Archive size={14} strokeWidth={1.75} aria-hidden="true" />}
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

export function AgentDock({ agent, scene, assets, projectOpen, focusToken, transcriptOpen = true, onCloseTranscript }: AgentDockProps) {
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
      <Composer agent={agent} scene={scene} assets={assets} projectOpen={projectOpen} focusToken={focusToken} />
    </section>
  );
}
