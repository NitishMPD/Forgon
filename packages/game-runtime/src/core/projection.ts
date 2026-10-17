import { Color, Entity, StandardMaterial, Vec3 } from 'playcanvas';
import type { Application } from 'playcanvas';
import type { Component, Entity as SceneEntity } from '@forgon/project-schema';

// Runtime component conventions come from docs/research/authoring-cli.md (v1 fixture contract):
// render/camera/light/collision project onto engine components; guestQueue/audio/vfx are
// runtime-owned behaviors handled in play sessions, not engine components.

export const SUPPORTED_COMPONENT_TYPES = ['render', 'camera', 'light', 'collision', 'guestQueue', 'audio', 'vfx'] as const;
export type SupportedComponentType = (typeof SUPPORTED_COMPONENT_TYPES)[number];

export interface ProjectionDiagnostics {
  /** Deduplicated "type/entityId" keys for component types the runtime does not render. */
  unsupported: string[];
}

export function createDiagnostics(): ProjectionDiagnostics {
  return { unsupported: [] };
}

/** Per-application material cache so materials are never shared across Application instances. */
export interface MaterialCache {
  forColor(color: unknown): StandardMaterial;
  dispose(): void;
}

export function createMaterialCache(): MaterialCache {
  const byKey = new Map<string, StandardMaterial>();
  return {
    dispose(): void { for (const material of byKey.values()) material.destroy(); byKey.clear(); },
    forColor(color: unknown): StandardMaterial {
      const value = colorOf(color, [0.8, 0.8, 0.8]);
      const key = [value.r, value.g, value.b].map(channel => channel.toFixed(4)).join(',');
      const cached = byKey.get(key);
      if (cached) return cached;
      const material = new StandardMaterial();
      material.diffuse = value;
      material.update();
      byKey.set(key, material);
      return material;
    },
  };
}

export interface SceneRegistry {
  /** Stable scene entity id -> live engine entity. */
  readonly byId: Map<string, Entity>;
  /** Engine entity -> stable scene entity id (for picking ancestry). */
  readonly idByNode: Map<Entity, string>;
}

export function createSceneRegistry(): SceneRegistry {
  return { byId: new Map(), idByNode: new Map() };
}

export function registerEntity(registry: SceneRegistry, entityId: string, entity: Entity): void {
  registry.byId.set(entityId, entity);
  registry.idByNode.set(entity, entityId);
}

export function unregisterEntity(registry: SceneRegistry, entityId: string): void {
  const entity = registry.byId.get(entityId);
  registry.byId.delete(entityId);
  if (entity) registry.idByNode.delete(entity);
}

/** Resolves the stable entity id owning a node by walking node ancestors up to the registry roots. */
export function resolveOwnerEntity(registry: SceneRegistry, node: unknown): string | null {
  let current = node as Entity | null;
  while (current) {
    const direct = registry.idByNode.get(current);
    if (direct !== undefined) return direct;
    const parent = current.getParent();
    current = (parent ?? null) as Entity | null;
  }
  return null;
}

function colorOf(value: unknown, fallback: [number, number, number]): Color {
  if (Array.isArray(value) && value.length >= 3 && value.every(item => typeof item === 'number')) {
    return new Color(value[0]!, value[1]!, value[2]!, 1);
  }
  return new Color(fallback[0], fallback[1], fallback[2], 1);
}

function vec3Of(value: unknown, fallback: [number, number, number]): Vec3 {
  if (Array.isArray(value) && value.length >= 3 && value.every(item => typeof item === 'number')) {
    return new Vec3(value[0]!, value[1]!, value[2]!);
  }
  return new Vec3(fallback[0], fallback[1], fallback[2]);
}

type Primitive = 'box' | 'sphere' | 'cylinder' | 'plane' | 'cone' | 'capsule' | 'torus';
const PRIMITIVE_TYPES = new Set(['box', 'sphere', 'cylinder', 'plane', 'cone', 'capsule', 'torus']);

