import { createId, type Component, type Entity, type JsonValue } from '@forgon/project-schema';
import type { SceneCommand } from './index.js';

export type HierarchyPlan<T> = { ok: true; value: T } | { ok: false; reason: string };

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

// Deleting a subtree removes its descendants, so only the topmost selected objects are deleted.
export function topmostIds(entities: readonly Entity[], ids: readonly string[]): string[] {
  const parents = new Map(entities.map(entity => [entity.id, entity.parentId] as const));
  const selected = new Set(ids);
  return [...new Set(ids)].filter(id => {
    let parent = parents.get(id) ?? null;
    while (parent !== null) {
      if (selected.has(parent)) return false;
      parent = parents.get(parent) ?? null;
    }
    return true;
  });
}

export interface DuplicateResult {
  commands: SceneCommand[];
  // Old top-level ID to new ID, in selection order. Use it to select the copies.
  topLevelIds: string[];
}

// Duplicates each topmost selected object with its whole subtree. Copies get fresh stable IDs.
// References that point inside the copied subtree are remapped; references outside stay as they are.
export function duplicatePlan(entities: readonly Entity[], entityIds: readonly string[], makeId: (prefix: string) => string = createId, offset = 0.5): HierarchyPlan<DuplicateResult> {
  const lookup = new Map(entities.map(entity => [entity.id, entity]));
  const top = topmostIds(entities, entityIds).filter(id => lookup.has(id));
  if (top.length === 0) return { ok: false, reason: 'Nothing to duplicate.' };
  const subtree = new Set<string>();
  for (const id of top) {
    subtree.add(id);
    for (const child of descendantIds(entities, id)) subtree.add(child);
  }
  if (!Number.isFinite(offset)) return { ok: false, reason: 'Duplicate offset must be finite.' };
  const instances = new Map<string, string>();
  for (const entity of entities) {
    if (!subtree.has(entity.id) || !entity.prefab) continue;
    const instance = entity.prefab.instanceId;
    if (entities.some(member => member.prefab?.instanceId === instance && !subtree.has(member.id))) {
      return { ok: false, reason: 'Select the whole prefab instance to duplicate it.' };
    }
    if (!instances.has(instance)) instances.set(instance, makeId('instance'));
  }
  const entityMap = new Map<string, string>();
  const componentMap = new Map<string, string>();
  const members = entities.filter(entity => subtree.has(entity.id));
  for (const entity of members) {
    entityMap.set(entity.id, makeId('entity'));
    for (const component of entity.components) componentMap.set(component.id, makeId('component'));
  }
  const usedNames = new Set(entities.map(entity => `${entity.parentId ?? ''}:${entity.name}`));
  const commands: SceneCommand[] = members.map(entity => {
    const isTop = top.includes(entity.id);
    let name = entity.name;
    if (isTop) {
      const base = name.replace(/ \(\d+\)$/, '');
      let index = 1;
      do { name = `${base} (${index++})`; } while (usedNames.has(`${entity.parentId ?? ''}:${name}`));
      usedNames.add(`${entity.parentId ?? ''}:${name}`);
    }
    const copy: Entity = {
      ...structuredClone(entity),
      id: entityMap.get(entity.id)!,
      name,
      parentId: entity.parentId !== null && subtree.has(entity.parentId) ? entityMap.get(entity.parentId)! : entity.parentId,
      components: entity.components.map(component => remapComponent(component, entityMap, componentMap)),
    };
    if (isTop) copy.transform.position[0] += offset;
    if (copy.prefab) copy.prefab.instanceId = instances.get(copy.prefab.instanceId)!;
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
