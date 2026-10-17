// Pure parkour simulation for the Sector demo. Engine-free and DOM-free so the whole
// course is unit-testable headlessly: the play session only writes the resulting
// transforms back onto the projected PlayCanvas graph.
//
// The controller is a swept-AABB character specialised to the authored box geometry of a
// Forgon level (rooftops, catwalks, walls). Sweeping against explicit boxes gives parkour
// the predictable, snappy feel a general-purpose rigidbody cannot, and keeps deterministic
// replay possible. Movement vocabulary: run, sprint, coyote jump, double jump, wall run,
// wall jump and slide.
//
// Conventions: Y is up, positions are metres in world space, `position` is the feet centre.

import type { Component, Entity, SceneDocument } from '@forgon/project-schema';

export interface Vec3 { x: number; y: number; z: number }
export interface Aabb { min: Vec3; max: Vec3 }

export interface ParkourConfig {
  /** Grounded top speed, metres/second. */
  runSpeed: number;
  /** Sprinting top speed while grounded. */
  sprintSpeed: number;
  /** Horizontal acceleration while grounded. */
  groundAccel: number;
  /** Fraction of ground acceleration available mid-air. */
  airControl: number;
  /** Ground friction applied to horizontal speed. */
  friction: number;
  gravity: number;
  /** Downward speed cap so long falls stay stable. */
  terminalVelocity: number;
  jumpVelocity: number;
  doubleJumpVelocity: number;
  maxJumps: number;
  /** Grace window after leaving a ledge where a jump still counts as grounded. */
  coyoteTime: number;
  /** Window a jump press is remembered before landing. */
  jumpBuffer: number;
  wallRun: boolean;
  /** Gravity multiplier while wall running. */
  wallRunGravity: number;
  /** Time a single wall run can be sustained. */
  wallRunTime: number;
  /** Forward speed swept up while wall running. */
  wallRunSpeed: number;
  wallJumpUp: number;
  wallJumpOut: number;
  slide: boolean;
  /** Speed a slide starts at. */
  slideSpeed: number;
  slideTime: number;
  /** Collider height while sliding; also the visual crouch. */
  slideHeight: number;
  /** Standing capsule half-width. */
  radius: number;
  /** Standing capsule height. */
  height: number;
  /** Falling below this Y is a death. */
  fallLimit: number;
  /** Seconds of hazard immunity after a respawn. */
  invulnerable: number;
}

export const DEFAULT_PARKOUR_CONFIG: ParkourConfig = {
  runSpeed: 7.5, sprintSpeed: 12, groundAccel: 70, airControl: 0.4, friction: 14,
  gravity: 27, terminalVelocity: 48, jumpVelocity: 10.5, doubleJumpVelocity: 9.2, maxJumps: 2,
  coyoteTime: 0.12, jumpBuffer: 0.15, wallRun: true, wallRunGravity: 0.22, wallRunTime: 1.5,
  wallRunSpeed: 13, wallJumpUp: 10, wallJumpOut: 8, slide: true, slideSpeed: 14, slideTime: 0.75,
  slideHeight: 0.85, radius: 0.42, height: 1.85, fallLimit: -40, invulnerable: 0.6,
};

export interface ParkourInputState {
  /** Local strafe, -1..1 (positive is right of the camera). */
  moveX: number;
  /** Local forward, -1..1 (positive is the camera's facing direction). */
  moveZ: number;
  /** True only on the frame the jump control is pressed. */
  jump: boolean;
  /** True while the jump control is held (variable jump height). */
  jumpHeld: boolean;
  sprint: boolean;
  /** True only on the frame the slide control is pressed. */
  slide: boolean;
  /** Yaw of the chase camera in radians; movement is camera-relative. */
  cameraYaw: number;
}

export function createInputState(): ParkourInputState {
  return { moveX: 0, moveZ: 0, jump: false, jumpHeld: false, sprint: false, slide: false, cameraYaw: 0 };
}

export type ParkourEvent =
  | { type: 'jump'; double: boolean }
  | { type: 'land'; impact: number }
  | { type: 'wall-run'; side: -1 | 1 }
  | { type: 'wall-jump'; side: -1 | 1 }
  | { type: 'slide' }
  | { type: 'slide-end' }
  | { type: 'checkpoint'; entityId: string; index: number }
  | { type: 'collect'; entityId: string; value: number }
  | { type: 'death'; reason: 'fall' | 'hazard'; entityId: string | null; deaths: number }
  | { type: 'respawn'; checkpointEntityId: string; index: number }
  | { type: 'goal'; time: number; deaths: number; collected: number; total: number };

