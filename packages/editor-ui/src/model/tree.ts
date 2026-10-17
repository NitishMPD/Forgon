import type { Entity } from '@forgon/project-schema';

export interface TreeRow {
  id: string;
  name: string;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  prefab: boolean;
}

// Rows follow author order. The store validates that parents exist and no cycles exist.
export function buildRows(entities: readonly Entity[], collapsed: ReadonlySet<string>, search = ''): TreeRow[] {
  const query = search.trim().toLowerCase();
  const matches = new Set<string>();
  if (query) {
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    for (const entity of entities) {
      if (!entity.name.toLowerCase().includes(query) && !entity.id.toLowerCase().includes(query)) continue;
      let item: Entity | undefined = entity;
      while (item && !matches.has(item.id)) { matches.add(item.id); item = item.parentId ? byId.get(item.parentId) : undefined; }
    }
  }
  const children = new Map<string, Entity[]>();
  for (const entity of entities) {
    if (entity.parentId === null) continue;
    const siblings = children.get(entity.parentId) ?? [];
    siblings.push(entity);
    children.set(entity.parentId, siblings);
  }
  const rows: TreeRow[] = [];
  const visit = (entity: Entity, depth: number): void => {
    if (query && !matches.has(entity.id)) return;
    const kids = children.get(entity.id) ?? [];
    const expanded = !!query || !collapsed.has(entity.id);
    rows.push({
      id: entity.id,
      name: entity.name,
      depth,
      parentId: entity.parentId,
      hasChildren: kids.length > 0,
      expanded,
      prefab: entity.prefab !== undefined,
    });
    if (expanded) for (const kid of kids) visit(kid, depth + 1);
  };
  for (const entity of entities) if (entity.parentId === null) visit(entity, 0);
  return rows;
}

export function stepId(ids: readonly string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return delta > 0 ? ids[0] ?? null : ids.at(-1) ?? null;
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))] ?? null;
}

// Deleting a subtree removes its descendants, so only the topmost selected objects are deleted.
export function topmostIds(entities: readonly Entity[], ids: readonly string[]): string[] {
  const parents = new Map(entities.map(entity => [entity.id, entity.parentId] as const));
  const selected = new Set(ids);
  return ids.filter(id => {
    let parent = parents.get(id) ?? null;
    while (parent !== null) {
      if (selected.has(parent)) return false;
      parent = parents.get(parent) ?? null;
    }
    return true;
  });
}

export function parentRowId(rows: readonly TreeRow[], index: number): string | null {
  const row = rows[index];
  if (!row || row.parentId === null) return null;
  return row.parentId;
}
