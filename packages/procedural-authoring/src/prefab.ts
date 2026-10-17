import { z } from 'zod';
import { idSchema, parsePrefab } from '@forgon/project-schema';
import type { Entity, JsonValue, PrefabDocument } from '@forgon/project-schema';
import { stableId } from './identity.js';

const pathSchema = z.array(z.union([z.string().min(1).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value)), z.number().int().nonnegative()])).min(1);
export const prefabBindingsSchema = z.object({
  formatVersion: z.literal(1), prefabId: idSchema,
  references: z.array(z.object({ componentId: idSchema, path: pathSchema, kind: z.enum(['entity', 'component']) }).strict()),
}).strict();
export type PrefabBindings = z.infer<typeof prefabBindingsSchema>;

export function readProperty(root: JsonValue, path: readonly (string | number)[]): JsonValue {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error(`Missing property path ${path.join('.')}`);
    current = (current as Record<string | number, JsonValue>)[key]!;
  }
  return current;
}
export function writeProperty(root: JsonValue, path: readonly (string | number)[], value: JsonValue): void {
  readProperty(root, path);
  const parent = readProperty(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('Property parent is not an object');
  (parent as Record<string | number, JsonValue>)[path.at(-1)!] = structuredClone(value);
}

export function instantiatePrefab(input: PrefabDocument, instanceId: string, bindings?: PrefabBindings, parentId: string | null = null): {
  entities: Entity[]; entityIds: Record<string, string>; componentIds: Record<string, string>;
} {
  const prefab = parsePrefab(input);
  idSchema.parse(instanceId);
  if (parentId !== null) idSchema.parse(parentId);
  if (prefab.entities.some(entity => entity.prefab)) throw new Error('Nested prefab instantiation unavailable');
  const metadata = prefabBindingsSchema.parse(bindings ?? { formatVersion: 1, prefabId: prefab.prefabId, references: [] });
  if (metadata.prefabId !== prefab.prefabId) throw new Error('Bindings belong to another prefab');
  const entityIds = Object.fromEntries(prefab.entities.map(entity => [entity.id, stableId(instanceId, `entity:${entity.id}`)]));
  const componentIds = Object.fromEntries(prefab.entities.flatMap(entity => entity.components.map(component => [component.id, stableId(instanceId, `component:${component.id}`)])));
  const entities = structuredClone(prefab.entities);
  const seen = new Set<string>();
  for (const binding of metadata.references) {
    const key = JSON.stringify([binding.componentId, binding.path]);
    if (seen.has(key)) throw new Error('Duplicate prefab property binding');
    seen.add(key);
    const component = entities.flatMap(entity => entity.components).find(component => component.id === binding.componentId);
    if (!component) throw new Error(`Missing bound component ${binding.componentId}`);
    const source = readProperty(component.properties, binding.path);
    const remapped = typeof source === 'string' ? (binding.kind === 'entity' ? entityIds : componentIds)[source] : undefined;
    if (!remapped) throw new Error('Prefab property binding must refer to an internal object of the declared kind');
    if (binding.kind === 'entity' && !component.entityRefs.includes(source as string)) throw new Error('Bound entity property must also appear in entityRefs');
    writeProperty(component.properties, binding.path, remapped);
  }
  for (const entity of entities) {
    const sourceEntityId = entity.id;
    entity.id = entityIds[sourceEntityId]!;
    entity.parentId = entity.parentId === null ? parentId : entityIds[entity.parentId]!;
    entity.prefab = { prefabId: prefab.prefabId, instanceId, sourceEntityId };
    for (const component of entity.components) {
      component.id = componentIds[component.id]!;
      component.entityRefs = component.entityRefs.map(id => entityIds[id]!);
    }
  }
  return { entities, entityIds, componentIds };
}
