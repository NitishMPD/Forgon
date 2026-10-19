/**
 * T3 orchestration stream → Forgon `AgentEvent`.
 *
 * Source shapes: `OrchestrationV2ThreadStreamItem`, `OrchestrationV2DomainEvent`,
 * `OrchestrationV2TurnItem`, `OrchestrationV2Run`, `OrchestrationV2RuntimeRequest` and
 * `OrchestrationV2ThreadProjection` in `packages/contracts/src/orchestrationV2.ts` at the pinned
 * revision. Event names read here: `run.created`, `run.updated`, `turn-item.updated`,
 * `runtime-request.updated`, `checkpoint.captured`.
 *
 * Rules this file enforces, because the Forgon contract requires them and T3 does not:
 *  - `sequence` is monotonic *per run*. T3's stream sequence is per thread, so the bridge keeps
 *    its own per-run counter instead of forwarding T3's number.
 *  - No secrets in events: every free-form string is redacted before it reaches an `AgentEvent`.
 *  - A newer server's unknown event type is skipped, not fatal (matching upstream's documented
 *    unknown-event arm); the resume cursor still advances so a reconnect does not re-read it.
 *  - History is not replayed as live text. A snapshot primes the text baseline and reports run
 *    state plus pending approvals only; this keeps `text` events a live delta stream.
 */
import type { AgentEvent, AgentQuestion, Diagnostic, ProviderId } from '@forgon/project-schema';
import { redactSecrets } from './redaction.js';
import {
  RUN_STATUSES,
  userInputQuestionsSchema,
  isTerminalRunStatus,
  threadStreamItemSchema,
  type T3Run,
  type T3RunStatus,
  type T3ThreadProjection,
  type T3TurnItem,
} from './protocol.js';

/** Upper bound on a single event's text, so one large tool output cannot flood the stream. */
export const MAX_EVENT_TEXT = 8_000;

/** The discriminated payload half of `AgentEvent` (everything except the envelope). */
export type AgentEventPayload =
  | { type: 'started'; provider: ProviderId }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: 'started' | 'completed' | 'failed'; text?: string }
  | { type: 'diagnostic'; diagnostic: Diagnostic }
  | { type: 'approval'; requestId: string; description: string }
  | { type: 'input'; requestId: string; questions: AgentQuestion[] }
  | { type: 'request-resolved'; requestId: string }
  | { type: 'diff'; paths: string[]; diff?: string }
  | { type: 'completed'; outcome: 'succeeded' | 'failed' | 'cancelled'; message?: string };

const TRUNCATED = '\n…[truncated]';

const clamp = (value: string): string => (value.length <= MAX_EVENT_TEXT ? value : `${value.slice(0, MAX_EVENT_TEXT)}${TRUNCATED}`);

/** Parse an `OrchestrationV2TurnItem` loosely: we read known field names, ignore the rest. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const readStatus = (record: Record<string, unknown>): string | undefined => readString(record, 'status');

/** `OrchestrationV2TurnItemStatus` → Forgon `tool` state. */
const toolStateForItemStatus = (status: string | undefined): 'started' | 'completed' | 'failed' => {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return 'failed';
    default:
      return 'started';
  }
};

export interface PendingApproval {
  readonly runId: string;
  readonly requestId: string;
  readonly description: string;
  readonly questions?: AgentQuestion[];
  /** Forgon-side flag: once answered, a repeat answer for the same request is refused. */
  answered: boolean;
}

export interface ThreadEventMapperOptions {
  readonly threadId: string;
  readonly provider: ProviderId;
  /** Clock injection so tests get deterministic timestamps. */
  readonly now?: () => string;
  readonly onEvent: (event: AgentEvent) => void;
}

const fallbackRunId = (threadId: string): string => `thread:${threadId}`;

/**
 * Extract the changed paths from a unified/git diff without a diff parser dependency.
 *
 * `+++ b/<path>` names the post-image; a pure deletion shows `+++ /dev/null`, so `--- a/<path>`
 * supplies the path in that case. The `diff --git a/x b/x` header is a fallback for the
 * `/dev/null`-on-both-sides rename shape. Paths are returned de-duplicated and without the
 * `a/`/`b/` prefixes so they match the `file_change` event's `fileName` convention.
 */
