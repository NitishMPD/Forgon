export interface Selection {
  readonly entityIds: readonly string[];
  readonly primaryId: string | null;
}

export const noSelection: Selection = { entityIds: [], primaryId: null };

export function selectOne(id: string): Selection {
  return { entityIds: [id], primaryId: id };
}

export function toggleSelection(selection: Selection, id: string): Selection {
  if (selection.entityIds.includes(id)) {
    const entityIds = selection.entityIds.filter(item => item !== id);
    return { entityIds, primaryId: entityIds.at(-1) ?? null };
  }
  return { entityIds: [...selection.entityIds, id], primaryId: id };
}

export function rangeSelection(selection: Selection, visibleIds: readonly string[], id: string): Selection {
  const anchor = selection.primaryId === null ? -1 : visibleIds.indexOf(selection.primaryId);
  const target = visibleIds.indexOf(id);
  if (target === -1 || anchor === -1) return selectOne(id);
  const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
  return { entityIds: visibleIds.slice(from, to + 1), primaryId: id };
}

export function pruneSelection(selection: Selection, existingIds: ReadonlySet<string>): Selection {
  const entityIds = selection.entityIds.filter(id => existingIds.has(id));
  if (entityIds.length === selection.entityIds.length) return selection;
  const primaryId = selection.primaryId !== null && existingIds.has(selection.primaryId)
    ? selection.primaryId
    : entityIds.at(-1) ?? null;
  return { entityIds, primaryId };
}