/** Creates an engine entity (unattached) for a validated scene entity definition. */
export function createEntityFromDefinition(
  definition: SceneEntity,
  registry: SceneRegistry,
  materials: MaterialCache,
  diagnostics: ProjectionDiagnostics,
  play: boolean,
  app: Application,
): Entity {
  const entity = new Entity(definition.name, app);
  applyNameAndTransform(entity, definition);
  for (const component of definition.components) {
    applyComponent(entity, component, materials, play, diagnostics);
  }
  if (play && entity.rigidbody && definition.components.some(c => c.type === 'guestQueue' && c.enabled)) entity.rigidbody.type = 'kinematic';
  registerEntity(registry, definition.id, entity);
  return entity;
}

export function applyNameAndTransform(
  entity: Entity,
  definition: Pick<SceneEntity, 'name' | 'transform' | 'enabled'>,
): void {
  entity.name = definition.name;
  const { position, rotationEuler, scale } = definition.transform;
  entity.setLocalPosition(position[0], position[1], position[2]);
  entity.setLocalEulerAngles(rotationEuler[0], rotationEuler[1], rotationEuler[2]);
  entity.setLocalScale(scale[0], scale[1], scale[2]);
  entity.enabled = definition.enabled;
}

export function applyComponent(
  entity: Entity,
  component: Component,
  materials: MaterialCache,
  play: boolean,
  diagnostics: ProjectionDiagnostics,
): void {
  switch (component.type) {
    case 'render': {
      const primitive = typeof component.properties.primitive === 'string' && PRIMITIVE_TYPES.has(component.properties.primitive)
        ? component.properties.primitive as Primitive
        : 'box';
      const render = entity.render ?? entity.addComponent('render', { type: primitive })!;
      if (render.type !== primitive) render.type = primitive;
      render.castShadows = component.properties.castShadows !== false;
      render.material = materials.forColor(component.properties.color);
      render.enabled = component.enabled;
      return;
    }
    case 'camera': {
      const camera = entity.camera ?? entity.addComponent('camera', {})!;
      camera.fov = finiteNumber(component.properties.fov, 50);
      camera.nearClip = finiteNumber(component.properties.nearClip, 0.1);
      camera.farClip = finiteNumber(component.properties.farClip, 100);
      camera.clearColor = colorOf(component.properties.clearColor, [0.07, 0.09, 0.13]);
      // In edit mode the editor camera renders the canvas; authored cameras stay defined but
      // inert until a play session spawns them from the detached snapshot. An authored-disabled
      // camera stays disabled even during play.
      camera.enabled = play && component.enabled;
      return;
    }
    case 'light': {
      const kind = component.properties.kind === 'omni' ? 'omni'
        : component.properties.kind === 'spot' ? 'spot' : 'directional';
      const light = entity.light ?? entity.addComponent('light', { type: kind })!;
      if (light.type !== kind) light.type = kind;
      light.color = colorOf(component.properties.color, [1, 1, 1]);
      light.intensity = finiteNumber(component.properties.intensity, 1);
      light.castShadows = component.properties.castShadows === true;
      if (kind === 'omni') light.range = finiteNumber(component.properties.range, 10);
      light.enabled = component.enabled;
      return;
    }
    case 'collision': {
      const halfExtents = vec3Of(component.properties.halfExtents, [0.5, 0.5, 0.5]);
      const collision = entity.collision ?? entity.addComponent('collision', { type: 'box' })!;
      if (collision.type !== 'box') collision.type = 'box';
      // PlayCanvas primitive colliders use world dimensions, unlike render primitives.
      collision.halfExtents = halfExtents.mul(entity.getWorldTransform().getScale());
      collision.enabled = component.enabled;
      if (play && component.properties.isTrigger !== true) {
        const body = entity.rigidbody ?? entity.addComponent('rigidbody', { type: 'static' })!;
        body.enabled = component.enabled;
      }
      return;
    }
    // guestQueue/audio/vfx have no engine component; play sessions read the document data.
    default: {
      if (!SUPPORTED_COMPONENT_TYPES.includes(component.type as SupportedComponentType)) {
        const key = `${component.type}/${entity.name}`;
        if (!diagnostics.unsupported.includes(key)) diagnostics.unsupported.push(key);
      }
      return;
    }
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
