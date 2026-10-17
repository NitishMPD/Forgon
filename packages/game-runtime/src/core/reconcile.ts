import { Entity } from 'playcanvas';
import type { Application } from 'playcanvas';
import type { SceneDocument } from '@forgon/project-schema';
import {
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
  app: Application;
  /** Node under which root-level (parentId null) entities live. */
  root: Entity;
  registry: SceneRegistry;
  materials: MaterialCache;
  diagnostics: ProjectionDiagnostics;
  /** Scene ids whose engine transforms must not be patched (active gizmo gesture). */
  draggingIds?: ReadonlySet<string>;
}

const previousComponents = new WeakMap<Entity, SceneDocument['entities'][number]['components']>();

/** Reconcile in two passes: document order never determines hierarchy correctness. */
export function reconcileScene(target: ReconcileTarget, scene: SceneDocument): ReconcileStats {
  const stats: ReconcileStats = { added: [], removed: [], patched: [] };
  const { registry, root } = target;
  const ids = new Set(scene.entities.map(entity => entity.id));
  for (const definition of scene.entities) {
    if (!registry.byId.has(definition.id)) {
      const entity = createEntityFromDefinition(definition, registry, target.materials, target.diagnostics, false, target.app);
      root.addChild(entity);
      previousComponents.set(entity, structuredClone(definition.components));
      stats.added.push(definition.id);
    }
  }
  // Detach changed parents first so reversing an ancestor relation cannot create a cycle.
  for (const definition of scene.entities) {
    const entity = registry.byId.get(definition.id)!;
    const parent = definition.parentId === null ? root : registry.byId.get(definition.parentId)!;
    if (entity.parent !== parent) entity.reparent(root);
  }
  for (const definition of scene.entities) {
    const entity = registry.byId.get(definition.id)!;
    const parent = definition.parentId === null ? root : registry.byId.get(definition.parentId)!;
    if (entity.parent !== parent) entity.reparent(parent);
  }
  for (const [id, entity] of registry.byId) {
    if (ids.has(id)) continue;
    entity.destroy();
    registry.byId.delete(id);
    registry.idByNode.delete(entity);
    stats.removed.push(id);
  }
  for (const definition of scene.entities) {
    const entity = registry.byId.get(definition.id)!;
    if (!target.draggingIds?.has(definition.id)) applyNameAndTransform(entity, definition);
    else { entity.name = definition.name; entity.enabled = definition.enabled; }
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

function removeEngineComponent(entity: Entity, type: string): void {
  if (type !== 'render' && type !== 'camera' && type !== 'light' && type !== 'collision') return;
  if (entity[type]) entity.removeComponent(type);
}

/** Projects a complete scene into a fresh root; used for play sessions and initial mount. */
export function projectScene(
  root: Entity,
  scene: SceneDocument,
  play: boolean,
  app: Application,
): { registry: SceneRegistry; materials: MaterialCache; diagnostics: ProjectionDiagnostics } {
  const registry = createSceneRegistry();
  const materials = createMaterialCache();
  const diagnostics = createDiagnostics();

  // Create flat first (validation guarantees unique ids), then parent, then transforms.
  const created = new Map<string, Entity>();
  for (const definition of scene.entities) {
    const entity = new Entity(definition.name, app);
    applyNameAndTransform(entity, definition);
    registry.byId.set(definition.id, entity);
    registry.idByNode.set(entity, definition.id);
    created.set(definition.id, entity);
  }
  for (const definition of scene.entities) {
    const entity = created.get(definition.id)!;
    const parent = definition.parentId === null ? root : created.get(definition.parentId);
    if (parent) parent.addChild(entity);
  }
  // Physics dimensions and body poses depend on the complete world hierarchy.
  for (const definition of scene.entities) {
    const entity = created.get(definition.id)!;
    for (const component of definition.components) applyComponent(entity, component, materials, play, diagnostics);
    if (play && entity.rigidbody && definition.components.some(c => c.type === 'guestQueue' && c.enabled)) entity.rigidbody.type = 'kinematic';
  }
  return { registry, materials, diagnostics };
}
