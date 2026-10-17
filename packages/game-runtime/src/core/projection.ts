import { BoxGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, PlaneGeometry, PointLight, DirectionalLight, SpotLight, SphereGeometry, TorusGeometry, Vector3, MathUtils, Quaternion, Euler } from 'three';
import type { BufferGeometry, Light } from 'three';
import type { Component, Entity as SceneEntity } from '@forgon/project-schema';

// Behavior components remain session-owned; only visual components become Three objects.
export const SUPPORTED_COMPONENT_TYPES = [
  'render', 'camera', 'light', 'collision', 'guestQueue', 'audio', 'vfx',
  // Parkour gameplay vocabulary: simulated by the play session, no engine component.
  'player', 'movingPlatform', 'checkpoint', 'collectible', 'goal', 'hazard',
] as const;
export type SupportedComponentType = (typeof SUPPORTED_COMPONENT_TYPES)[number];

export interface ProjectionDiagnostics {
  /** Deduplicated "type/entityName" keys for component types the runtime does not render. */
  unsupported: string[];
}

export function createDiagnostics(): ProjectionDiagnostics {
  return { unsupported: [] };
}


export class SceneNode extends Group {
  render?: Mesh<BufferGeometry, MeshStandardMaterial>;
  camera?: PerspectiveCamera;
  light?: Light;
  collision?: { halfExtents: Vector3; enabled: boolean; isTrigger: boolean; kinematic: boolean };
}

