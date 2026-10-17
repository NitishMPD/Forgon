import type { Component, Entity, JsonValue } from '@forgon/project-schema';
import type { SceneCommand } from '@forgon/editor-core';
import { topmostIds } from './tree.js';

// Pure hierarchy planning. The store still validates every command; these checks give
// an explanation before a command is sent, so the UI can say why an action is unavailable.

export type HierarchyPlan<T> = { ok: true; value: T } | { ok: false; reason: string };

const prefabReason = 'Prefab instance members cannot be moved or duplicated yet. Instantiate the prefab again instead.';

function byId(entities: readonly Entity[]): Map<string, Entity> {
  return new Map(entities.map(entity => [entity.id, entity] as const));
}

export function descendantIds(entities: readonly Entity[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.parentId === null) continue;
    const siblings = children.get(entity.parentId) ?? [];
    siblings.push(entity.id);
    children.set(entity.parentId, siblings);
  }
  const found = new Set<string>();
  const pending = [...(children.get(id) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return found;
}

export function canReparent(entities: readonly Entity[], entityIds: readonly string[], parentId: string | null): HierarchyPlan<null> {
  const lookup = byId(entities);
  if (entityIds.length === 0) return { ok: false, reason: 'Nothing to move.' };
  for (const id of entityIds) {
    const entity = lookup.get(id);
    if (!entity) return { ok: false, reason: 'The object no longer exists.' };
    if (entity.prefab !== undefined) return { ok: false, reason: prefabReason };
  }
  if (parentId !== null) {
    const parent = lookup.get(parentId);
    if (!parent) return { ok: false, reason: 'The new parent no longer exists.' };
    if (parent.prefab !== undefined) return { ok: false, reason: prefabReason };
    for (const id of entityIds) {
      if (id === parentId) return { ok: false, reason: 'An object cannot be its own parent.' };
      if (descendantIds(entities, id).has(parentId)) return { ok: false, reason: 'An object cannot move under its own child.' };
    }
  }
  return { ok: true, value: null };
}

// Moves the topmost selected objects. Children of a selected parent travel with it.
export function reparentCommands(entities: readonly Entity[], entityIds: readonly string[], parentId: string | null): HierarchyPlan<SceneCommand> {
  const top = topmostIds(entities, entityIds);
  const check = canReparent(entities, top, parentId);
  if (!check.ok) return check;
  const commands: SceneCommand[] = top
    .filter(id => (entities.find(entity => entity.id === id)?.parentId ?? null) !== parentId)
    .map(entityId => ({ type: 'reparent', entityId, parentId }));
  if (commands.length === 0) return { ok: false, reason: 'Already under that parent.' };
  return { ok: true, value: commands.length === 1 ? commands[0]! : { type: 'batch', commands } };
}

// Indenting makes the object the last child of its previous sibling.
export function indentTarget(entities: readonly Entity[], id: string): HierarchyPlan<string> {
  const entity = entities.find(item => item.id === id);
  if (!entity) return { ok: false, reason: 'The object no longer exists.' };
  const siblings = entities.filter(item => item.parentId === entity.parentId);
  const index = siblings.findIndex(item => item.id === id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  if (!previous) return { ok: false, reason: 'No previous sibling to become a parent.' };
  const check = canReparent(entities, [id], previous.id);
  return check.ok ? { ok: true, value: previous.id } : check;
}

// Outdenting moves the object beside its parent. Root objects have nowhere to go.
export function outdentTarget(entities: readonly Entity[], id: string): HierarchyPlan<string | null> {
  const lookup = byId(entities);
  const entity = lookup.get(id);
  if (!entity) return { ok: false, reason: 'The object no longer exists.' };
  if (entity.parentId === null) return { ok: false, reason: 'The object is already at the root.' };
  const parent = lookup.get(entity.parentId);
  if (!parent) return { ok: false, reason: 'The parent no longer exists.' };
  const check = canReparent(entities, [id], parent.parentId);
  return check.ok ? { ok: true, value: parent.parentId } : check;
}

export interface DuplicateResult {
  commands: SceneCommand[];
  // Old top-level ID to new ID, in selection order. Use it to select the copies.
  topLevelIds: string[];
}

// Duplicates each topmost selected object with its whole subtree. Copies get fresh stable IDs.
// References that point inside the copied subtree are remapped; references outside stay as they are.
export function duplicatePlan(entities: readonly Entity[], entityIds: readonly string[], makeId: (prefix: string) => string): HierarchyPlan<DuplicateResult> {
  const lookup = byId(entities);
  const top = topmostIds(entities, entityIds).filter(id => lookup.has(id));
  if (top.length === 0) return { ok: false, reason: 'Nothing to duplicate.' };
  const subtree = new Set<string>();
  for (const id of top) {
    subtree.add(id);
    for (const child of descendantIds(entities, id)) subtree.add(child);
  }
  for (const id of subtree) {
    if (lookup.get(id)?.prefab !== undefined) return { ok: false, reason: prefabReason };
  }
  const entityMap = new Map<string, string>();
  const componentMap = new Map<string, string>();
  const members = entities.filter(entity => subtree.has(entity.id));
  for (const entity of members) {
    entityMap.set(entity.id, makeId('entity'));
    for (const component of entity.components) componentMap.set(component.id, makeId('component'));
  }
  const commands: SceneCommand[] = members.map(entity => {
    const isTop = top.includes(entity.id);
    const copy: Entity = {
      ...structuredClone(entity),
      id: entityMap.get(entity.id)!,
      name: isTop ? `${entity.name} copy` : entity.name,
      parentId: entity.parentId !== null && subtree.has(entity.parentId) ? entityMap.get(entity.parentId)! : entity.parentId,
      components: entity.components.map(component => remapComponent(component, entityMap, componentMap)),
    };
    return { type: 'create', entity: copy };
  });
  return { ok: true, value: { commands, topLevelIds: top.map(id => entityMap.get(id)!) } };
}

function remapComponent(component: Component, entityMap: Map<string, string>, componentMap: Map<string, string>): Component {
  const remapString = (value: string): string => entityMap.get(value) ?? componentMap.get(value) ?? value;
  const remapValue = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return remapString(value);
    if (Array.isArray(value)) return value.map(remapValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapValue(item)]));
    }
    return value;
  };
  return {
    ...structuredClone(component),
    id: componentMap.get(component.id)!,
    entityRefs: component.entityRefs.map(ref => entityMap.get(ref) ?? ref),
    properties: Object.fromEntries(Object.entries(component.properties).map(([key, item]) => [key, remapValue(item)])),
  };
}
