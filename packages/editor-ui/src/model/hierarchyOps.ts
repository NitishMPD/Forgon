import type { Entity } from '@forgon/project-schema';
import { descendantIds, type HierarchyPlan, type SceneCommand } from '@forgon/editor-core';
import { topmostIds } from './tree.js';

// Pure hierarchy planning. The store still validates every command; these checks give
// an explanation before a command is sent, so the UI can say why an action is unavailable.

export { descendantIds, duplicatePlan, type DuplicateResult, type HierarchyPlan } from '@forgon/editor-core';

const prefabReason = 'Prefab instance members cannot be moved yet.';

function byId(entities: readonly Entity[]): Map<string, Entity> {
  return new Map(entities.map(entity => [entity.id, entity] as const));
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