export interface StaticSolid { id: string; box: Aabb; surface: number }
export interface PlatformDef {
  id: string;
  /** World half-extents of the box (already scaled). */
  half: Vec3;
  /** World-space centre path; index 0 is the authored position. */
  waypoints: Vec3[];
  speed: number;
  pingPong: boolean;
  wait: number;
}
export interface PlatformState { id: string; position: Vec3; segment: number; travel: number; forward: boolean; waitRemaining: number }
export interface CheckpointDef { id: string; center: Vec3; groundY: number; radius: number; index: number; spawn: boolean }
export interface CollectibleDef { id: string; center: Vec3; radius: number; value: number }
export interface HazardDef { id: string; box: Aabb }
export interface GoalDef { id: string; center: Vec3; radius: number }

export interface ParkourLevel {
  config: ParkourConfig;
  playerId: string;
  spawn: Vec3;
  spawnFacing: number;
  solids: StaticSolid[];
  platforms: PlatformDef[];
  checkpoints: CheckpointDef[];
  collectibles: CollectibleDef[];
  hazards: HazardDef[];
  goal: GoalDef | null;
}

export interface ParkourVisual {
  /** Forward lean in radians; positive leans into the run. */
  lean: number;
  /** Body roll in radians; positive rolls right (wall run / hard strafe). */
  roll: number;
  /** 1 at full standing height, 0 fully slid. */
  stance: number;
  /** 0..1 squash on landing, 1..1.2 stretch in fast flight. */
  stretch: number;
  /** Run-cycle phase in radians, advanced by distance travelled while grounded. */
  runPhase: number;
  /** True while the controller is driving locomotion (drives limb animation). */
  moving: boolean;
}

export interface ParkourState {
  position: Vec3;
  velocity: Vec3;
  /** Yaw the body faces, radians. */
  facing: number;
  grounded: boolean;
  groundId: string | null;
  groundSurface: number;
  contacts: { left: boolean; right: boolean; ceiling: boolean; floor: boolean };
  jumps: number;
  coyote: number;
  buffer: number;
  wall: { side: -1 | 1; timeLeft: number; cooldown: number } | null;
  sliding: boolean;
  slideTimer: number;
  invulnerable: number;
  checkpointIndex: number;
  respawn: Vec3;
  collected: string[];
  time: number;
  deaths: number;
  finished: boolean;
  finishTime: number | null;
  speed: number;
  platforms: PlatformState[];
  visual: ParkourVisual;
  /** Set while the player is riding a moving platform this frame (carry applied). */
  riding: string | null;
}

export interface BuildOptions {
  /** Restrict building to a specific player entity, otherwise the first `player` component wins. */
  playerId?: string;
}

// --- transform math (dependency-free so level building stays headless) -----------------

type Mat3 = [number, number, number, number, number, number, number, number, number];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  }
  return out as Mat3;
}
function rotationMatrix(degrees: readonly [number, number, number], scale: readonly [number, number, number]): Mat3 {
  const [rx, ry, rz] = degrees.map(value => value * Math.PI / 180) as [number, number, number];
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // R = Ry * Rx * Rz; exact for the axis-aligned/yaw-only boxes the level uses.
  const m: Mat3 = [
    cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx,
  ];
  return [m[0]! * scale[0], m[1]! * scale[0], m[2]! * scale[0], m[3]! * scale[1], m[4]! * scale[1], m[5]! * scale[1], m[6]! * scale[2], m[7]! * scale[2], m[8]! * scale[2]];
}
function apply(m: Mat3, v: readonly [number, number, number]): Vec3 {
  return { x: m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], y: m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], z: m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2] };
}

interface WorldTransform { m: Mat3; t: Vec3 }

function worldTransforms(entities: readonly Entity[]): Map<string, WorldTransform> {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const cache = new Map<string, WorldTransform>();
  const compute = (entity: Entity): WorldTransform => {
    const cached = cache.get(entity.id);
    if (cached) return cached;
    const local: WorldTransform = { m: rotationMatrix(entity.transform.rotationEuler, entity.transform.scale), t: { x: entity.transform.position[0], y: entity.transform.position[1], z: entity.transform.position[2] } };
    const parent = entity.parentId === null ? undefined : byId.get(entity.parentId);
    const result = parent
      ? (() => { const p = compute(parent); return { m: mul(p.m, local.m), t: add(p.t, apply(p.m, [local.t.x, local.t.y, local.t.z])) }; })()
      : local;
    cache.set(entity.id, result);
    return result;
  };
  for (const entity of entities) compute(entity);
  return cache;
}

function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function clone(a: Vec3): Vec3 { return { x: a.x, y: a.y, z: a.z }; }
function vec(x: number, y: number, z: number): Vec3 { return { x, y, z }; }

