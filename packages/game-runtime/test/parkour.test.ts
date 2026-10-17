import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntity, createScene } from '@forgon/project-schema';
import type { Component, Entity, SceneDocument } from '@forgon/project-schema';
import {
  buildParkourLevel, createInputState, createParkourState, hasParkour, stepParkour,
} from '../src/runtime/parkour.js';
import type { ParkourEvent, ParkourInputState, Vec3 } from '../src/runtime/parkour.js';
import { autoYaw, cameraDef, cameraView, createCameraState, stepCamera } from '../src/runtime/camera-director.js';

let counter = 0;
function component(type: string, properties: Record<string, unknown>, entityRefs: string[] = []): Component {
  return { id: `c${counter++}`, type, enabled: true, properties: properties as Component['properties'], entityRefs, assetRefs: [] };
}
function entity(name: string, position: [number, number, number], scale: [number, number, number], components: Component[], parentId: string | null = null): Entity {
  const result = createEntity(name, parentId);
  result.transform.position = position; result.transform.scale = scale; result.components = components;
  return result;
}
const box = (color: number[], collider = true): Component[] => [
  component('render', { primitive: 'box', color }),
  ...(collider ? [component('collision', { shape: 'box', halfExtents: [0.5, 0.5, 0.5], isTrigger: false })] : []),
];

/** A flat rooftop with a shard, checkpoint, goal, hazard pit wall and a lift platform. */
function course(): { scene: SceneDocument; ids: Record<string, string> } {
  const scene = createScene('Course');
  const player = entity('Runner', [0, 0.2, 0], [0.7, 1.9, 0.7], [component('player', {}), ...box([1, 1, 1], false)]);
  player.components = player.components.filter(c => c.type === 'player');
  const floor = entity('Roof', [0, -0.5, 0], [60, 1, 60], box([0.2, 0.2, 0.22]));
  const checkpoint = entity('Gate', [6, 0, 0], [1, 3, 1], [
    component('render', { primitive: 'box', color: [1, 0.7, 0.3] }),
    component('checkpoint', { index: 1, radius: 1.4, offsetY: 1 }),
  ]);
  const shard = entity('Shard', [10, 1, 0], [0.4, 0.4, 0.4], [
    component('render', { primitive: 'box', color: [0.4, 0.9, 1] }),
    component('collectible', { value: 1, radius: 1.2, offsetY: 0.5 }),
  ]);
  const goal = entity('Exit', [20, 1, 0], [1, 2, 1], [
    component('render', { primitive: 'box', color: [0.3, 1, 0.5] }),
    component('goal', { radius: 2, offsetY: 1 }),
  ]);
  const hazard = entity('Plasma', [14, 0.5, 8], [4, 1, 4], [
    component('render', { primitive: 'box', color: [1, 0.2, 0.3] }),
    component('hazard', { kind: 'plasma', halfExtents: [0.5, 0.5, 0.5] }),
  ]);
  const liftPathA = entity('Lift A', [26, -1, 4], [1, 1, 1], []);
  const liftPathB = entity('Lift B', [26, 4, 4], [1, 1, 1], []);
  const lift = entity('Lift', [26, -1, 4], [4, 1, 4], [
    component('render', { primitive: 'box', color: [0.35, 0.4, 0.5] }),
    component('collision', { shape: 'box', halfExtents: [0.5, 0.5, 0.5], isTrigger: true }),
    component('movingPlatform', { waypoints: [liftPathA.id, liftPathB.id], speed: 3, mode: 'pingpong', wait: 0 }, [liftPathA.id, liftPathB.id]),
  ], liftPathA.id);
  const camera = entity('Camera', [0, 6, -10], [1, 1, 1], [component('camera', { fov: 55, nearClip: 0.1, farClip: 400, mode: 'follow', distance: 7, height: 2.2, lag: 8 })]);

  // The lift's parent is its first waypoint, so give the waypoints an identity parent.
  liftPathA.parentId = null; lift.parentId = null;
  scene.entities = [player, floor, checkpoint, shard, goal, hazard, liftPathA, liftPathB, lift, camera];
  return { scene, ids: { player: player.id, floor: floor.id, checkpoint: checkpoint.id, shard: shard.id, goal: goal.id, hazard: hazard.id, lift: lift.id, camera: camera.id } };
}

/** Steps a fixed 1/120 s. `jump`/`slide` are edge-triggered, so they only fire on the first step. */
function advance(state: ReturnType<typeof createParkourState>, level: NonNullable<ReturnType<typeof buildParkourLevel>>, seconds: number, input: Partial<ParkourInputState> = {}): ParkourEvent[] {
  const events: ParkourEvent[] = [];
  const steps = Math.round(seconds * 120);
  const held = { ...createInputState(), ...input };
  const rest: ParkourInputState = { ...held, jump: false, slide: false };
  for (let i = 0; i < steps; i++) {
    stepParkour(state, level, i === 0 ? held : rest, 1 / 120, events);
  }
  return events;
}

