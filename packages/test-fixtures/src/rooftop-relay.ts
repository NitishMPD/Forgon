// Rooftop Relay: a five-course parkour campaign, generated deterministically from one seed.
//
// Every course is an ordinary Forgon scene built from the primitive vocabulary the runtime
// actually renders. The campaign document sequences them, gives them medal targets and unlocks
// them in order. Geometry is designed as a linear route along +Z so a headless simulation can
// prove each authored gap is clearable with the shipped movement vocabulary.

import { parseScene, validateProject } from '@forgon/project-schema';
import type {
  AssetRegistry, CampaignDocument, Component, Entity, JsonValue, PrefabDocument, ProjectManifest, SceneDocument,
} from '@forgon/project-schema';
import { instantiatePrefab, SceneAuthor } from '@forgon/procedural-authoring';
import type { AuthoringArtifact, PrefabBindings } from '@forgon/procedural-authoring';
import type { ProjectFixture } from './index.js';

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export type Vec3Tuple = [number, number, number];

export function component(author: SceneAuthor, key: string, type: string, properties: Record<string, JsonValue>, entityRefs: string[] = [], assetRefs: string[] = []): Component {
  return { id: author.id(`component:${key}`), type, enabled: true, properties, entityRefs, assetRefs };
}
export function box(author: SceneAuthor, key: string, name: string, position: Vec3Tuple, scale: Vec3Tuple, color: number[], parentId: string | null, collider = true): Entity {
  const entity = author.entity(key, name, parentId);
  entity.transform.position = position; entity.transform.scale = scale;
  entity.components.push(component(author, `${key}:render`, 'render', { primitive: 'box', color, castShadows: true }));
  if (collider) entity.components.push(component(author, `${key}:collision`, 'collision', { shape: 'box', halfExtents: [0.5, 0.5, 0.5], isTrigger: false }));
  return entity;
}