/** World-space AABB for a local box of half extents centred on the entity origin. */
function boxOf(transform: WorldTransform, half: readonly [number, number, number]): Aabb {
  const min = vec(Infinity, Infinity, Infinity);
  const max = vec(-Infinity, -Infinity, -Infinity);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const corner = apply(transform.m, [half[0] * sx, half[1] * sy, half[2] * sz]);
    const point = add(transform.t, corner);
    min.x = Math.min(min.x, point.x); min.y = Math.min(min.y, point.y); min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x); max.y = Math.max(max.y, point.y); max.z = Math.max(max.z, point.z);
  }
  return { min, max };
}

function enabledComponent(entity: Entity, type: string): Component | undefined {
  return entity.components.find(component => component.type === type && component.enabled);
}
function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Reads the player component's optional overrides over the shared defaults. */
export function parkourConfig(properties: Record<string, unknown> | undefined): ParkourConfig {
  const config = { ...DEFAULT_PARKOUR_CONFIG } as unknown as Record<string, number | boolean>;
  if (!properties) return config as unknown as ParkourConfig;
  for (const key of Object.keys(DEFAULT_PARKOUR_CONFIG)) {
    const value = properties[key];
    if (typeof DEFAULT_PARKOUR_CONFIG[key as keyof ParkourConfig] === 'boolean') config[key] = boolOf(value, config[key] as boolean);
    else config[key] = numberOf(value, config[key] as number);
  }
  return config as unknown as ParkourConfig;
}

/** Builds the immutable collision/trigger description for a parkour scene. Returns null without a player. */
export function buildParkourLevel(scene: SceneDocument, options: BuildOptions = {}): ParkourLevel | null {
  const playerEntity = options.playerId
    ? scene.entities.find(entity => entity.id === options.playerId)
    : scene.entities.find(entity => enabledComponent(entity, 'player'));
  const playerComponent = playerEntity ? enabledComponent(playerEntity, 'player') : undefined;
  if (!playerEntity || !playerComponent) return null;
  const config = parkourConfig(playerComponent.properties);
  const transforms = worldTransforms(scene.entities);

  // Everything under the player (visual rig) is never level geometry.
  const aboard = new Set<string>([playerEntity.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entity of scene.entities) {
      if (entity.parentId && aboard.has(entity.parentId) && !aboard.has(entity.id)) { aboard.add(entity.id); grew = true; }
    }
  }

  const solids: StaticSolid[] = [];
  const platforms: PlatformDef[] = [];
  const checkpoints: CheckpointDef[] = [];
  const collectibles: CollectibleDef[] = [];
  const hazards: HazardDef[] = [];
  let goal: GoalDef | null = null;
  let spawn: Vec3 = { x: 0, y: 0, z: 0 };
  let spawnFacing = 0;

  if (playerComponent.properties.spawn !== undefined) {
    const spawnId = typeof playerComponent.properties.spawn === 'string' ? playerComponent.properties.spawn : null;
    const target = spawnId ? transforms.get(spawnId) : undefined;
    if (target) spawn = clone(target.t);
  } else {
    spawn = clone(transforms.get(playerEntity.id)?.t ?? spawn);
  }
  spawnFacing = numberOf(playerComponent.properties.spawnFacing, 0) * Math.PI / 180;

  for (const entity of scene.entities) {
    if (aboard.has(entity.id)) continue;
    const transform = transforms.get(entity.id);
    if (!transform) continue;
    const collision = enabledComponent(entity, 'collision');
    const platform = enabledComponent(entity, 'movingPlatform');
    const hazard = enabledComponent(entity, 'hazard');
    const checkpoint = enabledComponent(entity, 'checkpoint');
    const collectible = enabledComponent(entity, 'collectible');
    const goalComponent = enabledComponent(entity, 'goal');
    if (hazard) {
      const half = hazard.properties.halfExtents;
      const extents = Array.isArray(half) && half.length === 3 && half.every(value => typeof value === 'number')
        ? half as [number, number, number] : [0.5, 0.5, 0.5] as [number, number, number];
      hazards.push({ id: entity.id, box: boxOf(transform, extents) });
    }
    if (checkpoint) {
      const anchor = checkpoint.properties.offsetY !== undefined
        ? add(transform.t, { x: 0, y: numberOf(checkpoint.properties.offsetY, 0), z: 0 })
        : clone(transform.t);
      checkpoints.push({ id: entity.id, center: anchor, groundY: transform.t.y, radius: numberOf(checkpoint.properties.radius, 2), index: numberOf(checkpoint.properties.index, checkpoints.length), spawn: checkpoint.properties.spawn === true });
    }
    if (collectible) {
      const anchor = add(transform.t, { x: 0, y: numberOf(collectible.properties.offsetY, 0), z: 0 });
      collectibles.push({ id: entity.id, center: anchor, radius: numberOf(collectible.properties.radius, 1.1), value: numberOf(collectible.properties.value, 1) });
    }
    if (goalComponent) {
      const anchor = add(transform.t, { x: 0, y: numberOf(goalComponent.properties.offsetY, 0), z: 0 });
      goal = { id: entity.id, center: anchor, radius: numberOf(goalComponent.properties.radius, 2.4) };
    }
    if (platform && collision) {
      const half = collision.properties.halfExtents;
      const extents = Array.isArray(half) && half.length === 3 && half.every(value => typeof value === 'number')
        ? half as [number, number, number] : [0.5, 0.5, 0.5] as [number, number, number];
      const worldHalf = apply(transform.m, extents);
      const ids = Array.isArray(platform.properties.waypoints) ? platform.properties.waypoints.filter((id): id is string => typeof id === 'string') : [];
      const waypoints = ids.map(id => transforms.get(id)?.t).filter((point): point is Vec3 => Boolean(point)).map(clone);
      if (waypoints.length === 0) waypoints.push(clone(transform.t));
      platforms.push({
        id: entity.id, half: { x: Math.abs(worldHalf.x), y: Math.abs(worldHalf.y), z: Math.abs(worldHalf.z) },
        waypoints, speed: Math.max(numberOf(platform.properties.speed, 2), 0.0001),
        pingPong: platform.properties.mode !== 'loop', wait: Math.max(numberOf(platform.properties.wait, 0), 0),
      });
      continue;
    }
    if (collision && collision.properties.isTrigger !== true) {
      const half = collision.properties.halfExtents;
      const extents = Array.isArray(half) && half.length === 3 && half.every(value => typeof value === 'number')
        ? half as [number, number, number] : [0.5, 0.5, 0.5] as [number, number, number];
      solids.push({ id: entity.id, box: boxOf(transform, extents), surface: numberOf(collision.properties.surface, 0) });
    }
  }

  checkpoints.sort((a, b) => a.index - b.index);
  const spawnCheckpoint = checkpoints.find(checkpoint => checkpoint.spawn);
  if (spawnCheckpoint) {
    spawn = add(checkpointSpawn(spawnCheckpoint), { x: 0, y: numberOf(playerComponent.properties.spawnOffsetY, 0), z: 0 });
  }
  return {
    config, playerId: playerEntity.id, spawn, spawnFacing, solids, platforms, checkpoints,
    collectibles, hazards, goal,
  };
}