test('level building recognises a parkour course and its gameplay volumes', () => {
  const { scene, ids } = course();
  assert.equal(hasParkour(scene), true);
  const level = buildParkourLevel(scene)!;
  assert.equal(level.playerId, ids.player);
  assert.equal(level.solids.length, 1);
  assert.equal(level.checkpoints.length, 1);
  assert.equal(level.collectibles.length, 1);
  assert.equal(level.hazards.length, 1);
  assert.equal(level.platforms.length, 1);
  assert.equal(level.goal?.id, ids.goal);
  assert.equal(level.spawn.y, 0.2);
  assert.equal(hasParkour(createScene('Empty')), false);
});

test('gravity settles the runner on the roof and lands exactly once', () => {
  const { scene } = course();
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  const events = advance(state, level, 1);
  assert.equal(state.grounded, true);
  assert.ok(Math.abs(state.position.y) < 0.01, `expected roof height, got ${state.position.y}`);
  assert.ok(state.velocity.y === 0);
  assert.equal(events.filter(event => event.type === 'land').length, 1);
});

test('run, sprint, coyote jump and double jump all raise the runner', () => {
  const { scene } = course();
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  advance(state, level, 0.4);
  advance(state, level, 0.6, { moveZ: 1, sprint: true });
  assert.ok(state.speed > level.config.runSpeed, `sprint should exceed run speed, got ${state.speed}`);
  assert.ok(state.position.z > 3);
  const beforeY = state.position.y;
  const jumps = advance(state, level, 0.25, { moveZ: 1, jump: true, jumpHeld: true });
  assert.ok(state.position.y > beforeY + 1, 'a jump should clear more than a metre');
  assert.ok(jumps.some(event => event.type === 'jump' && !event.double));
  // A second press mid-air triggers the double jump.
  const doubleEvents = advance(state, level, 0.2, { jump: true });
  assert.ok(doubleEvents.some(event => event.type === 'jump' && event.double));
});

test('sliding lowers the collider and keeps momentum', () => {
  const { scene } = course();
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  advance(state, level, 0.4);
  advance(state, level, 1, { moveZ: 1, sprint: true });
  const events = advance(state, level, 0.1, { moveZ: 1, sprint: true, slide: true });
  assert.ok(events.some(event => event.type === 'slide'));
  assert.equal(state.sliding, true);
  advance(state, level, 0.3, { moveZ: 1 });
  assert.ok(state.visual.stance < 1, 'the runner should visibly crouch while sliding');
});

test('checkpoints arm respawns, shards collect once and the goal finishes the run', () => {
  const { scene, ids } = course();
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  state.position = { x: 6, y: 0.2, z: 0 };
  const checkpointEvents = advance(state, level, 0.2);
  assert.ok(checkpointEvents.some(event => event.type === 'checkpoint' && event.entityId === ids.checkpoint));
  assert.equal(state.checkpointIndex, 1);
  assert.deepEqual(state.respawn, { x: 6, y: 0, z: 0 });

  state.position = { x: 10, y: 0.2, z: 0 };
  const collectEvents = advance(state, level, 0.2);
  assert.equal(collectEvents.filter(event => event.type === 'collect').length, 1);
  advance(state, level, 0.2);
  assert.equal(state.collected.length, 1, 'shards cannot be collected twice');

  state.position = { x: 20, y: 0.2, z: 0 };
  const goalEvents = advance(state, level, 0.2);
  const goal = goalEvents.find(event => event.type === 'goal');
  assert.ok(goal && goal.type === 'goal');
  assert.equal(state.finished, true);
  assert.ok(state.finishTime !== null && state.finishTime! > 0);
  assert.equal(goal!.collected, 1);
});

test('hazards and long falls kill the runner and respawn at the last checkpoint', () => {
  const { scene, ids } = course();
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  state.position = { x: 6, y: 0.2, z: 0 };
  advance(state, level, 0.2);
  assert.equal(state.checkpointIndex, 1);

  state.position = { x: 14, y: 0.5, z: 8 };
  const hazardEvents = advance(state, level, 0.2);
  assert.ok(hazardEvents.some(event => event.type === 'death' && event.reason === 'hazard' && event.entityId === ids.hazard));
  assert.equal(state.deaths, 1);
  assert.ok(Math.abs(state.position.x - 6) < 0.2 && Math.abs(state.position.z) < 0.2, 'respawn returns to the checkpoint');

  state.invulnerable = 0;
  state.position = { x: 2, y: -60, z: 2 };
  const fallEvents = advance(state, level, 0.1);
  assert.ok(fallEvents.some(event => event.type === 'death' && event.reason === 'fall'));
  assert.equal(state.deaths, 2);
});

test('moving platforms carry the runner; trigger colliders keep the box sweep honest', () => {
  const { scene } = course();
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  state.position = { x: 26, y: 0.2, z: 4 };
  advance(state, level, 0.6);
  assert.equal(state.grounded, true);
  assert.equal(state.groundId, level.platforms[0]!.id);
  const platformY = state.platforms[0]!.position.y;
  assert.ok(platformY > -1, 'the lift should have started rising');
  assert.ok(state.position.y > -0.5, 'the runner rides the lift upward');
  advance(state, level, 0.4);
  assert.equal(state.riding, level.platforms[0]!.id);
  assert.ok(state.position.y > 0.2, 'carry continues while the lift climbs');
});

