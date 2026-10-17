// Proves the shipped Sector 07 demo level is a real, completable course: the builder reads every
// mechanic out of the authored project, and the simulation clears each authored jump with only the
// movement vocabulary the player has. Runs against the exact checked-in fixture, headlessly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSectorFixture } from '../../test-fixtures/src/index.js';
import { validatePlayableScene } from '../src/runtime/validate.js';
import { buildParkourLevel, createInputState, createParkourState, stepParkour } from '../src/runtime/parkour.js';
import type { ParkourEvent, ParkourInputState } from '../src/runtime/parkour.js';

const fixture = createSectorFixture();
const scene = validatePlayableScene(fixture.scenes[0]!, { assets: fixture.assets.assets, prefabs: fixture.prefabs });
const level = buildParkourLevel(scene)!;
const STEP = 1 / 120;

/** Advances a fixed-step input schedule. */
function advance(state: ReturnType<typeof createParkourState>, seconds: number, input: (step: number) => Partial<ParkourInputState>, events: ParkourEvent[] = []): ParkourEvent[] {
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step++) {
    stepParkour(state, level, { ...createInputState(), ...input(step) }, STEP, events);
  }
  return events;
}

/** Launches the runner off a ledge at full tilt and reports where they came down. */
function leap(from: { z: number; y: number }, speed: number, doubleJumpAtStep: number | null): { landed: boolean; z: number; y: number; peak: number } {
  const state = createParkourState(level);
  state.position = { x: 0, y: from.y + 0.02, z: from.z };
  state.velocity = { x: 0, y: level.config.jumpVelocity, z: speed };
  state.grounded = false; state.jumps = 0;
  let peak = from.y;
  const steps = Math.round(4 / STEP);
  for (let step = 0; step < steps; step++) {
    const jump = doubleJumpAtStep !== null && step === doubleJumpAtStep;
    stepParkour(state, level, { ...createInputState(), moveZ: 1, sprint: true, jumpHeld: true, jump, cameraYaw: 0 }, STEP, []);
    peak = Math.max(peak, state.position.y);
    if (state.grounded && step > 4) break;
  }
  return { landed: state.grounded, z: state.position.z, y: state.position.y, peak };
}

test('the sector project builds a complete parkour course out of the authored scene', () => {
  assert.ok(level.solids.length >= 10, 'the course has a real rooftop network');
  assert.equal(level.platforms.length, 2, 'the relay ferry and the uplink lift');
  assert.equal(level.checkpoints.length, 4, 'a spawn gate and three relay gates');
  assert.equal(level.checkpoints.filter(checkpoint => checkpoint.spawn).length, 1);
  assert.equal(level.collectibles.length, 8, 'eight data shards');
  assert.equal(level.hazards.length, 3, 'three sentinel hazards');
  assert.ok(level.goal, 'the uplink goal exists');
  // The spawn checkpoint owns the spawn point, sitting on the entry rooftop.
  assert.deepEqual(level.spawn, { x: 0, y: 1, z: -4 });
  assert.equal(level.spawnFacing, 0);
  // Every trigger volume sits above a solid it can be reached from.
  for (const checkpoint of level.checkpoints) {
    const supported = level.solids.some(solid => Math.abs(solid.box.max.y - checkpoint.groundY) < 1e-6
      && checkpoint.center.x >= solid.box.min.x && checkpoint.center.x <= solid.box.max.x
      && checkpoint.center.z >= solid.box.min.z && checkpoint.center.z <= solid.box.max.z);
    assert.ok(supported, `checkpoint ${checkpoint.index} sits on a deck`);
  }
  for (const hazard of level.hazards) {
    assert.ok(hazard.box.max.y - hazard.box.min.y > 0.5, 'sentinels have body');
  }
});

