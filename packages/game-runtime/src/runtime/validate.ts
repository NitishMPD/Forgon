import { parseScene } from '@forgon/project-schema';
import type { SceneDocument, ValidationContext } from '@forgon/project-schema';

const properties: Record<string, readonly string[]> = {
  render: ['primitive', 'color', 'castShadows'],
  camera: ['fov', 'nearClip', 'farClip', 'clearColor'],
  light: ['kind', 'color', 'intensity', 'castShadows', 'range'],
  collision: ['shape', 'halfExtents', 'isTrigger'],
  guestQueue: ['waypoints', 'speed', 'arrivalRadius', 'loop', 'visualComponentId'],
  audio: ['assetId', 'autoplay', 'loop', 'volume'],
  vfx: ['kind', 'color', 'duration', 'autoplay'],
};

/** Node-safe validation of the exact semantics the bundled player implements. */
export function validatePlayableScene(input: unknown, context: ValidationContext = {}): SceneDocument {
  const scene = parseScene(input, context);
  const entities = new Map(scene.entities.map(entity => [entity.id, entity]));
  const active = (id: string): boolean => {
    const entity = entities.get(id)!;
    return entity.enabled && (entity.parentId === null || active(entity.parentId));
  };
  let cameras = 0;
  for (const entity of scene.entities) {
    const types = new Set<string>();
    for (const component of entity.components) {
      const p = component.properties;
      const fail = (detail: string): never => { throw new Error(`Unsupported ${component.type} ${component.id}: ${detail}`); };
      const allowed = properties[component.type];
      if (!allowed) fail('component type');
      if (types.has(component.type)) fail('multiple components of the same type on one entity');
      types.add(component.type);
      for (const key of Object.keys(p)) if (!allowed!.includes(key)) fail(`property ${key}`);
      const number = (key: string, min: number, max = Infinity): void => {
        if (p[key] !== undefined && (typeof p[key] !== 'number' || p[key] < min || p[key] > max)) fail(key);
      };
      const choice = (key: string, values: readonly unknown[]): void => {
        if (p[key] !== undefined && !values.includes(p[key])) fail(key);
      };
      const vector = (key: string, min: number, max = Infinity): void => {
        const value = p[key];
        if (value !== undefined && (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || n < min || n > max))) fail(key);
      };
      for (const key of ['castShadows', 'isTrigger', 'autoplay', 'loop']) choice(key, [true, false]);
      switch (component.type) {
        case 'render':
          choice('primitive', ['box', 'sphere', 'cylinder', 'plane', 'cone', 'capsule', 'torus']); vector('color', 0, 1); break;
        case 'camera':
          number('fov', 1, 179); number('nearClip', 0.001); number('farClip', 0.002); vector('clearColor', 0, 1);
          if (Number(p.farClip ?? 100) <= Number(p.nearClip ?? 0.1)) fail('farClip must exceed nearClip');
          if (component.enabled && active(entity.id)) cameras++;
          break;
        case 'light':
          choice('kind', ['directional', 'omni']); vector('color', 0, 1); number('intensity', 0); number('range', 0.001); break;
        case 'collision':
          choice('shape', ['box']); vector('halfExtents', 0.000001);
          if (p.isTrigger === true && entity.components.some(c => c.type === 'guestQueue' && c.enabled)) fail('moving queue triggers are not implemented');
          // Bullet boxes require positive, nonsheared world scales.
          for (let current: typeof entity | undefined = entity; current; current = current.parentId === null ? undefined : entities.get(current.parentId)) {
            if (current.transform.scale.some(n => n <= 0)) fail('colliders require positive ancestor scales');
            if (current !== entity && new Set(current.transform.scale).size !== 1) fail('colliders require uniform ancestor scale');
          }
          break;
        case 'guestQueue': {
          number('speed', 0.000001); number('arrivalRadius', 0.000001);
          if (!Array.isArray(p.waypoints) || p.waypoints.length === 0 || p.waypoints.some(id => typeof id !== 'string' || !entities.has(id) || !component.entityRefs.includes(id))) fail('waypoints must be declared entity references');
          if (p.visualComponentId !== undefined && (typeof p.visualComponentId !== 'string' || !entity.components.some(c => c.id === p.visualComponentId && c.type === 'render'))) fail('visualComponentId must reference this entity render component');
          break;
        }
        case 'audio':
          number('volume', 0, 1);
          if (typeof p.assetId !== 'string' || !component.assetRefs.includes(p.assetId) || !context.assets?.some(asset => asset.id === p.assetId && asset.kind === 'audio')) fail('assetId must reference a catalogued audio asset');
          break;
        case 'vfx':
          choice('kind', ['arrivalPulse']); vector('color', 0, 1); number('duration', 0.000001);
          if (!entity.components.some(c => c.type === 'render' && c.enabled)) fail('arrivalPulse requires an enabled render component');
          break;
      }
      if (component.type !== 'audio' && component.assetRefs.length) fail('asset-backed rendering is not implemented');
    }
  }
  if (cameras !== 1) throw new Error(`Playable scene requires exactly one enabled camera; received ${cameras}`);
  return scene;
}