/** Materials belong to one projected graph, never to individual mesh disposal. */
export interface MaterialCache {
  forColor(color: unknown): MeshStandardMaterial;
  geometry(primitive: unknown): BufferGeometry;
  dispose(): void;
}
export function createMaterialCache(): MaterialCache {
  const byKey = new Map<string, MeshStandardMaterial>();
  const geometries = new Map<unknown, BufferGeometry>();
  return {
    dispose() {
      for (const material of byKey.values()) material.dispose(); byKey.clear();
      for (const value of geometries.values()) value.dispose(); geometries.clear();
    },
    geometry(primitive) {
      let value = geometries.get(primitive);
      if (!value) { value = geometry(primitive); geometries.set(primitive, value); }
      return value;
    },
    forColor(color) {
      const value = colorOf(color, [0.8, 0.8, 0.8]);
      const key = [value.r, value.g, value.b].map(channel => channel.toFixed(4)).join(',');
      let material = byKey.get(key);
      if (!material) { material = new MeshStandardMaterial({ color: value, roughness: 0.7 }); byKey.set(key, material); }
      return material;
    },
  };
}
export interface SceneRegistry {
  readonly byId: Map<string, SceneNode>;
  readonly idByNode: Map<Object3D, string>;
}
export function createSceneRegistry(): SceneRegistry { return { byId: new Map(), idByNode: new Map() }; }
export function registerEntity(registry: SceneRegistry, id: string, entity: SceneNode): void {
  registry.byId.set(id, entity); registry.idByNode.set(entity, id);
}
export function unregisterEntity(registry: SceneRegistry, id: string): void {
  const entity = registry.byId.get(id); registry.byId.delete(id); if (entity) registry.idByNode.delete(entity);
}
export function resolveOwnerEntity(registry: SceneRegistry, node: unknown): string | null {
  let current = node instanceof Object3D ? node : null;
  while (current) { const id = registry.idByNode.get(current); if (id !== undefined) return id; current = current.parent; }
  return null;
}
export function isVisible(node: Object3D): boolean {
  for (let current: Object3D | null = node; current; current = current.parent) if (!current.visible) return false;
  return true;
}
function colorOf(value: unknown, fallback: [number, number, number]): Color {
  const rgb = Array.isArray(value) && value.length >= 3 && value.every(n => typeof n === 'number' && Number.isFinite(n)) ? value : fallback;
  return new Color(rgb[0]!, rgb[1]!, rgb[2]!);
}
function geometry(primitive: unknown): BufferGeometry {
  switch (primitive) {
    case 'sphere': return new SphereGeometry(0.5, 32, 16);
    case 'cylinder': return new CylinderGeometry(0.5, 0.5, 1, 32);
    case 'plane': return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    case 'cone': return new ConeGeometry(0.5, 1, 32);
    case 'capsule': return new CapsuleGeometry(0.5, 1, 8, 24);
    case 'torus': return new TorusGeometry(0.3, 0.2, 16, 32).rotateX(-Math.PI / 2);
    default: return new BoxGeometry(1, 1, 1);
  }
}
export function createEntityFromDefinition(definition: SceneEntity, registry: SceneRegistry, materials: MaterialCache, diagnostics: ProjectionDiagnostics, play: boolean): SceneNode {
  const entity = new SceneNode();
  applyNameAndTransform(entity, definition);
  for (const component of definition.components) applyComponent(entity, component, materials, play, diagnostics);
  if (entity.collision) entity.collision.kinematic = definition.components.some(c => (c.type === 'guestQueue' || c.type === 'movingPlatform') && c.enabled);
  registerEntity(registry, definition.id, entity);
  return entity;
}
export function applyNameAndTransform(entity: SceneNode, definition: Pick<SceneEntity, 'name' | 'transform' | 'enabled'>): void {
  entity.name = definition.name;
  entity.position.fromArray(definition.transform.position);
  setRotationDegrees(entity, ...definition.transform.rotationEuler);
  entity.scale.fromArray(definition.transform.scale);
  entity.visible = definition.enabled;
}
export function setRotationDegrees(entity: Object3D, x: number, y: number, z: number): void {
  // PlayCanvas applies X, then Y, then Z (Three's intrinsic ZYX order).
  entity.rotation.set(MathUtils.degToRad(x), MathUtils.degToRad(y), MathUtils.degToRad(z), 'ZYX');
}
export function rotationDegrees(entity: Object3D): Vector3 {
  const euler = new Euler().setFromQuaternion(entity.quaternion, 'ZYX');
  return new Vector3(euler.x, euler.y, euler.z).multiplyScalar(180 / Math.PI);
}
export function setWorldPosition(entity: Object3D, x: number, y: number, z: number): void {
  entity.position.set(x, y, z);
  if (entity.parent) { entity.parent.updateWorldMatrix(true, false); entity.parent.worldToLocal(entity.position); }
}
export function setWorldRotationDegrees(entity: Object3D, x: number, y: number, z: number): void {
  const rotation = new Quaternion().setFromEuler(new Euler(MathUtils.degToRad(x), MathUtils.degToRad(y), MathUtils.degToRad(z), 'ZYX'));
  if (entity.parent) rotation.premultiply(entity.parent.getWorldQuaternion(new Quaternion()).invert());
  entity.quaternion.copy(rotation);
}
export function removeEngineComponent(entity: SceneNode, type: string): void {
  if (type === 'collision') { delete entity.collision; return; }
  if (type !== 'render' && type !== 'camera' && type !== 'light') return;
  const object = entity[type];
  if (object) { object.removeFromParent(); if ('dispose' in object && typeof object.dispose === 'function') object.dispose(); }
  delete entity[type];
}
/** Release nodes and light shadow targets; cached and pulse materials have separate owners. */
export function disposeGraph(root: Object3D): void {
  const nodes: SceneNode[] = [];
  root.traverse(node => { if (node instanceof SceneNode) nodes.push(node); });
  for (const node of nodes) for (const type of ['render', 'camera', 'light']) removeEngineComponent(node, type);
  root.removeFromParent(); root.clear();
}
export function applyComponent(entity: SceneNode, component: Component, materials: MaterialCache, play: boolean, diagnostics: ProjectionDiagnostics): void {
  const p = component.properties;
  switch (component.type) {
    case 'render': {
      removeEngineComponent(entity, 'render');
      const mesh = new Mesh(materials.geometry(p.primitive), materials.forColor(p.color));
      mesh.castShadow = p.castShadows !== false; mesh.receiveShadow = true; mesh.visible = component.enabled;
      entity.render = mesh; entity.add(mesh); return;
    }
    case 'camera': {
      removeEngineComponent(entity, 'camera');
      const camera = new PerspectiveCamera(finiteNumber(p.fov, 50), 1, finiteNumber(p.nearClip, 0.1), finiteNumber(p.farClip, 100));
      camera.visible = play && component.enabled;
      camera.userData.clearColor = colorOf(p.clearColor, [0.07, 0.09, 0.13]);
      entity.camera = camera; entity.add(camera); return;
    }
    case 'light': {
      removeEngineComponent(entity, 'light');
      const color = colorOf(p.color, [1, 1, 1]); const intensity = finiteNumber(p.intensity, 1);
      const light = p.kind === 'omni' ? new PointLight(color, intensity, finiteNumber(p.range, 10), 0)
        : p.kind === 'spot' ? new SpotLight(color, intensity, finiteNumber(p.range, 10), Math.PI / 4, 0, 0) : new DirectionalLight(color, intensity);
      if (light instanceof DirectionalLight || light instanceof SpotLight) { light.target.position.set(0, -1, 0); light.add(light.target); }
      light.castShadow = p.castShadows === true; light.visible = component.enabled;
      light.shadow.mapSize.set(1024, 1024);
      if (light instanceof DirectionalLight) {
        Object.assign(light.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 0.1, far: 200 });
        light.shadow.camera.updateProjectionMatrix();
      }
      entity.light = light; entity.add(light); return;
    }
    case 'collision': {
      const half = Array.isArray(p.halfExtents) && p.halfExtents.length >= 3
        && p.halfExtents.every(value => typeof value === 'number' && Number.isFinite(value))
        ? p.halfExtents as number[] : [0.5, 0.5, 0.5];
      entity.collision = { halfExtents: new Vector3().fromArray(half), enabled: component.enabled, isTrigger: p.isTrigger === true, kinematic: false }; return;
    }
    default: {
      if (!SUPPORTED_COMPONENT_TYPES.includes(component.type as SupportedComponentType)) {
        const key = `${component.type}/${entity.name}`; if (!diagnostics.unsupported.includes(key)) diagnostics.unsupported.push(key);
      }
    }
  }
}
function finiteNumber(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