export function createParkourState(level: ParkourLevel): ParkourState {
  const start = level.checkpoints.find(checkpoint => checkpoint.spawn);
  const spawn = clone(level.spawn);
  return {
    position: clone(spawn), velocity: vec(0, 0, 0), facing: level.spawnFacing,
    grounded: false, groundId: null, groundSurface: 0,
    contacts: { left: false, right: false, ceiling: false, floor: false },
    jumps: 0, coyote: 0, buffer: 0, wall: null,
    sliding: false, slideTimer: 0, invulnerable: 0,
    checkpointIndex: start ? start.index : 0, respawn: clone(spawn),
    collected: [], time: 0, deaths: 0, finished: false, finishTime: null, speed: 0,
    platforms: level.platforms.map(platform => ({ id: platform.id, position: clone(platform.waypoints[0]!), segment: 0, travel: 0, forward: true, waitRemaining: 0 })),
    visual: { lean: 0, roll: 0, stance: 1, stretch: 1, runPhase: 0, moving: false },
    riding: null,
  };
}

function playerBox(position: Vec3, radius: number, height: number): Aabb {
  return {
    min: vec(position.x - radius, position.y, position.z - radius),
    max: vec(position.x + radius, position.y + height, position.z + radius),
  };
}
function overlaps(a: Aabb, b: Aabb): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y && a.min.z < b.max.z && a.max.z > b.min.z;
}

interface CollisionBox { id: string; box: Aabb; surface: number; platform: boolean }

