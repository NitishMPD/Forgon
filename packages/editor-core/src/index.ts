import { parseScene } from '@forgon/project-schema';
import type { Component, Entity, SaveSnapshot, SceneDocument, Transform, ValidationContext } from '@forgon/project-schema';

export type SceneCommand =
  | { type: 'create'; entity: Entity }
  | { type: 'delete'; entityId: string }
  | { type: 'enabled'; entityId: string; enabled: boolean }
  | { type: 'rename'; entityId: string; name: string }
  | { type: 'reparent'; entityId: string; parentId: string | null }
  | { type: 'transform'; entityId: string; transform: Transform }
  | { type: 'component'; entityId: string; component: Component }
  | { type: 'remove-component'; entityId: string; componentId: string }
  | { type: 'batch'; commands: SceneCommand[] };

export interface SceneConflict { base: SceneDocument; ours: SceneDocument; theirs: SceneDocument; revision: string }
export type ReconcileResult = 'unchanged' | 'reloaded' | 'conflict';
const copy = <T>(value: T): T => structuredClone(value);
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function apply(scene: SceneDocument, command: SceneCommand): void {
  if (command.type === 'batch') {
    for (const child of command.commands) apply(scene, child);
    return;
  }
  if (command.type === 'create') {
    scene.entities.push(copy(command.entity));
    return;
  }
  const entity = scene.entities.find(entity => entity.id === command.entityId);
  if (!entity) throw new Error(`Missing entity ${command.entityId}`);
  switch (command.type) {
    case 'delete': {
      const children = new Map<string, string[]>();
      for (const item of scene.entities) if (item.parentId !== null) {
        const siblings = children.get(item.parentId) ?? [];
        siblings.push(item.id);
        children.set(item.parentId, siblings);
      }
      const removed = new Set<string>();
      const pending = [entity.id];
      while (pending.length) {
        const id = pending.pop()!;
        if (removed.has(id)) continue;
        removed.add(id);
        pending.push(...children.get(id) ?? []);
      }
      scene.entities = scene.entities.filter(item => !removed.has(item.id));
      break;
    }
    case 'enabled': entity.enabled = command.enabled; break;
    case 'rename': entity.name = command.name; break;
    case 'reparent': entity.parentId = command.parentId; break;
    case 'transform': entity.transform = copy(command.transform); break;
    case 'component': {
      const index = entity.components.findIndex(component => component.id === command.component.id);
      if (index === -1) entity.components.push(copy(command.component));
      else entity.components[index] = copy(command.component);
      break;
    }
    case 'remove-component': {
      const index = entity.components.findIndex(component => component.id === command.componentId);
      if (index === -1) throw new Error(`Missing component ${command.componentId}`);
      entity.components.splice(index, 1);
      break;
    }
    default: throw new Error('Unknown scene command');
  }
}

export function applyCommand(scene: SceneDocument, command: SceneCommand, context: ValidationContext = {}): SceneDocument {
  const next = parseScene(scene, context);
  apply(next, command);
  return parseScene(next, context);
}

export class EditorStore {
  #scene: SceneDocument;
  #base: SceneDocument;
  #revision: string | null;
  #context: ValidationContext;
  #past: SceneDocument[] = [];
  #future: SceneDocument[] = [];
  #conflict: SceneConflict | null = null;
  #listeners = new Set<() => void>();
  #epoch = 0;
  #saves = new WeakMap<SaveSnapshot, { epoch: number; document: SceneDocument; acknowledgedRevision?: string }>();
  #pending = new Set<SaveSnapshot>();