test('a wall run sticks to the wall, softens gravity and awards a wall jump', () => {
  const scene = createScene('Wall');
  const player = entity('Runner', [0.8, 3, 0], [1, 1, 1], [component('player', { wallRun: true })]);
  player.components = [component('player', { wallRun: true })];
  const wall = entity('Wall', [2, 3, 6], [1, 8, 40], box([0.3, 0.3, 0.35]));
  const floor = entity('Floor', [0, -0.5, 0], [40, 1, 40], box([0.2, 0.2, 0.2]));
  scene.entities = [player, wall, floor];
  const level = buildParkourLevel(scene)!;
  const state = createParkourState(level);
  state.velocity = { x: 3, y: 2, z: 6 };
  const events = advance(state, level, 0.4, { moveX: 1, moveZ: 1, cameraYaw: 0 });
  assert.ok(events.some(event => event.type === 'wall-run'), 'wall run should engage against the side wall');
  assert.ok(state.contacts.right || state.wall !== null);
  const wallJump = advance(state, level, 0.05, { jump: true });
  assert.ok(wallJump.some(event => event.type === 'wall-jump'), 'jump while wall running pushes off');
  // A burned-out run re-arms once its cooldown lapses and the runner touches a wall again.
  state.position = { x: 1.1, y: 6, z: 4 };
  state.velocity = { x: 3, y: 0, z: 6 };
  const chained = advance(state, level, 0.6, { moveX: 1, moveZ: 1, cameraYaw: 0 });
  assert.ok(chained.some(event => event.type === 'wall-run'), 'a burned-out run re-arms after its cooldown');
});

test('the camera follows the runner, widens with speed and aims past them', () => {
  const def = cameraDef({ mode: 'follow', distance: 8, height: 2, lag: 10, speedFov: 12, lookAhead: 0.3 });
  assert.equal(def.mode, 'follow');
  const state = createCameraState({ x: 0, y: 50, z: 0 }, { x: 0, y: 0, z: 0 }, 50);
  const still = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 240; i++) stepCamera(state, def, { position: still, velocity: { x: 0, y: 0, z: 0 }, headHeight: 1.8 }, { yaw: 0, pitch: 0.16, speed: 0, roll: 0, baseFov: 50 }, 1 / 60);
  assert.ok(Math.abs(state.position.z + 8 * Math.cos(0.16)) < 0.6, `camera should settle behind the runner, got z=${state.position.z}`);
  const idleFov = state.fov;
  for (let i = 0; i < 120; i++) stepCamera(state, def, { position: still, velocity: { x: 0, y: 0, z: 14 }, headHeight: 1.8 }, { yaw: 0, pitch: 0.16, speed: 14, roll: 0.3, baseFov: 50 }, 1 / 60);
  assert.ok(state.fov > idleFov + 5, 'field of view widens at speed');
  const view = cameraView(state);
  assert.ok(Math.abs(Math.abs(view.rotationEuler[1]) - 180) < 0.05, 'camera yaw faces the runner (its forward is -Z)');
  assert.ok(view.rotationEuler[0] < 0);
  // Auto assist turns the camera toward the runner's heading over time.
  const assisted = autoYaw(Math.PI / 2, 0, true, 1 / 60);
  assert.ok(assisted > 0 && assisted < Math.PI / 2);
  assert.equal(autoYaw(Math.PI / 2, 0, false, 1 / 60), 0);
});

test('the opening dolly starts on the authored pose and eases into the chase pose', () => {
  const def = cameraDef({ mode: 'follow', distance: 8, height: 2, lag: 10, intro: 2 });
  const state = createCameraState({ x: 0, y: 30, z: -40 }, { x: 0, y: 0, z: 0 }, 50);
  const player = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, headHeight: 1.8 };
  const control = { yaw: 0, pitch: 0.16, speed: 0, roll: 0, baseFov: 50 };
  stepCamera(state, def, player, control, 1 / 60);
  assert.deepEqual(state.position, { x: 0, y: 30, z: -40 }, 'the first frame holds the authored pose');
  for (let i = 0; i < 120; i++) stepCamera(state, def, player, control, 1 / 60);
  assert.ok(Math.abs(state.position.z + 8 * Math.cos(0.16)) < 0.05, 'the dolly lands on the chase pose');
});

test('simulation is deterministic for identical input', () => {
  const { scene } = course();
  const level = buildParkourLevel(scene)!;
  const run = (): Vec3 => {
    const state = createParkourState(level);
    advance(state, level, 2, { moveZ: 1, sprint: true });
    advance(state, level, 0.5, { moveZ: 1, jump: true, sprint: true });
    return state.position;
  };
  assert.deepEqual(run(), run());
});