/** Advances every moving platform and returns the world delta applied to each. */
function stepPlatforms(state: ParkourState, level: ParkourLevel, dt: number): Map<string, Vec3> {
  const deltas = new Map<string, Vec3>();
  for (const [index, platform] of level.platforms.entries()) {
    const motion = state.platforms[index]!;
    const previous = clone(motion.position);
    if (platform.waypoints.length > 1) {
      if (motion.waitRemaining > 0) {
        motion.waitRemaining = Math.max(0, motion.waitRemaining - dt);
      } else {
        let budget = platform.speed * dt;
        while (budget > 0) {
          const from = platform.waypoints[motion.segment]!;
          const toIndex = motion.forward ? motion.segment + 1 : motion.segment - 1;
          const to = platform.waypoints[toIndex];
          if (!to) { // reverse at the end for ping-pong, or wrap for loop platforms
            if (platform.pingPong) { motion.forward = !motion.forward; continue; }
            motion.segment = 0; motion.travel = 0; motion.position = clone(platform.waypoints[0]!); break;
          }
          const leg = sub(to, from);
          const length = Math.hypot(leg.x, leg.y, leg.z);
          if (length < 1e-9) { motion.segment = toIndex; motion.travel = 0; continue; }
          const remaining = (1 - motion.travel) * length;
          const stepSize = Math.min(budget, remaining);
          const ratio = motion.travel + stepSize / length;
          motion.position = add(from, scale(leg, ratio));
          motion.travel = ratio;
          budget -= stepSize;
          if (ratio >= 1 - 1e-9) {
            motion.segment = toIndex; motion.travel = 0; motion.position = clone(to); motion.waitRemaining = platform.wait;
            if (!platform.pingPong) {
              const next = motion.segment + 1;
              if (next >= platform.waypoints.length) { motion.segment = 0; motion.position = clone(platform.waypoints[0]!); }
            } else if (motion.segment >= platform.waypoints.length - 1) {
              motion.forward = false;
            } else if (motion.segment <= 0) {
              motion.forward = true;
            }
            // Dwell at the station: any leftover budget waits for the next frame, so the platform
            // rests exactly on its waypoint (riders stepping off need the authored height).
            if (motion.waitRemaining > 0) break;
          }
        }
      }
    }
    deltas.set(platform.id, sub(motion.position, previous));
  }
  return deltas;
}

/** Where the player should stand when respawning at a checkpoint: the ground under its volume. */
export function checkpointSpawn(checkpoint: CheckpointDef): Vec3 {
  return { x: checkpoint.center.x, y: checkpoint.groundY, z: checkpoint.center.z };
}

/** Position of the player's centre of mass, used for trigger checks. */
function torso(state: ParkourState, height: number): Vec3 {
  return { x: state.position.x, y: state.position.y + height * 0.5, z: state.position.z };
}

function respawn(state: ParkourState, level: ParkourLevel, events: ParkourEvent[]): void {
  const checkpoint = level.checkpoints.find(entry => entry.index === state.checkpointIndex);
  state.position = add(clone(state.respawn), { x: 0, y: 0.05, z: 0 });
  state.velocity = vec(0, 0, 0);
  state.sliding = false; state.slideTimer = 0; state.wall = null; state.jumps = 0;
  state.invulnerable = level.config.invulnerable;
  state.visual.stretch = 1;
  events.push({ type: 'respawn', checkpointEntityId: checkpoint ? checkpoint.id : '', index: state.checkpointIndex });
}