export const parseDiffPaths = (diff: string): string[] => {
  const paths = new Set<string>();
  const stripPrefix = (value: string): string => {
    const withoutTab = value.split('\t', 1)[0]?.trim() ?? '';
    if (withoutTab === '/dev/null') return '';
    return withoutTab.replace(/^[ab]\//, '');
  };
  let lastMinus: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      const candidate = match?.[1]?.trim();
      if (candidate !== undefined && candidate.length > 0) paths.add(candidate);
      continue;
    }
    if (line.startsWith('--- ')) {
      lastMinus = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const plus = stripPrefix(line.slice(4));
      const chosen = plus.length > 0 ? plus : lastMinus;
      if (chosen !== undefined && chosen.length > 0) paths.add(chosen);
      lastMinus = undefined;
    }
  }
  if (paths.size === 0) {
    // Binary patches and rename-only diffs still carry `diff --git a/x b/y`; the loop above
    // handles those, so a headerless diff genuinely names nothing.
    return [];
  }
  return [...paths];
};

/**
 * Stateful mapper for one subscribed thread.
 *
 * One instance per live subscription. `adoptProjection` seeds it from a snapshot or launch
 * result; `applyStreamItem` feeds each subsequent stream frame.
 */
export class ThreadEventMapper {
  private readonly threadId: string;
  private readonly provider: ProviderId;
  private readonly now: () => string;
  private readonly onEvent: (event: AgentEvent) => void;

  /** Per-run monotonic sequence counters. */
  private readonly runSequences = new Map<string, number>();
  /** Last text emitted per turn item, for delta computation. */
  private readonly itemText = new Map<string, string>();
  /** Run status we last saw, so `completed` is emitted once per run. */
  private readonly runStatuses = new Map<string, T3RunStatus>();
  /** Resolved IDs cannot be reopened by a replayed turn item. */
  private readonly resolvedRequests = new Set<string>();
  /** Run-bound permission and question requests, keyed by requestId. */
  private readonly approvals = new Map<string, PendingApproval>();
  /** Cursor for reconnect: the highest T3 stream sequence consumed. */
  private cursorSequence = 0;
  /** The most recently seen run id, so an out-of-band diff attaches to the live run. */
  private lastRunId: string | undefined;

  constructor(options: ThreadEventMapperOptions) {
    this.threadId = options.threadId;
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent;
  }

  /** The highest T3 stream sequence consumed, to pass as `afterSequence` on reconnect. */
  get cursor(): number {
    return this.cursorSequence;
  }

  /** Pending approvals for this thread, for approval binding checks. */
  pendingApprovals(): ReadonlyArray<PendingApproval> {
    return [...this.approvals.values()];
  }

  /**
   * Mark an approval answered. Returns the approval when it was pending and unanswered, or
   * `undefined` when the id is unknown, already answered, or was never issued for this thread.
   * The caller refuses to dispatch a response it did not get a handle for.
   */
  consumeApproval(requestId: string): PendingApproval | undefined {
    const approval = this.approvals.get(requestId);
    if (approval === undefined || approval.answered) return undefined;
    approval.answered = true;
    return approval;
  }

  /** Thread id this mapper is bound to. */
  get thread(): string {
    return this.threadId;
  }

  /** Emit one mapped event with the run's next sequence number. */
  private emit(runId: string, timestamp: string, payload: AgentEventPayload): void {
    const sequence = (this.runSequences.get(runId) ?? 0) + 1;
    this.runSequences.set(runId, sequence);
    const event: AgentEvent = { runId, threadId: this.threadId, sequence, timestamp, ...payload };
    this.onEvent(event);
  }

  /**
   * Surface a real diff (from `orchestration.getTurnDiff`/`getFullThreadDiff`) as a Forgon
   * `diff` event. The paths come from the diff itself, so the event names what actually changed
   * rather than a fabricated summary. Falls back to the thread pseudo-run when no run was seen.
   */
  applyDiff(input: { readonly diff: string; readonly runId?: string; readonly timestamp?: string }): void {
    const runId = input.runId ?? this.lastRunId ?? fallbackRunId(this.threadId);
    const timestamp = this.isoOrNow(input.timestamp);
    const paths = parseDiffPaths(input.diff);
    this.emit(runId, timestamp, {
      type: 'diff',
      paths,
      diff: input.diff.length <= MAX_EVENT_TEXT ? input.diff : `${input.diff.slice(0, MAX_EVENT_TEXT)}${TRUNCATED}`,
    });
  }

  private diagnostic(message: string, path = this.threadId): Diagnostic {
    return { path, message: redactSecrets(message) };
  }

