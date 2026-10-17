import type { Object3D } from 'three';
import type { SceneDocument } from '@forgon/project-schema';
import {
  SceneNode,
  disposeGraph,
  removeEngineComponent,
  applyComponent,
  applyNameAndTransform,
  createDiagnostics,
  createEntityFromDefinition,
  createMaterialCache,
  createSceneRegistry,
  type MaterialCache,
  type ProjectionDiagnostics,
  type SceneRegistry,
} from './projection.js';

export interface ReconcileStats {
  added: string[];
  removed: string[];
  patched: string[];
}

export interface ReconcileTarget {
  /** Node under which root-level (parentId null) entities live. */
  root: Object3D;
  registry: SceneRegistry;
  materials: MaterialCache;
  diagnostics: ProjectionDiagnostics;
  /** Scene ids whose engine transforms must not be patched (active gizmo gesture). */
  draggingIds?: ReadonlySet<string>;
}

const previousComponents = new WeakMap<SceneNode, SceneDocument['entities'][number]['components']>();

/** Reconcile in two passes: document order never determines hierarchy correctness. */
export function reconcileScene(target: ReconcileTarget, scene: SceneDocument): ReconcileStats {
  const stats: ReconcileStats = { added: [], removed: [], patched: [] };
  const { registry, root } = target;
  const ids = new Set(scene.entities.map(entity => entity.id));
  for (const definition of scene.entities) {
    if (!registry.byId.has(definition.id)) {
      const entity = createEntityFromDefinition(definition, registry, target.materials, target.diagnostics, false);
      root.add(entity);
      previousComponents.set(entity, structuredClone(definition.components));
      stats.added.push(definition.id);
    }
  }
  // Detach changed parents first so reversing an ancestor relation cannot create a cycle.
  for (const definition of scene.entities) {
    const entity = registry.byId.get(definition.id)!;
    const parent = definition.parentId === null ? root : registry.byId.get(definition.parentId)!;
    if (entity.parent !== parent) root.add(entity);
  }
  for (const definition of scene.entities) {
    const entity = registry.byId.get(definition.id)!;
    const parent = definition.parentId === null ? root : registry.byId.get(definition.parentId)!;
    if (entity.parent !== parent) parent.add(entity);
  }
  for (const [id, entity] of registry.byId) {
    if (ids.has(id)) continue;
    disposeGraph(entity);
    registry.byId.delete(id);
    registry.idByNode.delete(entity);
    stats.removed.push(id);
  }
  for (const definition of scene.entities) {
    const entity = registry.byId.get(definition.id)!;
    if (!target.draggingIds?.has(definition.id)) applyNameAndTransform(entity, definition);
    else { entity.name = definition.name; entity.visible = definition.enabled; }
    const before = previousComponents.get(entity) ?? [];
    const next = definition.components;
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      for (const component of before) {
        if (!next.some(candidate => candidate.type === component.type)) removeEngineComponent(entity, component.type);
      }
      for (const component of next) applyComponent(entity, component, target.materials, false, target.diagnostics);
      previousComponents.set(entity, structuredClone(next));
      stats.patched.push(definition.id);
    }
  }
  return stats;
}

/** Projects a complete scene into a fresh root; used for play sessions and initial mount. */
export function projectScene(
  root: Object3D,
  scene: SceneDocument,
  play: boolean,
): { registry: SceneRegistry; materials: MaterialCache; diagnostics: ProjectionDiagnostics } {
  const registry = createSceneRegistry();
  const materials = createMaterialCache();
  const diagnostics = createDiagnostics();

  // Create flat first (validation guarantees unique ids), then parent, then transforms.
  const created = new Map<string, SceneNode>();
  for (const definition of scene.entities) {
    const entity = new SceneNode();
    applyNameAndTransform(entity, definition);
    registry.byId.set(definition.id, entity);
    registry.idByNode.set(entity, definition.id);
    created.set(definition.id, entity);
    previousComponents.set(entity, structuredClone(definition.components));
  }
  for (const definition of scene.entities) {
    const entity = created.get(definition.id)!;
    const parent = definition.parentId === null ? root : created.get(definition.parentId);
    if (parent) parent.add(entity);
  }
  // Physics dimensions and body poses depend on the complete world hierarchy.
  for (const definition of scene.entities) {
    const entity = created.get(definition.id)!;
    for (const component of definition.components) applyComponent(entity, component, materials, play, diagnostics);
    if (entity.collision) entity.collision.kinematic = definition.components.some(c => (c.type === 'guestQueue' || c.type === 'movingPlatform') && c.enabled);
  }
  return { registry, materials, diagnostics };
}