/** Fixed-step advance. Deterministic and allocation-light; reuses no hidden timers. */
export function stepParkour(state: ParkourState, level: ParkourLevel, input: ParkourInputState, dt: number, events: ParkourEvent[]): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const config = level.config;
  const deltas = stepPlatforms(state, level, dt);

  // Ride a moving platform: apply the delta the platform travelled this step.
  state.riding = null;
  if (state.groundId && deltas.has(state.groundId)) {
    state.position = add(state.position, deltas.get(state.groundId)!);
    state.riding = state.groundId;
  }

  const cos = Math.cos(input.cameraYaw), sin = Math.sin(input.cameraYaw);
  // Camera-relative basis: forward = (sin, 0, cos), right = (-cos, 0, sin) — the chase camera
  // settles to yaw 180° facing +Z, so screen right points along world -X.
  const length = Math.hypot(input.moveX, input.moveZ);
  const clampedX = length > 1 ? input.moveX / length : input.moveX;
  const clampedZ = length > 1 ? input.moveZ / length : input.moveZ;
  const wish = vec(-clampedX * cos + clampedZ * sin, 0, clampedX * sin + clampedZ * cos);
  const wishSpeed = Math.hypot(wish.x, wish.z);

  if (state.invulnerable > 0) state.invulnerable = Math.max(0, state.invulnerable - dt);
  if (state.buffer > 0) state.buffer = Math.max(0, state.buffer - dt);
  if (state.wall && state.wall.cooldown > 0) state.wall.cooldown = Math.max(0, state.wall.cooldown - dt);

  // Sliding maintains momentum; anything else slides to a stop under friction.
  if (state.sliding) {
    state.slideTimer -= dt;
    const tooSlow = Math.hypot(state.velocity.x, state.velocity.z) < config.runSpeed * 0.45;
    if (state.slideTimer <= 0 || !state.grounded || tooSlow) { state.sliding = false; events.push({ type: 'slide-end' }); }
  }
  if (input.slide && config.slide && state.grounded && !state.sliding && Math.hypot(state.velocity.x, state.velocity.z) > config.runSpeed * 0.7) {
    state.sliding = true; state.slideTimer = config.slideTime;
    const heading = Math.hypot(state.velocity.x, state.velocity.z) || 1;
    const boost = config.slideSpeed / heading;
    state.velocity.x *= Math.min(boost, 1.25); state.velocity.z *= Math.min(boost, 1.25);
    if (wishSpeed > 0.01) state.facing = Math.atan2(wish.x, wish.z);
    events.push({ type: 'slide' });
  }

  // Wall run: airborne, moving with intent, and touching a wall while heading along it.
  const nearWall = state.contacts.left || state.contacts.right;
  const canRun = config.wallRun && !state.grounded && !state.sliding && nearWall
    && wishSpeed > 0.35 && (!state.wall || state.wall.cooldown <= 0) && state.velocity.y < config.jumpVelocity * 0.55;
  if (canRun) {
    const side: -1 | 1 = state.contacts.right ? 1 : -1;
    // A fresh run (no wall yet, or the previous run/jump has burned out) re-arms the timer.
    if (!state.wall || state.wall.timeLeft <= 0) {
      state.wall = { side, timeLeft: config.wallRunTime, cooldown: 0 };
      events.push({ type: 'wall-run', side });
    }
    state.wall.side = side;
    state.wall.timeLeft = Math.max(0, state.wall.timeLeft - dt);
    // Running out of juice enforces a short cooldown so wall runs stay a burst, not a glide.
    if (state.wall.timeLeft <= 0) state.wall.cooldown = Math.max(state.wall.cooldown, 0.35);
  } else if (state.wall && state.grounded) {
    state.wall = null;
  }
  const wallRunning = Boolean(state.wall && state.wall.timeLeft > 0 && !state.grounded);

  if (input.jump) state.buffer = config.jumpBuffer;
  if (state.buffer > 0) {
    if (state.grounded || state.coyote > 0) {
      state.velocity.y = config.jumpVelocity;
      state.jumps = 0; state.buffer = 0; state.coyote = 0; state.sliding = false;
      if (wishSpeed > 0.01) state.facing = Math.atan2(wish.x, wish.z);
      events.push({ type: 'jump', double: false });
    } else if (wallRunning && state.wall) {
      const side = state.wall.side;
      state.velocity.y = config.wallJumpUp;
      state.velocity.x += -side * config.wallJumpOut;
      state.velocity.z += 0;
      state.wall = { side, timeLeft: 0, cooldown: 0.3 };
      state.buffer = 0; state.jumps = 1;
      events.push({ type: 'wall-jump', side });
    } else if (state.jumps < config.maxJumps - 1 || (state.jumps === 0 && config.maxJumps > 1)) {
      state.velocity.y = config.doubleJumpVelocity;
      state.jumps += 1; state.buffer = 0;
      events.push({ type: 'jump', double: true });
    }
  }

  // Horizontal acceleration: grounded grip, limited air control, full control while wall running.
  const sprinting = input.sprint && !state.sliding;
  const target = sprinting ? config.sprintSpeed : config.runSpeed;
  const control = state.grounded ? 1 : wallRunning ? 0.85 : config.airControl;
  if (wishSpeed > 0.01 && !state.sliding) {
    const accel = config.groundAccel * control;
    const desired = scale(wish, target / wishSpeed);
    const delta = sub(desired, state.velocity);
    delta.y = 0;
    const needed = Math.hypot(delta.x, delta.z);
    const applied = Math.min(accel * dt, needed);
    if (needed > 1e-6) { state.velocity.x += delta.x / needed * applied; state.velocity.z += delta.z / needed * applied; }
    state.facing = Math.atan2(wish.x, wish.z);
  }
  if ((state.grounded && wishSpeed <= 0.01 && !state.sliding) || (state.grounded && state.sliding)) {
    const damping = config.friction * (state.sliding ? 0.35 : 1) * dt;
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    const scaleFactor = speed > 1e-6 ? Math.max(0, speed - damping) / speed : 0;
    state.velocity.x *= scaleFactor; state.velocity.z *= scaleFactor;
  } else if (!state.grounded && wishSpeed <= 0.01) {
    const damping = 1.5 * dt;
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    const scaleFactor = speed > 1e-6 ? Math.max(0, speed - damping) / speed : 0;
    state.velocity.x *= scaleFactor; state.velocity.z *= scaleFactor;
  }
  // Wall run accelerates forward along the wall.
  if (wallRunning) {
    const speed = Math.hypot(state.velocity.x, state.velocity.z) || 1;
    const boost = Math.min(config.wallRunSpeed, speed + config.groundAccel * 0.4 * dt);
    state.velocity.x *= boost / speed; state.velocity.z *= boost / speed;
  }
  // Gravity, softened while wall running; variable jump height on release.
  const gravity = config.gravity * (wallRunning ? config.wallRunGravity : 1);
  const rising = state.velocity.y > 0;
  state.velocity.y = Math.max(-config.terminalVelocity, state.velocity.y - gravity * dt);
  // Variable jump height: releasing the button early clips the rise.
  if (rising && !input.jumpHeld && !wallRunning) state.velocity.y = Math.min(state.velocity.y, config.jumpVelocity * 0.45);

  // Integrate with swept AABB resolution, substepped so fast falls cannot tunnel.
  const height = state.sliding ? config.slideHeight : config.height;
  // Sample the fall speed before resolution zeroes it, so landing impact is real.
  const fallSpeed = Math.abs(state.velocity.y);
  const boxes: CollisionBox[] = level.solids.map(solid => ({ id: solid.id, box: solid.box, surface: solid.surface, platform: false }));
  for (const [index, platform] of level.platforms.entries()) {
    const motion = state.platforms[index]!;
    boxes.push({ id: platform.id, platform: true, surface: 0, box: {
      min: vec(motion.position.x - platform.half.x, motion.position.y - platform.half.y, motion.position.z - platform.half.z),
      max: vec(motion.position.x + platform.half.x, motion.position.y + platform.half.y, motion.position.z + platform.half.z),
    } });
  }

  // A moving platform can rise into a body that is only a hair above it, leaving the box and the
  // collider overlapping. Resolve that before the sweep, on the shallowest axis, so the platform
  // lifts the feet instead of the horizontal sweep flinging the body off the side.
  depenetrate(state, boxes, config, height);

  state.contacts = { left: false, right: false, ceiling: false, floor: false };
  const wasGrounded = state.grounded;
  state.grounded = false; state.groundId = null;
  const maxDelta = Math.max(Math.abs(state.velocity.x), Math.abs(state.velocity.y), Math.abs(state.velocity.z)) * dt;
  const steps = Math.max(1, Math.ceil(maxDelta / (config.radius * 0.8)));
  const stepDt = dt / steps;
  for (let step = 0; step < steps; step++) {
    moveAxis(state, 0, state.velocity.x * stepDt, boxes, config, height);
    moveAxis(state, 2, state.velocity.z * stepDt, boxes, config, height);
    moveAxis(state, 1, state.velocity.y * stepDt, boxes, config, height);
  }

  if (state.grounded && !wasGrounded) {
    const impact = Math.min(1, fallSpeed / config.terminalVelocity);
    events.push({ type: 'land', impact });
    state.visual.stretch = 1 - 0.25 * impact;
  }
  if (state.grounded) {
    state.coyote = config.coyoteTime; state.jumps = 0; state.wall = null;
  } else {
    state.coyote = Math.max(0, state.coyote - dt);
  }

  if (state.wall && state.wall.timeLeft > 0 && (state.contacts.left || state.contacts.right)) state.wall.side = state.contacts.right ? 1 : -1;

  // Triggers: checkpoints, shards, goal.
  const center = torso(state, height);
  for (const checkpoint of level.checkpoints) {
    if (checkpoint.spawn) continue;
    if (checkpoint.index <= state.checkpointIndex) continue;
    if (distance(center, checkpoint.center) <= checkpoint.radius) {
      state.checkpointIndex = checkpoint.index;
      state.respawn = checkpointSpawn(checkpoint);
      events.push({ type: 'checkpoint', entityId: checkpoint.id, index: checkpoint.index });
    }
  }
  if (state.invulnerable <= 0) {
    for (const collectible of level.collectibles) {
      if (state.collected.includes(collectible.id)) continue;
      if (distance(center, collectible.center) <= collectible.radius) {
        state.collected.push(collectible.id);
        events.push({ type: 'collect', entityId: collectible.id, value: collectible.value });
      }
    }
  }
  if (!state.finished && level.goal && distance(center, level.goal.center) <= level.goal.radius) {
    state.finished = true; state.finishTime = state.time;
    events.push({ type: 'goal', time: state.time, deaths: state.deaths, collected: state.collected.length, total: level.collectibles.length });
  }

  // Deaths: hazards, or leaving the course.
  if (state.invulnerable <= 0) {
    const body = playerBox(state.position, config.radius, height);
    for (const hazard of level.hazards) {
      if (overlaps(body, hazard.box)) {
        state.deaths += 1;
        events.push({ type: 'death', reason: 'hazard', entityId: hazard.id, deaths: state.deaths });
        respawn(state, level, events);
        break;
      }
    }
  }
  if (state.position.y < config.fallLimit) {
    state.deaths += 1;
    events.push({ type: 'death', reason: 'fall', entityId: null, deaths: state.deaths });
    respawn(state, level, events);
  }

  if (!state.finished) state.time += dt;
  state.speed = Math.hypot(state.velocity.x, state.velocity.z);

  // Visual smoothing for the rig/animation layer.
  const visual = state.visual;
  const targetLean = state.sliding ? 0.9 : Math.min(0.5, state.speed / config.sprintSpeed * 0.5);
  visual.lean += (targetLean - visual.lean) * Math.min(1, dt * 6);
  const targetRoll = wallRunning && state.wall ? state.wall.side * 0.45 : 0;
  visual.roll += (targetRoll - visual.roll) * Math.min(1, dt * 8);
  visual.stance += ((state.sliding ? 0 : 1) - visual.stance) * Math.min(1, dt * 10);
  const targetStretch = state.grounded ? 1 : Math.max(0.92, Math.min(1.14, 1 + state.velocity.y / 60));
  visual.stretch += (targetStretch - visual.stretch) * Math.min(1, dt * 8);
  visual.moving = state.speed > 0.4 || !state.grounded;
  if (state.grounded) visual.runPhase = (visual.runPhase + state.speed * dt * 2.4) % (Math.PI * 2);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Resolves any overlap the body already has with a collider, moving it out along the shallowest
 * axis. This is the escape hatch for geometry that moved into the body (a rising platform) rather
 * than the body moving into geometry, which the swept axes below cannot express.
 */