  /** Seed from a snapshot/launch projection without replaying history as live text. */
  adoptProjection(projection: T3ThreadProjection): void {
    for (const item of projection.turnItems ?? []) {
      this.primeText(item);
    }
    for (const entry of projection.visibleTurnItems ?? []) {
      this.primeText(entry.item);
    }
    // Report the newest run's state so a reconnect learns whether work is live.
    let newest: T3Run | undefined;
    for (const run of projection.runs) {
      if (newest === undefined || run.ordinal >= newest.ordinal) newest = run;
    }
    if (newest !== undefined) this.applyRun(newest, this.now());
    const pending = new Set<string>();
    for (const request of projection.runtimeRequests ?? []) {
      const record = asRecord(request);
      if (record) {
        this.applyRuntimeRequest(record, this.now());
        const id = readString(record, 'id');
        if (id && record['status'] === 'pending') pending.add(id);
      }
    }
    for (const request of this.approvals.values()) {
      if (!pending.has(request.requestId)) this.applyRuntimeRequest({ id: request.requestId, status: 'resolved' }, this.now());
    }
    for (const item of [...(projection.turnItems ?? []), ...(projection.visibleTurnItems ?? []).map(entry => entry.item)]) {
      const record = asRecord(item);
      if (record && pending.has(String(record['requestId']))) this.applyTurnItem(item as T3TurnItem, this.now());
    }
  }

  /** Prime the text baseline for an item already present in the projection. */
  private primeText(item: unknown): void {
    const record = asRecord(item);
    if (record === undefined) return;
    const type = readString(record, 'type');
    const id = readString(record, 'id');
    if (id === undefined) return;
    const text = type === 'proposed_plan' ? readString(record, 'markdown') : readString(record, 'text');
    if ((type === 'assistant_message' || type === 'reasoning' || type === 'proposed_plan') && text !== undefined) {
      this.itemText.set(id, text);
    }
  }

  /** Consume one `OrchestrationV2ThreadStreamItem`. Bad frames become a `diagnostic`, not a throw. */
  applyStreamItem(item: unknown): void {
    const parsed = threadStreamItemSchema.safeParse(item);
    if (!parsed.success) {
      this.emit(fallbackRunId(this.threadId), this.now(), {
        type: 'diagnostic',
        diagnostic: this.diagnostic(`Unrecognized T3 stream item: ${parsed.error.message}`),
      });
      return;
    }
    const value = parsed.data;
    switch (value.kind) {
      case 'synchronized':
        return;
      case 'snapshot':
        this.cursorSequence = Math.max(this.cursorSequence, value.snapshotSequence);
        // The snapshot projection is loosely typed here; adopt what we can read.
        this.adoptProjection(value.projection as unknown as T3ThreadProjection);
        return;
      case 'unknown-event':
        // Advance the cursor so a reconnect does not re-read it, but surface nothing.
        this.cursorSequence = Math.max(this.cursorSequence, value.sequence);
        return;
      case 'event':
        this.cursorSequence = Math.max(this.cursorSequence, value.sequence);
        this.applyDomainEvent(value.event.type, value.event.payload, value.event.occurredAt, value.event.threadId);
        return;
    }
  }

  private applyDomainEvent(type: string, payload: unknown, occurredAt: string, eventThreadId: string): void {
    const timestamp = this.isoOrNow(occurredAt);
    switch (type) {
      case 'run.created':
      case 'run.updated': {
        const run = this.asRun(payload);
        if (run !== undefined) this.applyRun(run, timestamp);
        return;
      }
      case 'turn-item.updated': {
        const record = asRecord(payload);
        if (record === undefined) {
          this.emit(fallbackRunId(this.threadId), timestamp, {
            type: 'diagnostic',
            diagnostic: this.diagnostic('turn-item.updated carried no item'),
          });
          return;
        }
        this.applyTurnItem(record as unknown as T3TurnItem, timestamp);
        return;
      }
      case 'runtime-request.updated': {
        const record = asRecord(payload);
        if (record === undefined) return;
        this.applyRuntimeRequest(record, timestamp);
        return;
      }
      case 'checkpoint.captured': {
        const record = asRecord(payload);
        const checkpointId = record === undefined ? undefined : readString(record, 'id');
        if (checkpointId === undefined) return;
        this.emit(fallbackRunId(eventThreadId || this.threadId), timestamp, {
          type: 'tool',
          name: 'checkpoint',
          state: 'completed',
          text: `checkpoint ${checkpointId}`,
        });
        return;
      }
      default:
        // Known-to-T3 types we do not surface (thread metadata, provider turns, …) and newer
        // unknown types both land here. Skipping is deliberate and documented.
        return;
    }
  }

  private isoOrNow(value: string | undefined): string {
    if (value === undefined) return this.now();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? this.now() : new Date(parsed).toISOString();
  }

