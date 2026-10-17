import type { Entity, SceneDocument } from '@forgon/project-schema';

export interface PropertyChange {
  path: string;
  ours: string | null;
  theirs: string | null;
}

export interface EntityChange {
  entityId: string;
  name: string;
  status: 'only-ours' | 'only-theirs' | 'changed';
  changes: PropertyChange[];
}

function entityFields(entity: Entity): Array<[string, unknown]> {
  return [
    ['name', entity.name],
    ['parentId', entity.parentId],
    ['enabled', entity.enabled],
    ['transform.position', entity.transform.position],
    ['transform.rotationEuler', entity.transform.rotationEuler],
    ['transform.scale', entity.transform.scale],
    ['prefab', entity.prefab ?? null],
  ];
}

const show = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

// Compares two validated documents by stable ID. Used to show what a conflict changes.
export function diffScenes(ours: SceneDocument, theirs: SceneDocument): EntityChange[] {
  const oursById = new Map(ours.entities.map(entity => [entity.id, entity] as const));
  const theirsById = new Map(theirs.entities.map(entity => [entity.id, entity] as const));
  const ids = [...new Set([...ours.entities.map(entity => entity.id), ...theirs.entities.map(entity => entity.id)])];
  const changes: EntityChange[] = [];
  for (const id of ids) {
    const mine = oursById.get(id);
    const file = theirsById.get(id);
    if (mine && !file) {
      changes.push({ entityId: id, name: mine.name, status: 'only-ours', changes: [] });
      continue;
    }
    if (!mine && file) {
      changes.push({ entityId: id, name: file.name, status: 'only-theirs', changes: [] });
      continue;
    }
    if (!mine || !file) continue;
    const properties: PropertyChange[] = [];
    const left = entityFields(mine);
    const right = entityFields(file);
    left.forEach(([path, value], index) => {
      const other = show(right[index]?.[1]);
      if (show(value) !== other) properties.push({ path, ours: show(value), theirs: other });
    });
    const componentIds = [...new Set([...mine.components.map(item => item.id), ...file.components.map(item => item.id)])];
    for (const componentId of componentIds) {
      const a = mine.components.find(item => item.id === componentId);
      const b = file.components.find(item => item.id === componentId);
      const left = show(a);
      const right = show(b);
      if (left !== right) properties.push({ path: `components.${componentId}`, ours: left, theirs: right });
    }
    if (properties.length > 0) changes.push({ entityId: id, name: file.name, status: 'changed', changes: properties });
  }
  return changes;
}