function depenetrate(state: ParkourState, boxes: readonly CollisionBox[], config: ParkourConfig, height: number): void {
  for (let pass = 0; pass < 4; pass++) {
    const body = playerBox(state.position, config.radius, height);
    let hit = false;
    for (const candidate of boxes) {
      if (!overlaps(body, candidate.box)) continue;
      const outNegX = body.max.x - candidate.box.min.x;
      const outPosX = candidate.box.max.x - body.min.x;
      const outNegY = body.max.y - candidate.box.min.y;
      const outPosY = candidate.box.max.y - body.min.y;
      const outNegZ = body.max.z - candidate.box.min.z;
      const outPosZ = candidate.box.max.z - body.min.z;
      const depthX = Math.min(outNegX, outPosX);
      const depthY = Math.min(outNegY, outPosY);
      const depthZ = Math.min(outNegZ, outPosZ);
      // Ties favour Y so a platform meeting the feet always lifts instead of shoving sideways.
      if (depthY <= depthX && depthY <= depthZ) state.position.y += outPosY < outNegY ? outPosY : -outNegY;
      else if (depthX <= depthZ) state.position.x += outPosX < outNegX ? outPosX : -outNegX;
      else state.position.z += outPosZ < outNegZ ? outPosZ : -outNegZ;
      hit = true;
      break;
    }
    if (!hit) break;
  }
}