  private asRun(payload: unknown): T3Run | undefined {
    const record = asRecord(payload);
    if (record === undefined) return undefined;
    const id = readString(record, 'id');
    const status = readStatus(record);
    if (id === undefined || status === undefined) return undefined;
    if (!(RUN_STATUSES as readonly string[]).includes(status)) return undefined;
    return { ...(record as unknown as T3Run), id, status: status as T3RunStatus };
  }

  private applyRun(run: T3Run, timestamp: string): void {
    this.lastRunId = run.id;
    const previous = this.runStatuses.get(run.id);
    if (previous === run.status) return;
    this.runStatuses.set(run.id, run.status);
    if (!isTerminalRunStatus(run.status)) {
      if (previous === undefined) {
        this.emit(run.id, timestamp, { type: 'started', provider: this.provider });
      }
      return;
    }
    if (previous !== undefined && isTerminalRunStatus(previous)) return;
    this.emit(run.id, timestamp, {
      type: 'completed',
      outcome: run.status === 'completed' ? 'succeeded' : run.status === 'cancelled' ? 'cancelled' : 'failed',
      message: `T3 run ${run.status}`,
    });
    // A finished run can no longer answer its approvals.
    for (const [requestId, approval] of this.approvals) {
      if (approval.runId === run.id && !approval.answered) this.approvals.delete(requestId);
    }
  }

  private applyRuntimeRequest(record: Record<string, unknown>, timestamp: string): void {
    const requestId = readString(record, 'id');
    if (requestId === undefined) return;
    const status = readStatus(record);
    if (status !== 'resolved' && status !== 'expired' && status !== 'cancelled') return;
    this.resolvedRequests.add(requestId);
    this.approvals.delete(requestId);
    this.emit(this.lastRunId ?? fallbackRunId(this.threadId), timestamp, { type: 'request-resolved', requestId });
  }

