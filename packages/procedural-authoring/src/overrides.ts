import { z } from 'zod';
import { entitySchema, idSchema, jsonValueSchema, parseScene, relativePathSchema, sceneSchema } from '@forgon/project-schema';
import type { Entity, JsonValue, SceneDocument } from '@forgon/project-schema';
import { readProperty, writeProperty } from './prefab.js';
import { stableId } from './identity.js';

const propertyPath = z.array(z.union([z.string().min(1).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value)), z.number().int().nonnegative()])).min(1);
const target = { overrideId: idSchema, entityId: idSchema, before: jsonValueSchema, value: jsonValueSchema };
export const overrideSchema = z.discriminatedUnion('field', [
  z.object({ ...target, field: z.enum(['name', 'enabled', 'transform']) }).strict(),
  z.object({ ...target, field: z.literal('property'), componentId: idSchema, path: propertyPath }).strict(),
]);
export type ManualOverride = z.infer<typeof overrideSchema>;
export const authoringArtifactSchema = z.object({
  formatVersion: z.literal(1), generator: z.object({ id: z.string().min(1), version: z.string().min(1), seed: z.string() }).strict(),
  base: sceneSchema, overrides: z.array(overrideSchema), detached: z.array(entitySchema),
  prefabBindings: z.array(z.object({ prefabId: idSchema, path: relativePathSchema }).strict()).optional(),
}).strict();
export type AuthoringArtifact = z.infer<typeof authoringArtifactSchema>;
export interface ReplayConflict { overrideId?: string; entityId?: string; reason: 'deleted-target' | 'generated-change' | 'invalid-result'; message: string }
export interface ReplayResult { scene: SceneDocument | null; conflicts: ReplayConflict[] }
export interface BakeResult extends ReplayResult { authoring: AuthoringArtifact | null }

function equal(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal((a as Record<string, JsonValue>)[key]!, (b as Record<string, JsonValue>)[key]!));
}
function withDetached(entities: Entity[], detached: Entity[]): Entity[] {
  const snapshots = new Map(detached.map(entity => [entity.id, entity]));
  const generatedIds = new Set(entities.map(entity => entity.id));
  return [...entities.map(entity => snapshots.get(entity.id) ?? entity), ...detached.filter(entity => !generatedIds.has(entity.id))];
}
export function parseAuthoringArtifact(input: unknown): AuthoringArtifact {
  const artifact = authoringArtifactSchema.parse(input);
  artifact.base = parseScene(artifact.base);
  if (new Set(artifact.overrides.map(item => item.overrideId)).size !== artifact.overrides.length) throw new Error('Duplicate override ID');
  if (new Set(artifact.detached.map(entity => entity.id)).size !== artifact.detached.length) throw new Error('Duplicate detached entity ID');
  if (artifact.detached.some(entity => entity.prefab)) throw new Error('Detached entities cannot retain prefab ownership');
  if (artifact.overrides.some(override => artifact.detached.some(entity => entity.id === override.entityId))) throw new Error('Detached edits belong in detached snapshots, not generated overrides');
  if (artifact.prefabBindings && (new Set(artifact.prefabBindings.map(ref => ref.prefabId)).size !== artifact.prefabBindings.length || new Set(artifact.prefabBindings.map(ref => ref.path)).size !== artifact.prefabBindings.length)) throw new Error('Duplicate prefab binding catalog entry');
  return artifact;
}

/** Capture supported visual edits; reject structural edits rather than silently dropping them. */
export function captureOverrides(input: AuthoringArtifact, edited: SceneDocument): AuthoringArtifact {
  const artifact = parseAuthoringArtifact(input);
  const scene = parseScene(edited);
  if (scene.sceneId !== artifact.base.sceneId || scene.name !== artifact.base.name) throw new Error('Scene identity/name changes require explicit project integration');
  const detachedIds = new Set(artifact.detached.map(entity => entity.id));
  const baseline = withDetached(artifact.base.entities, artifact.detached);
  if (baseline.length !== scene.entities.length || baseline.some((entity, index) => scene.entities[index]?.id !== entity.id)) throw new Error('Entity additions/deletions/reordering require explicit authoring integration');
  artifact.overrides = [];
  for (const before of baseline) {
    const after = scene.entities.find(entity => entity.id === before.id)!;
    if (detachedIds.has(before.id)) continue;
    if (before.parentId !== after.parentId || !equal(before.prefab ? { ...before.prefab } : null, after.prefab ? { ...after.prefab } : null)) throw new Error('Hierarchy/prefab edits require detach or explicit integration');
    for (const field of ['name', 'enabled', 'transform'] as const) {
      const original = before[field] as JsonValue; const value = after[field] as JsonValue;
      if (!equal(original, value)) artifact.overrides.push({ overrideId: stableId(scene.sceneId, `${before.id}:${field}`), entityId: before.id, field, before: original, value });
    }
    if (before.components.length !== after.components.length || before.components.some((component, index) => after.components[index]?.id !== component.id)) throw new Error('Component additions/removals/reordering require explicit integration');
    for (const component of before.components) {
      const changed = after.components.find(item => item.id === component.id);
      if (!changed || !equal({ ...component, properties: {} }, { ...changed, properties: {} })) throw new Error('Component identity/type/reference edits require explicit integration');
      const keys = Object.keys(component.properties);
      if (keys.length !== Object.keys(changed.properties).length || keys.some(key => !Object.hasOwn(changed.properties, key))) throw new Error('Property additions/removals require explicit integration');
      for (const key of keys) {
        const original = component.properties[key]!; const value = changed.properties[key]!;
        if (!equal(original, value)) artifact.overrides.push({ overrideId: stableId(scene.sceneId, JSON.stringify([before.id, component.id, key])), entityId: before.id,
          field: 'property', componentId: component.id, path: [key], before: original, value });
      }
    }
  }
  artifact.detached = scene.entities.filter(entity => detachedIds.has(entity.id));
  const checked = parseAuthoringArtifact(artifact);
  const replay = replayOverrides(checked);
  if (replay.conflicts.length || !replay.scene) throw new Error('Captured overrides are invalid');
  return checked;
}