test('every authored jump clears its gap with the run, jump and double-jump vocabulary', () => {
  const legs = [
    { name: 'entry rooftop to ferry rooftop', from: { z: 7.6, y: 1 }, to: { z: 12, y: 1 } },
    { name: 'ferry rooftop to switchback rooftop', from: { z: 21.6, y: 1 }, to: { z: 26.5, y: 1.6 } },
    { name: 'switchback rooftop to chasm launch', from: { z: 35.1, y: 1.6 }, to: { z: 40.5, y: 2.6 } },
    { name: 'the wall-run chasm', from: { z: 49.1, y: 2.6 }, to: { z: 62.5, y: 2.6 }, doubleJumpAtStep: 47 },
    { name: 'chasm launch up to the slide run', from: { z: 71.1, y: 2.6 }, to: { z: 73, y: 4.1 }, speed: 5 },
  ] as const;
  for (const leg of legs) {
    const speed = 'speed' in leg ? leg.speed : level.config.sprintSpeed;
    const result = leap(leg.from, speed, 'doubleJumpAtStep' in leg ? leg.doubleJumpAtStep : null);
    assert.equal(result.landed, true, `${leg.name}: the runner must land, not fall`);
    assert.ok(result.z >= leg.to.z - 0.7, `${leg.name}: landed at z=${result.z.toFixed(2)}, expected at least ${leg.to.z}`);
    assert.ok(Math.abs(result.y - leg.to.y) < 0.12, `${leg.name}: landed at y=${result.y.toFixed(2)}, expected ${leg.to.y}`);
  }
});

test('the slide gate blocks a standing runner and passes a sliding one', () => {
  const approach = (slide: boolean): ReturnType<typeof createParkourState> => {
    const state = createParkourState(level);
    // Settle onto the slide catwalk near its far end, then run for the low gate at z 84.
    state.position = { x: 0, y: 4.1, z: 74 };
    state.velocity = { x: 0, y: 0, z: level.config.sprintSpeed };
    advance(state, 3, () => ({ moveZ: 1, sprint: true, jumpHeld: true, slide: slide && state.position.z >= 79 && state.grounded }));
    return state;
  };
  const standing = approach(false);
  assert.ok(standing.position.z < 84, `a standing runner is stopped by the gate, got z=${standing.position.z.toFixed(2)}`);
  const sliding = approach(true);
  assert.ok(sliding.position.z > 85, `a sliding runner passes under the gate, got z=${sliding.position.z.toFixed(2)}`);
  assert.equal(sliding.deaths, 0);
});

test('the relay lift carries the runner up to the uplink and the goal ends the run', () => {
  const lift = level.platforms.find(platform => platform.waypoints[0]!.y === 3.6)!;
  const state = createParkourState(level);
  // Board at the lower stop, then simply hold forward: the terrace blocks until the lift tops out.
  state.position = { x: 0, y: 4.16, z: 99 };
  const events: ParkourEvent[] = [];
  const steps = Math.round(12 / STEP);
  for (let step = 0; step < steps && !state.finished; step++) {
    stepParkour(state, level, { ...createInputState(), moveZ: 1, sprint: true, jumpHeld: true }, STEP, events);
  }
  assert.ok(events.some(event => event.type === 'goal'), 'the run finishes at the uplink');
  assert.equal(state.finished, true);
  assert.equal(state.deaths, 0, 'the lift route is safe end to end');
  assert.ok(state.finishTime !== null && state.finishTime > 0);
  assert.ok(state.position.z > 105, 'the runner ends up on the uplink terrace');
  assert.ok(Math.abs(state.visual.roll) < 0.2);
  assert.ok(lift.half.x > 1, 'the lift deck is wide enough to stand on');
});

test('the sector simulation is deterministic', () => {
  const once = (): { position: { x: number; y: number; z: number }; events: number } => {
    const state = createParkourState(level);
    const events = advance(state, 6, step => ({ moveZ: 1, sprint: true, jumpHeld: true, jump: step % 45 === 0 }));
    return { position: state.position, events: events.length };
  };
  assert.deepEqual(once(), once());
});