/** Vivid neon for a hue in 0..1, matching the Sector art direction. */
export function neon(hue: number): number[] {
  const position = (((hue % 1) + 1) % 1) * 6;
  const index = Math.floor(position); const fraction = position - index;
  const x = 1 - Math.abs((fraction % 2) - 1);
  const sectors: [number, number, number][] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]];
  const [r, g, b] = sectors[index % 6]!;
  return [0.16 + r * 0.8, 0.16 + g * 0.8, 0.2 + b * 0.8];
}
export function hex(rgb: readonly number[]): string {
  return `#${rgb.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Seamless four-second ambient pad: every partial completes a whole number of cycles. */
export function relayLoopWav(): Uint8Array {
  const rate = 22050; const seconds = 4; const count = rate * seconds;
  const bytes = new Uint8Array(44 + count * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const time = i / rate;
    const tremolo = 0.72 + 0.28 * Math.sin(2 * Math.PI * time / seconds);
    const drone = Math.sin(2 * Math.PI * 110 * time) * 0.55 + Math.sin(2 * Math.PI * 165 * time) * 0.3;
    const air = Math.sin(2 * Math.PI * 220 * time) * 0.12 * Math.sin(2 * Math.PI * 0.5 * time);
    view.setInt16(44 + i * 2, Math.round((drone + air) * tremolo * 1500), true);
  }
  return bytes;
}
/** Rising two-note finish cue, 0.6s. */
export function relayChimeWav(): Uint8Array {
  const rate = 22050; const count = Math.round(rate * 0.6);
  const bytes = new Uint8Array(44 + count * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const time = i / rate; const second = time >= 0.22;
    const frequency = second ? 880 : 587.33;
    const local = second ? time - 0.22 : time;
    const envelope = Math.min(1, local / 0.01) * Math.exp(-local * (second ? 4.2 : 7));
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * time) * envelope * 2900), true);
  }
  return bytes;
}

export interface Palette {
  accent: number[]; warm: number[]; danger: number[]; shard: number[]; goal: number[]; gate: number[];
  ink: number[]; deck: number[]; surface: number[]; wall: number[]; sky: number[];
}
export interface LiftKit { prefab: PrefabDocument; bindings: PrefabBindings }

export function liftKit(seed: string, palette: Palette, namespace: string): LiftKit {
  const author = new SceneAuthor(namespace, seed);
  const deck = box(author, 'deck', 'Relay ferry deck', [0, 0, 0], [5, 1, 5], [...palette.deck], null);
  deck.components.find(item => item.type === 'collision')!.properties.isTrigger = true;
  const anchor = author.entity('anchor', 'Relay ferry station', deck.id);
  const rail = box(author, 'rail', 'Relay ferry rim', [0, -0.62, 0], [4.6, 0.14, 4.6], [...palette.accent], deck.id, false);
  const motion = component(author, 'deck:motion', 'movingPlatform', { waypoints: [anchor.id], speed: 2.8, mode: 'pingpong', wait: 1.2 }, [anchor.id]);
  deck.components.push(motion);
  const prefab: PrefabDocument = { schemaVersion: 1, prefabId: author.id('prefab'), name: 'Original relay ferry', rootId: deck.id, entities: [deck, anchor, rail] };
  const bindings: PrefabBindings = { formatVersion: 1, prefabId: prefab.prefabId, references: [
    { componentId: motion.id, path: ['waypoints', 0], kind: 'entity' },
  ] };
  return { prefab, bindings };
}

export interface DeckInfo { startZ: number; endZ: number; surfaceY: number; width: number; centerZ: number }

/** Builds one linear rooftop route: decks advance along +Z, so every gap is provable headlessly. */
export class CourseBuilder {
  readonly entities: Entity[] = [];
  readonly root: Entity;
  surfaceY = 1;
  cursorZ = -6;
  private decks = 0;
  private stops = 0;
  constructor(readonly author: SceneAuthor, readonly prefix: string, title: string, readonly palette: Palette, readonly kit: LiftKit) {
    this.root = author.entity(`${prefix}:root`, title);
    this.entities.push(this.root);
  }
  private key(suffix: string): string { return `${this.prefix}:${suffix}`; }
  private add(key: string, name: string, position: Vec3Tuple, scale: Vec3Tuple, color: readonly number[], solid = true, parentId = this.root.id): Entity {
    const entity = box(this.author, key, name, position, scale, [...color], parentId, solid);
    this.entities.push(entity); return entity;
  }
  marker(key: string, name: string, position: Vec3Tuple): Entity {
    const entity = this.author.entity(this.key(key), name, this.root.id);
    entity.transform.position = position; this.entities.push(entity); return entity;
  }
  deck(name: string, options: { width: number; depth: number; gap?: number; rise?: number; tint?: number[] }): DeckInfo {
    const gap = options.gap ?? 0; const rise = options.rise ?? 0;
    const startZ = this.cursorZ + gap;
    const surfaceY = this.surfaceY + rise;
    this.surfaceY = surfaceY;
    const centerZ = startZ + options.depth / 2;
    const key = this.key(`deck:${++this.decks}`);
    this.add(key, name, [0, surfaceY - 1, centerZ], [options.width, 2, options.depth], options.tint ?? this.palette.deck);
    this.add(`${key}:surface`, `${name} surface`, [0, surfaceY + 0.045, centerZ], [options.width * 0.98, 0.09, options.depth * 0.98], this.palette.surface, false);
    this.add(`${key}:lip`, `${name} entry lip`, [0, surfaceY + 0.06, startZ + 0.24], [options.width * 0.96, 0.08, 0.3], this.palette.accent, false);
    this.add(`${key}:lip:exit`, `${name} exit lip`, [0, surfaceY + 0.06, startZ + options.depth - 0.24], [options.width * 0.96, 0.08, 0.3], this.palette.warm, false);
    this.cursorZ = centerZ + options.depth / 2;
    return { startZ, endZ: this.cursorZ, surfaceY, width: options.width, centerZ };
  }
  gate(z: number, index: number, spawn = false): Entity {
    const key = this.key(`gate:${index}`);
    const gate = this.author.entity(key, spawn ? 'Relay gate' : `Relay gate ${index}`, this.root.id);
    gate.transform.position = [0, this.surfaceY, z];
    gate.transform.scale = [0.7, 0.14, 0.7];
    gate.components.push(component(this.author, `${key}:render`, 'render', { primitive: 'box', color: this.palette.gate, castShadows: false }));
    gate.components.push(component(this.author, `${key}:checkpoint`, 'checkpoint', {
      index, radius: 1.9, offsetY: 1.3, ...(spawn ? { spawn: true } : {}),
    }));
    this.entities.push(gate);
    for (const side of [-1, 1]) this.add(`${key}:post:${side}`, 'Relay gate post', [side * 1.6, this.surfaceY + 1.45, z], [0.26, 2.9, 0.26], this.palette.gate, false);
    return gate;
  }
  shardAt(x: number, y: number, z: number): Entity {
    const key = this.key(`shard:${++this.stops}`);
    const shard = this.author.entity(key, 'Data shard', this.root.id);
    shard.transform.position = [x, y, z]; shard.transform.rotationEuler = [45, 0, 45]; shard.transform.scale = [0.55, 0.55, 0.55];
    shard.components.push(component(this.author, `${key}:render`, 'render', { primitive: 'box', color: this.palette.shard, castShadows: false }));
    shard.components.push(component(this.author, `${key}:collectible`, 'collectible', { value: 1, radius: 1.25, offsetY: 0 }));
    this.entities.push(shard); return shard;
  }
  shard(z: number, height = 1.4, x = 0): Entity { return this.shardAt(x, this.surfaceY + height, z); }
  hazard(x: number, z: number): void {
    const key = this.key(`sentinel:${++this.stops}`);
    const pylon = this.add(key, 'Sentinel pylon', [x, this.surfaceY + 0.75, z], [2, 1.5, 1.5], this.palette.ink);
    pylon.components.push(component(this.author, `${key}:hazard`, 'hazard', { kind: 'plasma', halfExtents: [0.5, 0.5, 0.5] }));
    this.add(`${key}:core`, 'Sentinel core', [x, this.surfaceY + 0.75, z + 0.78], [1.2, 0.9, 0.3], this.palette.danger, false);
  }
  /** A full-width low bar that stops a standing runner and passes a sliding one. */
  slideGate(z: number, width: number): void {
    const key = this.key(`slide-gate:${++this.stops}`);
    this.add(key, 'Slide gate', [0, this.surfaceY + 1.6, z], [width + 0.4, 1.2, 0.7], this.palette.danger);
    this.add(`${key}:light`, 'Slide gate light', [0, this.surfaceY + 2.24, z], [width + 0.4, 0.1, 0.7], this.palette.warm, false);
  }
  /** Two flanking faces tall enough to wall-run, framing an otherwise bottomless gap. */
  walls(zStart: number, length: number, width: number): void {
    for (const side of [-1, 1]) {
      const x = side * (width / 2 + 0.8);
      this.add(this.key(`wall:${side}:${++this.stops}`), 'Chasm wall', [x, this.surfaceY + 5, zStart + length / 2], [1.2, 10, length + 6], this.palette.wall);
      this.add(this.key(`wall:${side}:light:${this.stops}`), 'Chasm light line', [x - side * 0.64, this.surfaceY + 0.4, zStart + length / 2], [0.1, 0.28, length + 5.4], this.palette.accent, false);
    }
  }
  private ride(key: string, from: Entity, to: Entity, speed: number, wait: number): Entity {
    const instance = instantiatePrefab(this.kit.prefab, this.author.id(key), this.kit.bindings, this.root.id);
    this.entities.push(...instance.entities);
    const platform = instance.entities.find(entity => entity.prefab!.sourceEntityId === this.kit.prefab.rootId)!;
    platform.name = 'Relay ferry';
    platform.transform.position = [...from.transform.position] as Vec3Tuple;
    const motion = platform.components.find(item => item.type === 'movingPlatform')!;
    motion.properties.waypoints = [from.id, to.id];
    motion.properties.speed = speed; motion.properties.wait = wait;
    motion.entityRefs = [from.id, to.id];
    return platform;
  }
  /** Horizontal ferry across a gap the runner cannot jump. */
  ferry(zFrom: number, zTo: number): void {
    const key = this.key(`lift:${++this.stops}`);
    const from = this.marker(`${key}:a`, 'Ferry stop lower', [0, this.surfaceY - 0.5, zFrom]);
    const to = this.marker(`${key}:b`, 'Ferry stop upper', [0, this.surfaceY - 0.5, zTo]);
    this.ride(key, from, to, 3.2, 1.1);
  }
  /** Vertical lift from the current deck surface to a target surface. */
  lift(z: number, toSurfaceY: number): void {
    const key = this.key(`lift:${++this.stops}`);
    const from = this.marker(`${key}:a`, 'Lift stop lower', [0, this.surfaceY - 0.5, z]);
    const to = this.marker(`${key}:b`, 'Lift stop upper', [0, toSurfaceY - 0.5, z]);
    this.ride(key, from, to, 2.3, 1.3);
  }
  goal(z: number): Entity {
    const key = this.key('goal');
    const goal = this.author.entity(key, 'Uplink', this.root.id);
    goal.transform.position = [0, this.surfaceY + 1.5, z]; goal.transform.scale = [4, 3.2, 0.6];
    goal.components.push(component(this.author, `${key}:render`, 'render', { primitive: 'box', color: this.palette.goal, castShadows: false }));
    goal.components.push(component(this.author, `${key}:goal`, 'goal', { radius: 2.6, offsetY: -0.7 }));
    this.entities.push(goal); return goal;
  }
}

interface CourseSpec {
  key: string; title: string; name: string; subtitle: string;
  gold: number; silver: number; bronze: number;
  build(course: CourseBuilder): { spawn: Entity; goal: Entity };
}

function stage(course: CourseBuilder, title: string): void {
  const { author, palette } = course;
  const player = author.entity(`${course.prefix}:player`, 'Runner', course.root.id);
  player.transform.position = [0, 1.06, -4];
  player.components.push(component(author, `${course.prefix}:player`, 'player', {
    runSpeed: 7.6, sprintSpeed: 12.4, gravity: 27, jumpVelocity: 10.5, doubleJumpVelocity: 9.2, maxJumps: 2,
    coyoteTime: 0.13, jumpBuffer: 0.16, wallRun: true, wallRunTime: 1.5, wallRunSpeed: 13,
    wallJumpUp: 10, wallJumpOut: 8, slide: true, slideTime: 0.75, slideHeight: 0.85,
    radius: 0.42, height: 1.85, fallLimit: -34, invulnerable: 0.6,
  }));
  course.entities.push(player);
  const rig: [string, string, Vec3Tuple, Vec3Tuple, number[]][] = [
    ['torso', 'Torso', [0, 1.02, 0], [0.62, 0.72, 0.36], palette.ink],
    ['head', 'Head', [0, 1.6, 0], [0.34, 0.32, 0.34], palette.ink],
    ['arm:left', 'Left arm', [-0.44, 1.18, 0], [0.16, 0.62, 0.16], palette.ink],
    ['arm:right', 'Right arm', [0.44, 1.18, 0], [0.16, 0.62, 0.16], palette.ink],
    ['leg:left', 'Left leg', [-0.18, 0.48, 0], [0.22, 0.9, 0.22], palette.ink],
    ['leg:right', 'Right leg', [0.18, 0.48, 0], [0.22, 0.9, 0.22], palette.ink],
  ];
  for (const [key, name, position, scale, tint] of rig) {
    const part = author.entity(`${course.prefix}:rig:${key}`, name, player.id);
    part.transform.position = position; part.transform.scale = scale;
    part.components.push(component(author, `${course.prefix}:rig:${key}:render`, 'render', { primitive: 'box', color: [...tint], castShadows: true }));
    course.entities.push(part);
  }
  const camera = author.entity(`${course.prefix}:camera`, `${title} camera`);
  camera.transform.position = [0, 7.5, -14]; camera.transform.rotationEuler = [-17, 0, 0];
  camera.components.push(component(author, `${course.prefix}:camera`, 'camera', {
    fov: 62, nearClip: 0.1, farClip: 600, clearColor: [...palette.sky],
    mode: 'follow', distance: 8.2, height: 2, lag: 6.5, intro: 2.6, speedFov: 14, lookAhead: 0.3,
  }));
  course.entities.push(camera);
  const sun = author.entity(`${course.prefix}:sun`, 'High sun'); sun.transform.rotationEuler = [-54, 34, 0];
  sun.components.push(component(author, `${course.prefix}:sun`, 'light', { kind: 'directional', color: [1, 0.97, 0.92], intensity: 3.6, castShadows: true, range: 120 }));
  course.entities.push(sun);
  const rim = author.entity(`${course.prefix}:rim`, 'Sky fill'); rim.transform.rotationEuler = [58, -140, 0];
  rim.components.push(component(author, `${course.prefix}:rim`, 'light', { kind: 'directional', color: [0.68, 0.8, 1], intensity: 1.35, castShadows: false, range: 120 }));
  course.entities.push(rim);
  const fill = author.entity(`${course.prefix}:fill`, 'Route fill'); fill.transform.position = [0, 8, 30];
  fill.components.push(component(author, `${course.prefix}:fill`, 'light', { kind: 'omni', color: [...palette.accent], intensity: 8, castShadows: false, range: 42 }));
  course.entities.push(fill);
}

const COURSES: CourseSpec[] = [
  {
    key: 'one', title: 'First Drop', name: 'First Drop', subtitle: 'Five easy gaps to learn the jump', gold: 26, silver: 36, bronze: 50,
    build(course) {
      const a = course.deck('Entry rooftop', { width: 12, depth: 16 });
      const spawn = course.gate(-4, 0, true);
      const b = course.deck('Ferry rooftop', { width: 9, depth: 10, gap: 4.5 });
      const c = course.deck('Switchback', { width: 9, depth: 10, gap: 4.5, rise: 0.8 });
      course.gate(c.startZ + 1.5, 1);
      course.shard(c.startZ + 4.8, 1.5);
      const d = course.deck('Drop deck', { width: 8, depth: 8, gap: 4, rise: -0.6 });
      const e = course.deck('Uplink terrace', { width: 10, depth: 14, gap: 5, rise: 0.8 });
      course.gate(e.startZ + 1.5, 2);
      course.shard(a.endZ + 2.25, 1.5);
      course.shard(b.endZ + 2.25, 1.6);
      course.shard(c.endZ + 2, 1.5);
      course.shard(d.endZ + 2.5, 1.5);
      const goal = course.goal(e.endZ - 3);
      return { spawn, goal };
    },
  },
  {
    key: 'two', title: 'Ferry Line', name: 'Ferry Line', subtitle: 'Ride the relay ferry over open air', gold: 34, silver: 46, bronze: 62,
    build(course) {
      course.deck('Entry rooftop', { width: 12, depth: 16 });
      const spawn = course.gate(-4, 0, true);
      const b = course.deck('Ferry rooftop', { width: 9, depth: 10, gap: 4.5 });
      course.shard(b.startZ + 5, 1.4);
      const c = course.deck('Chasm launch', { width: 8, depth: 10, gap: 4.5, rise: 0.6 });
      course.gate(c.startZ + 1.5, 1);
      const ferryFrom = c.endZ + 1;
      const ferryTo = ferryFrom + 12;
      course.ferry(ferryFrom, ferryTo);
      course.shard(ferryFrom + 6, 2.2);
      course.shard(ferryTo + 5, 1.5);
      const d = course.deck('Landing deck', { width: 10, depth: 12, gap: 14 });
      course.hazard(2.4, d.centerZ);
      course.gate(d.startZ + 1.5, 2);
      const e = course.deck('Switchback', { width: 9, depth: 10, gap: 4.5, rise: 0.8 });
      course.shard(e.startZ + 5, 1.4);
      const f = course.deck('Uplink terrace', { width: 10, depth: 14, gap: 5, rise: 0.4 });
      const goal = course.goal(f.endZ - 3);
      return { spawn, goal };
    },
  },
  {
    key: 'three', title: 'Wall Run', name: 'Wall Run', subtitle: 'Thirteen metres of chasm, no floor', gold: 38, silver: 52, bronze: 70,
    build(course) {
      course.deck('Entry rooftop', { width: 10, depth: 14 });
      const spawn = course.gate(-4, 0, true);
      const b = course.deck('Launch roof', { width: 8, depth: 8, gap: 4.5, rise: 0.5 });
      course.shard(b.startZ + 4, 1.4);
      const c = course.deck('Chasm launch', { width: 8, depth: 8, gap: 5, rise: 0.5 });
      course.gate(c.startZ + 1.5, 1);
      course.hazard(-2.2, c.centerZ);
      course.walls(c.endZ, 13, 8);
      const d = course.deck('Chasm landing', { width: 10, depth: 10, gap: 13 });
      course.gate(d.startZ + 1.5, 2);
      course.shard(d.startZ + 5, 1.4);
      course.hazard(2.4, d.centerZ + 1.6);
      const e = course.deck('Switchback', { width: 8, depth: 8, gap: 4.5, rise: 0.8 });
      course.gate(e.startZ + 1.5, 3);
      course.shard(e.startZ + 4, 1.4);
      const f = course.deck('Uplink terrace', { width: 10, depth: 14, gap: 5, rise: -0.4 });
      course.shard(f.startZ + 7, 1.5);
      const goal = course.goal(f.endZ - 3);
      return { spawn, goal };
    },
  },
  {
    key: 'four', title: 'Low Clearance', name: 'Low Clearance', subtitle: 'Two slide gates on one long catwalk', gold: 36, silver: 50, bronze: 68,
    build(course) {
      course.deck('Entry rooftop', { width: 10, depth: 12 });
      const spawn = course.gate(-4, 0, true);
      const b = course.deck('Service catwalk', { width: 7, depth: 26, gap: 3 });
      course.shard(b.startZ + 5, 1.4);
      course.slideGate(b.startZ + 9, 7);
      course.shard(b.startZ + 12, 1.2);
      course.slideGate(b.startZ + 19, 7);
      course.hazard(-2.3, b.startZ + 15.5);
      course.shard(b.startZ + 22, 1.4);
      course.gate(b.endZ - 1.5, 1);
      const c = course.deck('Switchback', { width: 8, depth: 10, gap: 4, rise: 0.6 });
      course.shard(c.startZ + 5, 1.4);
      course.gate(c.startZ + 1.5, 2);
      const d = course.deck('Uplink terrace', { width: 10, depth: 14, gap: 4.5, rise: 0.6 });
      course.shard(d.startZ + 7, 1.5);
      const goal = course.goal(d.endZ - 3);
      return { spawn, goal };
    },
  },
  {
    key: 'five', title: 'Uplink', name: 'Uplink', subtitle: 'Ferry, chasm, slide and lift in one run', gold: 54, silver: 72, bronze: 95,
    build(course) {
      course.deck('Entry rooftop', { width: 12, depth: 14 });
      const spawn = course.gate(-4, 0, true);
      const b = course.deck('Ferry rooftop', { width: 9, depth: 10, gap: 4.5 });
      course.shard(b.startZ + 5, 1.4);
      const ferryFrom = b.endZ + 1;
      const ferryTo = ferryFrom + 11;
      course.ferry(ferryFrom, ferryTo);
      course.shard(ferryFrom + 5.5, 2.2);
      const c = course.deck('Chasm launch', { width: 9, depth: 12, gap: 12 });
      course.gate(c.startZ + 1.5, 1);
      course.shard(c.startZ + 6, 1.4);
      const d = course.deck('Wall launch', { width: 8, depth: 8, gap: 4.5, rise: 0.8 });
      course.hazard(2.2, d.centerZ);
      course.walls(d.endZ, 13, 8);
      const e = course.deck('Chasm landing', { width: 10, depth: 10, gap: 13 });
      course.gate(e.startZ + 1.5, 2);
      course.shard(e.startZ + 5, 1.4);
      const f = course.deck('Service catwalk', { width: 7, depth: 20, gap: 3.5 });
      course.slideGate(f.startZ + 8, 7);
      course.shard(f.startZ + 4, 1.4);
      course.shard(f.startZ + 14, 1.4);
      course.hazard(-2.3, f.centerZ);
      const base = course.deck('Lift base', { width: 8, depth: 5, gap: 3 });
      course.gate(base.startZ + 1, 3);
      const upper = base.surfaceY + 3.4;
      course.lift(base.endZ + 2.5, upper);
      const g = course.deck('Uplink terrace', { width: 10, depth: 12, gap: 5, rise: 3.4 });
      course.shard(g.startZ + 6, 1.5);
      const goal = course.goal(g.endZ - 3);
      return { spawn, goal };
    },
  },
];

function paletteFor(index: number, jitter = 0.5): Palette {
  const hues = [0.08, 0.52, 0.78, 0.13, 0.6];
  const skies: number[][] = [
    [0.86, 0.9, 0.95], [0.8, 0.88, 0.96], [0.78, 0.84, 0.94], [0.9, 0.85, 0.79], [0.82, 0.86, 0.92],
  ];
  const hue = (hues[index]! + (jitter - 0.5) * 0.06 + 1) % 1;
  return {
    accent: neon(hue), warm: [1, 0.74, 0.26], danger: [1, 0.16, 0.22],
    shard: [0.42, 0.93, 1], goal: [1, 0.79, 0.32], gate: [1, 0.72, 0.3],
    ink: [0.05, 0.055, 0.075], deck: [0.09, 0.1, 0.13], surface: [1, 1, 1],
    wall: [0.72, 0.78, 0.86], sky: skies[index]!,
  };
}

function finishCampaign(author: SceneAuthor, name: string, scenes: SceneDocument[], prefabs: PrefabDocument[], assets: AssetRegistry, campaign: CampaignDocument, extra: Record<string, string | Uint8Array>, bindings: { path: string; bindings: PrefabBindings }[]): ProjectFixture {
  const manifest: ProjectManifest = {
    schemaVersion: 1, projectId: author.id('project'), name, startScene: scenes[0]!.sceneId,
    scenes: scenes.map((scene, index) => ({ id: scene.sceneId, path: `scenes/course-0${index + 1}.scene.json` })),
    prefabs: prefabs.map(prefab => ({ id: prefab.prefabId, path: `prefabs/${prefab.prefabId}.prefab.json` })),
    assetRegistry: 'assets/registry.json', campaign: 'progression/campaign.json',
  };
  const authoring: AuthoringArtifact = {
    formatVersion: 1, generator: { id: author.namespace, version: '1.0.0', seed: author.seed },
    base: scenes[0]!, overrides: [], detached: [], prefabBindings: bindings.map(item => ({ prefabId: item.bindings.prefabId, path: item.path })),
  };
  validateProject({ manifest, scenes, prefabs, assets, campaign });
  const files: Record<string, string | Uint8Array> = {
    ...extra, 'game.project.json': json(manifest), 'assets/registry.json': json(assets),
    'authoring/generated.json': json(authoring), 'progression/campaign.json': json(campaign),
  };
  for (const [index, scene] of scenes.entries()) files[manifest.scenes[index]!.path] = json(scene);
  for (const [index, prefab] of prefabs.entries()) files[manifest.prefabs[index]!.path] = json(prefab);
  for (const item of bindings) files[item.path] = json(item.bindings);
  return { manifest, scenes, prefabs, assets, authoring, campaign, files };
}

/** Five-course campaign fixture: deterministic, project-valid and byte-stable from one seed. */
export function createRooftopRelayFixture(seed = 'forgon'): ProjectFixture {
  const author = new SceneAuthor('rooftop-relay', seed);
  const loopId = author.id('asset:relay-loop');
  const chimeId = author.id('asset:relay-chime');
  const scenes: SceneDocument[] = [];
  const courses: CampaignDocument['courses'] = [];
  const kits: LiftKit[] = [];
  COURSES.forEach((spec, index) => {
    const prefix = `c${index + 1}`;
    const palette = paletteFor(index, author.random(`accent:${prefix}`));
    const kit = liftKit(seed, palette, `rooftop-lift-${prefix}`);
    kits.push(kit);
    const builder = new CourseBuilder(author, prefix, spec.title, palette, kit);
    stage(builder, spec.title);
    const { spawn, goal } = spec.build(builder);
    spawn.components.push(component(author, `${prefix}:ambient`, 'audio', { assetId: loopId, autoplay: true, loop: true, volume: 0.16, on: 'any' }, [], [loopId]));
    const cue = author.entity(`${prefix}:cue`, 'Relay checkpoint cue', builder.root.id);
    cue.components.push(component(author, `${prefix}:gate-cue`, 'audio', { assetId: chimeId, autoplay: false, loop: false, volume: 0.18, on: 'checkpoint' }, [], [chimeId]));
    builder.entities.push(cue);
    goal.components.push(component(author, `${prefix}:goal-cue`, 'audio', { assetId: chimeId, autoplay: false, loop: false, volume: 0.55, on: 'goal' }, [], [chimeId]));
    const sceneId = author.id(`scene:${prefix}`);
    const scene = parseScene({ schemaVersion: 1, sceneId, name: spec.name, entities: builder.entities });
    scenes.push(scene);
    courses.push({ sceneId, name: spec.name, subtitle: spec.subtitle, goldSeconds: spec.gold, silverSeconds: spec.silver, bronzeSeconds: spec.bronze });
  });
  const campaign: CampaignDocument = {
    schemaVersion: 1, campaignId: author.id('campaign'), title: 'Rooftop Relay',
    tagline: 'Five rooftop routes. One relay. Beat the clock, bank a medal, unlock the next drop.',
    unlock: 'sequential',
    credits: 'A Forgon Engine sample production. Original primitive level design and synthesized audio created for this repository.',
    courses,
  };
  const assets: AssetRegistry = { schemaVersion: 1, assets: [
    { id: loopId, name: 'Relay ambient loop', kind: 'audio', path: 'assets/relay-loop.wav', provenance: { source: 'Original synthesized ambient loop; created for this repository', license: 'CC0-1.0', generator: 'forgon-rooftop-relay-1.0.0' } },
    { id: chimeId, name: 'Relay finish chime', kind: 'audio', path: 'assets/relay-chime.wav', provenance: { source: 'Original synthesized rise cue; created for this repository', license: 'CC0-1.0', generator: 'forgon-rooftop-relay-1.0.0' } },
    { id: author.id('asset:mark'), name: 'Rooftop Relay wordmark source', kind: 'texture', path: 'assets/rooftop-relay.svg', provenance: { source: 'Original mark; created for this repository', license: 'CC0-1.0' } },
    { id: author.id('asset:palette'), name: 'Rooftop Relay palette', kind: 'material', path: 'assets/palette.json', provenance: { source: 'Original palette; created for this repository', license: 'CC0-1.0' } },
  ] };
  return finishCampaign(author, 'Rooftop Relay', scenes, kits.map(item => item.prefab), assets, campaign, {
    'assets/relay-loop.wav': relayLoopWav(),
    'assets/relay-chime.wav': relayChimeWav(),
    'assets/rooftop-relay.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="128" viewBox="0 0 512 128"><rect width="512" height="128" fill="#dfe8f2"/><path d="M42 88h60V40h44v48h34" fill="none" stroke="${hex(neon((0.08 + (author.random('accent:c1') - 0.5) * 0.06 + 1) % 1))}" stroke-width="8"/><text x="200" y="78" font-family="sans-serif" font-size="34" letter-spacing="5" fill="#12151c">ROOFTOP RELAY</text></svg>\n`,
    'assets/palette.json': json({ ink: hex([0.05, 0.055, 0.075]), deck: hex([0.09, 0.1, 0.13]), surface: '#ebf0f6', wall: hex([0.72, 0.78, 0.86]), accents: [0, 1, 2, 3, 4].map(index => hex(neon(([0.08, 0.52, 0.78, 0.13, 0.6][index]! + (author.random(`accent:c${index + 1}`) - 0.5) * 0.06 + 1) % 1))) }),
    'assets/PROVENANCE.md': '# Original placeholder assets\nAuthor: Nitish\n\nAll Rooftop Relay geometry is authored as original primitives in the five course scenes. The relay ferry prefab, the wordmark SVG, the palette and both WAV cues were created for this repository, with no imported third-party artwork, audio or level data. These assets are dedicated under CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). The SVG uses a platform sans-serif font; no font file is distributed. Registry entries identify provenance. Assets are source documents: the runtime renders inline primitive colours and synthesized audio only, and does not claim texture import support.\n',
  }, kits.map((item, index) => ({ path: `authoring/relay-ferry-0${index + 1}.bindings.json`, bindings: item.bindings })));
}