/** Returns a preview and explicit conflicts; consumers must not save unresolved output. */
export function replayOverrides(input: AuthoringArtifact, generated: SceneDocument = input.base): ReplayResult {
  const artifact = parseAuthoringArtifact(input);
  const scene = parseScene(generated);
  if (scene.sceneId !== artifact.base.sceneId) throw new Error('Generator changed scene identity');
  scene.entities = withDetached(scene.entities, structuredClone(artifact.detached));
  const conflicts: ReplayConflict[] = [];
  for (const override of artifact.overrides) {
    const entity = scene.entities.find(entity => entity.id === override.entityId);
    const component = override.field === 'property' ? entity?.components.find(item => item.id === override.componentId) : undefined;
    if (!entity || (override.field === 'property' && !component)) {
      conflicts.push({ overrideId: override.overrideId, entityId: override.entityId, reason: 'deleted-target', message: 'Override target was removed by generation' });
      continue;
    }
    let current: JsonValue;
    try { current = override.field === 'property' ? readProperty(component!.properties, override.path) : entity[override.field] as JsonValue; }
    catch { conflicts.push({ overrideId: override.overrideId, entityId: entity.id, reason: 'deleted-target', message: 'Override property was removed by generation' }); continue; }
    if (equal(current, override.value)) continue;
    if (!equal(current, override.before)) {
      conflicts.push({ overrideId: override.overrideId, entityId: entity.id, reason: 'generated-change', message: 'Generator and manual edit both changed this field' });
      continue;
    }
    if (override.field === 'property') writeProperty(component!.properties, override.path, override.value);
    else (entity as unknown as Record<string, JsonValue>)[override.field] = structuredClone(override.value);
  }
  try { return { scene: parseScene(scene), conflicts }; }
  catch (error) { return { scene: null, conflicts: [...conflicts, { reason: 'invalid-result', message: String(error) }] }; }
}

/** A successful result carries both documents; persist them together through project-io. */
export function bakeAuthoring(input: AuthoringArtifact, generated: SceneDocument, generator: AuthoringArtifact['generator'] = input.generator): BakeResult {
  const artifact = parseAuthoringArtifact(input);
  if (generator.id !== artifact.generator.id) throw new Error('Cannot replace generator identity during bake');
  const result = replayOverrides(artifact, generated);
  if (!result.scene || result.conflicts.length) return { ...result, authoring: null };
  artifact.base = parseScene(generated);
  artifact.generator = structuredClone(generator);
  for (const override of artifact.overrides) {
    const entity = artifact.base.entities.find(entity => entity.id === override.entityId)!;
    override.before = structuredClone(override.field === 'property'
      ? readProperty(entity.components.find(component => component.id === override.componentId)!.properties, override.path)
      : entity[override.field] as JsonValue);
  }
  return { ...result, authoring: parseAuthoringArtifact(artifact) };
}

/** Detach a subtree and every member of any touched prefab instance, preserving current edits. */
export function detach(input: AuthoringArtifact, entityId: string): AuthoringArtifact {
  const artifact = parseAuthoringArtifact(input);
  const replay = replayOverrides(artifact);
  if (!replay.scene || replay.conflicts.length) throw new Error('Resolve overrides before detaching');
  if (!replay.scene.entities.some(entity => entity.id === entityId)) throw new Error(`Missing entity ${entityId}`);
  const ids = new Set([entityId]);
  let changed = true;
  while (changed) {
    changed = false;
    const instances = new Set(replay.scene.entities.filter(entity => ids.has(entity.id) && entity.prefab).map(entity => entity.prefab!.instanceId));
    for (const entity of replay.scene.entities) {
      if (!ids.has(entity.id) && ((entity.parentId !== null && ids.has(entity.parentId)) || (entity.prefab && instances.has(entity.prefab.instanceId)))) {
        ids.add(entity.id); changed = true;
      }
    }
  }
  const detached: Entity[] = replay.scene.entities.filter(entity => ids.has(entity.id)).map(entity => {
    const result = structuredClone(entity); delete result.prefab; return result;
  });
  artifact.detached = [...artifact.detached.filter(entity => !ids.has(entity.id)), ...detached];
  artifact.overrides = artifact.overrides.filter(override => !ids.has(override.entityId));
  return parseAuthoringArtifact(artifact);
}