  private applyTurnItem(item: T3TurnItem, timestamp: string): void {
    const record = item as unknown as Record<string, unknown>;
    const runId = typeof record['runId'] === 'string' ? (record['runId'] as string) : fallbackRunId(this.threadId);
    const itemId = typeof record['id'] === 'string' ? (record['id'] as string) : undefined;
    const status = readStatus(record);
    const runStatus = this.runStatuses.get(runId);
    if ((record['type'] === 'approval_request' || record['type'] === 'user_input_request') && runStatus && isTerminalRunStatus(runStatus)) return;
    switch (record['type']) {
      case 'assistant_message': {
        this.emitTextDelta(runId, itemId, readString(record, 'text'), timestamp);
        return;
      }
      case 'proposed_plan': {
        this.emitTextDelta(runId, itemId, readString(record, 'markdown'), timestamp);
        return;
      }
      case 'reasoning': {
        // Forgon has no reasoning channel; surface it as tool activity so it never masquerades
        // as the assistant's answer.
        const text = readString(record, 'text');
        this.emit(runId, timestamp, {
          type: 'tool',
          name: 'reasoning',
          state: toolStateForItemStatus(status),
          ...(text === undefined ? {} : { text: clamp(redactSecrets(text)) }),
        });
        return;
      }
      case 'command_execution': {
        const input = readString(record, 'input') ?? 'command';
        const output = readString(record, 'output');
        const exitCode = typeof record['exitCode'] === 'number' ? (record['exitCode'] as number) : undefined;
        this.emit(runId, timestamp, {
          type: 'tool',
          name: 'command',
          state: toolStateForItemStatus(status),
          text: clamp(redactSecrets(output === undefined ? input : `${input}\n${output}`)),
        });
        if (exitCode !== undefined && exitCode !== 0 && toolStateForItemStatus(status) !== 'started') {
          this.emit(runId, timestamp, {
            type: 'diagnostic',
            diagnostic: this.diagnostic(`command exited with code ${exitCode}`),
          });
        }
        return;
      }
      case 'file_search':
      case 'web_search': {
        this.emit(runId, timestamp, {
          type: 'tool',
          name: record['type'] === 'file_search' ? 'file-search' : 'web-search',
          state: toolStateForItemStatus(status),
        });
        return;
      }
      case 'dynamic_tool': {
        const toolName = readString(record, 'toolName') ?? 'tool';
        this.emit(runId, timestamp, {
          type: 'tool',
          name: toolName,
          state: toolStateForItemStatus(status),
        });
        return;
      }
      case 'file_change': {
        const paths = this.fileChangePaths(record);
        if (paths.length > 0) this.emit(runId, timestamp, { type: 'diff', paths });
        return;
      }
      case 'checkpoint': {
        const files = Array.isArray(record['files']) ? record['files'] : [];
        this.emit(runId, timestamp, {
          type: 'tool',
          name: 'checkpoint',
          state: 'completed',
          text: `${files.length} file(s) captured`,
        });
        return;
      }
      case 'approval_request': {
        const requestId = readString(record, 'requestId');
        if (requestId === undefined) return;
        const description =
          readString(record, 'prompt') ?? `approval requested (${readString(record, 'requestKind') ?? 'permission'})`;
        this.emitApproval(runId, requestId, description, timestamp);
        return;
      }
      case 'user_input_request': {
        const requestId = readString(record, 'requestId');
        if (requestId === undefined) return;
        const parsed = userInputQuestionsSchema.safeParse(record['questions']);
        if (!parsed.success || parsed.data.length === 0) {
          this.emit(runId, timestamp, { type: 'diagnostic', diagnostic: this.diagnostic('The provider sent an invalid question request.') });
          return;
        }
        const existing = this.approvals.get(requestId);
        if (existing?.questions || existing?.answered || this.resolvedRequests.has(requestId)) return;
        const questions = parsed.data;
        this.approvals.set(requestId, { runId, requestId, description: '', questions, answered: false });
        this.emit(runId, timestamp, { type: 'input', requestId, questions: questions.map(question => ({
          ...question, header: redactSecrets(question.header), question: redactSecrets(question.question),
          options: question.options.map(option => ({ ...option, value: option.value ?? option.label,
            label: redactSecrets(option.label), description: redactSecrets(option.description) })),
          ...(question.initialAnswer === undefined ? {} : { initialAnswer: redactSecrets(question.initialAnswer) }),
        })) });
        return;
      }
      case 'error': {
        const failure = asRecord(record['failure']);
        const message = failure === undefined ? 'provider error' : (readString(failure, 'message') ?? 'provider error');
        this.emit(runId, timestamp, { type: 'diagnostic', diagnostic: this.diagnostic(message) });
        return;
      }
      case 'system_notice': {
        const message = readString(record, 'message') ?? 'system notice';
        this.emit(runId, timestamp, { type: 'diagnostic', diagnostic: this.diagnostic(message) });
        return;
      }
      case 'run_interrupt_result': {
        const message = readString(record, 'message') ?? 'run interrupted';
        this.emit(runId, timestamp, { type: 'diagnostic', diagnostic: this.diagnostic(message) });
        return;
      }
      case 'subagent': {
        // A delegated child thread has its own stream; surface only its existence here.
        const prompt = readString(record, 'prompt');
        this.emit(runId, timestamp, {
          type: 'tool',
          name: 'subagent',
          state: toolStateForItemStatus(status),
          ...(prompt === undefined ? {} : { text: clamp(redactSecrets(prompt)) }),
        });
        return;
      }
      case 'todo_list': {
        const steps = Array.isArray(record['steps']) ? record['steps'].length : 0;
        this.emit(runId, timestamp, {
          type: 'tool',
          name: 'todo-list',
          state: toolStateForItemStatus(status),
          text: `${steps} step(s)`,
        });
        return;
      }
      default:
        return;
    }
  }

  private emitApproval(runId: string, requestId: string, description: string, timestamp: string): void {
    if (this.approvals.has(requestId) || this.resolvedRequests.has(requestId)) return;
    const redacted = redactSecrets(description);
    this.approvals.set(requestId, { runId, requestId, description: redacted, answered: false });
    this.emit(runId, timestamp, { type: 'approval', requestId, description: redacted });
  }

  /**
   * Emit only the new suffix of a text field. T3's `turn-item.updated` carries the whole current
   * text, so a naive forward would repeat the whole answer on every token.
   */
  private emitTextDelta(runId: string, itemId: string | undefined, text: string | undefined, timestamp: string): void {
    if (itemId === undefined || text === undefined) return;
    const previous = this.itemText.get(itemId) ?? '';
    if (text === previous) return;
    this.itemText.set(itemId, text);
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta.length === 0) return;
    this.emit(runId, timestamp, { type: 'text', text: clamp(redactSecrets(delta)) });
  }

  private fileChangePaths(record: Record<string, unknown>): string[] {
    const paths = new Set<string>();
    const fileName = readString(record, 'fileName');
    if (fileName !== undefined) paths.add(fileName);
    const changes = record['changes'];
    if (Array.isArray(changes)) {
      for (const change of changes) {
        const entry = asRecord(change);
        const path = entry === undefined ? undefined : readString(entry, 'path');
        if (path !== undefined) paths.add(path);
      }
    }
    return [...paths];
  }
}
