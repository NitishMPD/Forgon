import { parseScene } from '@forgon/project-schema';
import type { SceneDocument, ValidationContext } from '@forgon/project-schema';

const properties: Record<string, readonly string[]> = {
  render: ['primitive', 'color', 'castShadows'],
  camera: ['fov', 'nearClip', 'farClip', 'clearColor', 'mode', 'distance', 'height', 'lag', 'intro', 'speedFov', 'lookAhead'],
  light: ['kind', 'color', 'intensity', 'castShadows', 'range'],
  collision: ['shape', 'halfExtents', 'isTrigger', 'surface'],
  guestQueue: ['waypoints', 'speed', 'arrivalRadius', 'loop', 'visualComponentId'],
  audio: ['assetId', 'autoplay', 'loop', 'volume'],
  vfx: ['kind', 'color', 'duration', 'autoplay'],
  // Parkour course vocabulary (Sector demo).
  player: ['runSpeed', 'sprintSpeed', 'groundAccel', 'airControl', 'friction', 'gravity', 'terminalVelocity',
    'jumpVelocity', 'doubleJumpVelocity', 'maxJumps', 'coyoteTime', 'jumpBuffer', 'wallRun', 'wallRunGravity',
    'wallRunTime', 'wallRunSpeed', 'wallJumpUp', 'wallJumpOut', 'slide', 'slideSpeed', 'slideTime', 'slideHeight',
    'radius', 'height', 'fallLimit', 'invulnerable', 'spawn', 'spawnFacing', 'spawnOffsetY'],
  movingPlatform: ['waypoints', 'speed', 'mode', 'wait'],
  checkpoint: ['index', 'radius', 'spawn', 'offsetY'],
  collectible: ['value', 'radius', 'offsetY'],
  goal: ['radius', 'offsetY'],
  hazard: ['kind', 'halfExtents'],
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
  let players = 0;
  let spawnCheckpoints = 0;
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
      const integer = (key: string, min: number, max = Infinity): void => {
        if (p[key] !== undefined && (!Number.isInteger(p[key]) || (p[key] as number) < min || (p[key] as number) > max)) fail(key);
      };
      const choice = (key: string, values: readonly unknown[]): void => {
        if (p[key] !== undefined && !values.includes(p[key])) fail(key);
      };
      const vector = (key: string, min: number, max = Infinity): void => {
        const value = p[key];
        if (value !== undefined && (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || n < min || n > max))) fail(key);
      };
      /** Ordered waypoint lists must also be declared in entityRefs. */
      const waypoints = (key: string): void => {
        const value = p[key];
        if (value !== undefined && (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || !entities.has(id) || !component.entityRefs.includes(id)))) fail('waypoints must be declared entity references');
      };
      for (const key of ['castShadows', 'isTrigger', 'autoplay', 'loop', 'wallRun', 'slide', 'spawn']) choice(key, [true, false]);
      switch (component.type) {
        case 'render':
          choice('primitive', ['box', 'sphere', 'cylinder', 'plane', 'cone', 'capsule', 'torus']); vector('color', 0, 1); break;
        case 'camera':
          number('fov', 1, 179); number('nearClip', 0.001); number('farClip', 0.002); vector('clearColor', 0, 1);
          choice('mode', ['static', 'follow']); number('distance', 0.5); number('height', -10); number('lag', 0);
          number('intro', 0, 60); number('speedFov', 0, 90); number('lookAhead', 0, 5);
          if (Number(p.farClip ?? 100) <= Number(p.nearClip ?? 0.1)) fail('farClip must exceed nearClip');
          if (component.enabled && active(entity.id)) cameras++;
          break;
        case 'light':
          choice('kind', ['directional', 'omni', 'spot']); vector('color', 0, 1); number('intensity', 0); number('range', 0.001); break;
        case 'collision':
          choice('shape', ['box']); vector('halfExtents', 0.000001); number('surface', 0, 1);
          if (p.isTrigger === true && entity.components.some(c => c.type === 'guestQueue' && c.enabled)) fail('moving queue triggers are not implemented');
          if (p.isTrigger !== true && entity.components.some(c => c.type === 'movingPlatform' && c.enabled)) fail('moving platform colliders must be triggers');
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
        case 'player': {
          number('runSpeed', 0.1, 100); number('sprintSpeed', 0.1, 200); number('groundAccel', 0.1, 1000);
          number('airControl', 0, 1); number('friction', 0, 200); number('gravity', 0.1, 200);
          number('terminalVelocity', 1, 400); number('jumpVelocity', 0.1, 100); number('doubleJumpVelocity', 0.1, 100);
          integer('maxJumps', 1, 8); number('coyoteTime', 0, 2); number('jumpBuffer', 0, 2);
          number('wallRunGravity', 0, 1); number('wallRunTime', 0, 10); number('wallRunSpeed', 0.1, 100);
          number('wallJumpUp', 0.1, 100); number('wallJumpOut', 0.1, 100);
          number('slideSpeed', 0.1, 100); number('slideTime', 0.05, 10); number('slideHeight', 0.1, 10);
          number('radius', 0.05, 3); number('height', 0.2, 6); number('fallLimit', -10000, 10000); number('invulnerable', 0, 10);
          number('spawnFacing', -100000, 100000); number('spawnOffsetY', -10, 10);
          if (p.spawn !== undefined && (typeof p.spawn !== 'string' || !entities.has(p.spawn) || !component.entityRefs.includes(p.spawn))) fail('spawn must be a declared entity reference');
          if (component.enabled && active(entity.id)) players++;
          break;
        }
        case 'movingPlatform':
          waypoints('waypoints'); number('speed', 0.000001); number('wait', 0, 60); choice('mode', ['pingpong', 'loop']);
          if (!entity.components.some(c => c.type === 'collision' && c.enabled && c.properties.isTrigger === true)) fail('movingPlatform requires a trigger collision box');
          break;
        case 'checkpoint':
          integer('index', 0, 999); number('radius', 0.05, 50); number('offsetY', -50, 50);
          if (p.spawn === true && component.enabled && active(entity.id)) spawnCheckpoints++;
          break;
        case 'collectible':
          number('value', 0, 1000); number('radius', 0.05, 50); number('offsetY', -50, 50); break;
        case 'goal':
          number('radius', 0.1, 100); number('offsetY', -50, 50); break;
        case 'hazard':
          choice('kind', ['plasma', 'void']); vector('halfExtents', 0.000001); break;
      }
      if (component.type !== 'audio' && component.assetRefs.length) fail('asset-backed rendering is not implemented');
    }
  }
  if (cameras !== 1) throw new Error(`Playable scene requires exactly one enabled camera; received ${cameras}`);
  if (players > 1) throw new Error(`Playable scene requires at most one enabled player; received ${players}`);
  if (players === 1 && spawnCheckpoints > 1) throw new Error(`Parkour scene requires at most one spawn checkpoint; received ${spawnCheckpoints}`);
  return scene;
}