/** Moves on one axis and pushes out of every overlapping box; records contact flags. */
function moveAxis(state: ParkourState, axis: 0 | 1 | 2, amount: number, boxes: readonly CollisionBox[], config: ParkourConfig, height: number): void {
  if (amount === 0) return;
  const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
  state.position[key] += amount;
  for (const candidate of boxes) {
    const body = playerBox(state.position, config.radius, height);
    if (!overlaps(body, candidate.box)) continue;
    if (axis === 1) {
      if (amount > 0) { state.position.y = candidate.box.min.y - height - 1e-4; state.contacts.ceiling = true; }
      else {
        state.position.y = candidate.box.max.y + 1e-4;
        state.grounded = true; state.groundId = candidate.id; state.groundSurface = candidate.surface;
        state.contacts.floor = true;
      }
      state.velocity.y = 0;
    } else {
      if (amount > 0) { state.position[key] = candidate.box.min[key] - config.radius - 1e-4; if (axis === 0) state.contacts.right = true; }
      else { state.position[key] = candidate.box.max[key] + config.radius + 1e-4; if (axis === 0) state.contacts.left = true; }
      state.velocity[key] = 0;
    }
  }
}

/** Convenience for hosts: is this scene a playable parkour course? */
export function hasParkour(scene: SceneDocument): boolean {
  return scene.entities.some(entity => enabledComponent(entity, 'player'));
}
