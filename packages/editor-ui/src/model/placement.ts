import { duplicatePlan, type SceneCommand } from '@forgon/editor-core';
import { createEntity, createId, idSchema, parsePrefab, type AssetRecord, type PrefabDocument } from '@forgon/project-schema';
import type { SurfacePoint } from '../services.js';

export const primitives = ['box', 'sphere', 'cylinder', 'plane', 'cone', 'capsule', 'torus'] as const;
export type Primitive = (typeof primitives)[number];
export type PlacementTarget = { kind: 'primitive'; primitive: Primitive } | { kind: 'prefab'; prefabId: string } | { kind: 'model'; assetId: string };
/** Runtime surface queries optionally carry bounds from their loaded GLB cache. */
export interface PlacementSurface extends SurfacePoint { modelMinY?(assetId: string): number | null }
export const placementMime = 'application/x-forgon-placement';

export function searchPlacements(assets: readonly AssetRecord[], prefabs: readonly PrefabDocument[], query: string): { name: string; detail: string; target: PlacementTarget }[] {
  const choices = [
    ...primitives.map(primitive => ({ name: primitive, detail: 'Primitive', target: { kind: 'primitive', primitive } as PlacementTarget })),
    ...prefabs.map(prefab => ({ name: prefab.name, detail: 'Prefab', target: { kind: 'prefab', prefabId: prefab.prefabId } as PlacementTarget })),
    ...assets.filter(asset => asset.kind === 'model' && /\.glb$/i.test(asset.path)).map(asset => ({ name: asset.name, detail: asset.path, target: { kind: 'model', assetId: asset.id } as PlacementTarget })),
  ];
  const needle = query.trim().toLowerCase();
  return choices.filter(choice => `${choice.name} ${choice.detail}`.toLowerCase().includes(needle));
}

export function parsePlacement(text: string): PlacementTarget | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const target = value as Record<string, unknown>;
    if (target['kind'] === 'primitive' && (primitives as readonly unknown[]).includes(target['primitive'])) {
      return { kind: 'primitive', primitive: target['primitive'] as Primitive };
    }
    if (target['kind'] === 'prefab' && typeof target['prefabId'] === 'string' && idSchema.safeParse(target['prefabId']).success) {
      return { kind: 'prefab', prefabId: target['prefabId'] };
    }
    if (target['kind'] === 'model' && typeof target['assetId'] === 'string' && idSchema.safeParse(target['assetId']).success) {
      return { kind: 'model', assetId: target['assetId'] };
    }
    return null;
  } catch { return null; }
}

export function placementCommand(target: PlacementTarget, surface: PlacementSurface, prefabs: readonly PrefabDocument[], alignToSurface = false): { command: SceneCommand; selectedId: string } {
  if (surface.position.length !== 3 || !surface.position.every(Number.isFinite)) throw new Error('Placement needs a finite surface point.');
  let rotation: [number, number, number] | undefined;
  if (alignToSurface) {
    if (surface.normal.length !== 3 || !surface.normal.every(Number.isFinite) || Math.hypot(...surface.normal) < 1e-9) throw new Error('Alignment needs a finite, nonzero surface normal.');
    const [x, y, z] = surface.normal;
    // ZYX degrees match the runtime: Rz * Rx rotates the object's +Y axis onto the normal.
    rotation = [Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, 0, Math.atan2(-x, y) * 180 / Math.PI];
  }
  if (target.kind === 'primitive') {
    if (!(primitives as readonly string[]).includes(target.primitive)) throw new Error('Unknown primitive.');
    const entity = createEntity(target.primitive[0]!.toUpperCase() + target.primitive.slice(1));
    const minY = target.primitive === 'plane' ? 0 : target.primitive === 'capsule' ? -1 : target.primitive === 'torus' ? -0.2 : -0.5;
    entity.transform.position = bottomAtSurface(surface, minY, alignToSurface);
    if (rotation) entity.transform.rotationEuler = rotation;
    entity.components.push({ id: createId('component'), type: 'render', enabled: true, properties: { primitive: target.primitive }, entityRefs: [], assetRefs: [] });
    return { command: { type: 'create', entity }, selectedId: entity.id };
  }
  if (target.kind === 'model') {
    idSchema.parse(target.assetId);
    const entity = createEntity('Model');
    entity.transform.position = bottomAtSurface(surface, surface.modelMinY?.(target.assetId) ?? 0, alignToSurface);
    if (rotation) entity.transform.rotationEuler = rotation;
    entity.components.push({ id: createId('component'), type: 'model', enabled: true, properties: {}, entityRefs: [], assetRefs: [target.assetId] });
    return { command: { type: 'create', entity }, selectedId: entity.id };
  }
  const input = prefabs.find(prefab => prefab.prefabId === target.prefabId);
  if (!input) throw new Error('The prefab is no longer in the project. Refresh Assets and try again.');
  const prefab = parsePrefab(input);
  if (prefab.entities.some(entity => entity.prefab)) throw new Error('Nested prefab instantiation is not supported.');
  const plan = duplicatePlan(prefab.entities, [prefab.rootId], createId, 0);
  if (!plan.ok) throw new Error(plan.reason);
  const instanceId = createId('instance');
  const selectedId = plan.value.topLevelIds[0]!;
  plan.value.commands.forEach((command, index) => {
    if (command.type !== 'create') return;
    const entity = command.entity;
    entity.prefab = { prefabId: prefab.prefabId, instanceId, sourceEntityId: prefab.entities[index]!.id };
    if (entity.id === selectedId) {
      entity.name = prefab.name;
      entity.transform.position = [...surface.position];
      if (rotation) entity.transform.rotationEuler = rotation;
    }
  });
  return { command: { type: 'batch', commands: plan.value.commands }, selectedId };
}

function bottomAtSurface(surface: SurfacePoint, minY: number, aligned: boolean): [number, number, number] {
  if (!Number.isFinite(minY)) throw new Error('Placement needs finite model bounds.');
  const direction = aligned ? surface.normal : [0, 1, 0];
  const length = Math.hypot(...direction);
  return surface.position.map((value, index) => value - minY * direction[index]! / length) as [number, number, number];
}