  constructor(scene: SceneDocument, revision: string | null, context: ValidationContext = {}) {
    this.#context = copy(context);
    this.#scene = parseScene(scene, this.#context);
    this.#base = copy(this.#scene);
    this.#revision = revision;
  }
  get scene(): SceneDocument { return copy(this.#scene); }
  get revision(): string | null { return this.#revision; }
  get dirty(): boolean { return this.#revision === null || !equal(this.#scene, this.#base); }
  get canUndo(): boolean { return this.#past.length > 0; }
  get canRedo(): boolean { return this.#future.length > 0; }
  get conflict(): SceneConflict | null { return copy(this.#conflict); }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
  #ensureResolved(): void {
    if (this.#conflict) throw new Error('Resolve external conflict before editing or saving');
  }
  #replace(scene: SceneDocument, revision: string): void {
    this.#scene = copy(scene);
    this.#base = copy(scene);
    this.#revision = revision;
    this.#past = [];
    this.#future = [];
    this.#conflict = null;
    this.#epoch++;
    this.#pending.clear();
  }
  updateContext(context: ValidationContext): void {
    const next = copy(context);
    // Refresh must preserve every undo/conflict snapshot's ability to validate.
    for (const document of [this.#scene, this.#base, ...this.#past, ...this.#future,
      ...(this.#conflict ? [this.#conflict.base, this.#conflict.ours, this.#conflict.theirs] : [])]) parseScene(document, next);
    this.#context = next;
  }
  execute(command: SceneCommand): void {
    this.#ensureResolved();
    const next = applyCommand(this.#scene, command, this.#context);
    if (equal(next, this.#scene)) return;
    this.#past.push(this.#scene);
    this.#scene = next;
    this.#future = [];
    this.#emit();
  }
  undo(): boolean {
    this.#ensureResolved();
    const previous = this.#past.pop();
    if (!previous) return false;
    this.#future.push(this.#scene);
    this.#scene = previous;
    this.#emit();
    return true;
  }
  redo(): boolean {
    this.#ensureResolved();
    const next = this.#future.pop();
    if (!next) return false;
    this.#past.push(this.#scene);
    this.#scene = next;
    this.#emit();
    return true;
  }
  reconcile(input: unknown, revision: string): ReconcileResult {
    const theirs = parseScene(input, this.#context);
    if (theirs.sceneId !== this.#scene.sceneId) throw new Error('External file changed scene identity');
    const knownRevision = this.#conflict?.revision ?? this.#revision;
    const knownDocument = this.#conflict?.theirs ?? this.#base;
    if (revision === knownRevision) {
      if (!equal(theirs, knownDocument)) throw new Error('Same revision supplied for different content');
      return this.#conflict ? 'conflict' : 'unchanged';
    }
    // The watcher may observe our write before its save promise resolves.
    for (const snapshot of this.#pending) {
      const saved = this.#saves.get(snapshot)!;
      if (saved.epoch === this.#epoch && snapshot.expectedRevision === this.#revision && equal(saved.document, theirs)) {
        this.#base = theirs;
        this.#revision = revision;
        this.#epoch++;
        saved.epoch = this.#epoch;
        saved.acknowledgedRevision = revision;
        this.#pending.clear();
        this.#emit();
        return 'reloaded';
      }
    }
    if (!this.dirty || equal(this.#scene, theirs)) {
      this.#replace(theirs, revision);
      this.#emit();
      return 'reloaded';
    }
    this.#conflict = { base: copy(this.#base), ours: copy(this.#scene), theirs, revision };
    this.#epoch++;
    this.#pending.clear();
    this.#emit();
    return 'conflict';
  }
  resolveConflict(choice: 'ours' | 'theirs'): void {
    const conflict = this.#conflict;
    if (!conflict) throw new Error('No external conflict to resolve');
    if (choice !== 'ours' && choice !== 'theirs') throw new Error('Unknown conflict resolution');
    this.#replace(conflict.theirs, conflict.revision);
    if (choice === 'ours') this.#scene = conflict.ours;
    this.#emit();
  }
  prepareSave(): SaveSnapshot {
    this.#ensureResolved();
    const snapshot = { document: copy(this.#scene), expectedRevision: this.#revision };
    this.#saves.set(snapshot, { epoch: this.#epoch, document: copy(this.#scene) });
    this.#pending.add(snapshot);
    return snapshot;
  }
  acknowledgeSave(snapshot: SaveSnapshot, revision: string): void {
    this.#ensureResolved();
    const saved = this.#saves.get(snapshot);
    if (!saved || saved.epoch !== this.#epoch || !equal(saved.document, snapshot.document)) {
      throw new Error('Stale or modified save snapshot; reconcile current disk state');
    }
    if (saved.acknowledgedRevision !== undefined) {
      if (saved.acknowledgedRevision !== revision || this.#revision !== revision) throw new Error('Save acknowledgement revision differs from watcher');
      this.#saves.delete(snapshot);
      return;
    }
    if (snapshot.expectedRevision !== this.#revision) throw new Error('Save snapshot revision was modified');
    if (revision === this.#revision && !equal(saved.document, this.#base)) throw new Error('Same revision supplied for different content');
    this.#base = saved.document;
    this.#revision = revision;
    this.#epoch++;
    this.#pending.clear();
    this.#saves.delete(snapshot);
    this.#emit();
  }
}

export { descendantIds, topmostIds, duplicatePlan, type DuplicateResult, type HierarchyPlan } from './hierarchy.js';
