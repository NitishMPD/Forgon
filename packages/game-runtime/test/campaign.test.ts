// Proves Rooftop Relay is a complete campaign, not five decorative scenes: every authored gap is
// cleared by the shipped simulation, every ferry and lift carries a rider, both slide gates stop a
// standing runner and pass a sliding one, and the unlock/save model behaves like a real game.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRooftopRelayFixture } from '../../test-fixtures/src/index.js';
import { validatePlayableScene } from '../src/runtime/validate.js';
import { buildParkourLevel, createInputState, createParkourState, stepParkour } from '../src/runtime/parkour.js';
import type { ParkourEvent, ParkourInputState, ParkourLevel, ParkourState } from '../src/runtime/parkour.js';
import type { Entity, SceneDocument } from '@forgon/project-schema';
import {
  createMemoryStorage, createProgress, isCourseUnlocked, loadProgress, medalFor, migrateProgress,
  persistProgress, recordRun, saveKey, DEFAULT_SETTINGS, formatSeconds,
} from '../src/game/campaign.js';

const fixture = createRooftopRelayFixture();
const context = { assets: fixture.assets.assets, prefabs: fixture.prefabs };
const STEP = 1 / 120;
const campaign = fixture.campaign!;
const courseScenes = campaign.courses.map(course => {
  const scene = fixture.scenes.find(candidate => candidate.sceneId === course.sceneId);
  assert.ok(scene, `course ${course.name} has a registered scene`);
  return scene;
});
const levels = courseScenes.map(scene => {
  const level = buildParkourLevel(validatePlayableScene(scene, context));
  assert.ok(level, 'every course is a parkour level');
  return level;
});

interface Deck { id: string; startZ: number; endZ: number; top: number; width: number }
function decksOf(scene: SceneDocument): Deck[] {
  return scene.entities
    .filter(entity => {
      const collision = entity.components.find(component => component.type === 'collision' && component.enabled);
      const platform = entity.components.some(component => component.type === 'movingPlatform' && component.enabled);
      const [width, height, depth] = entity.transform.scale;
      return collision !== undefined && !platform && height === 2 && width >= 7 && depth >= 4;
    })
    .map(entity => {
      const [, y, z] = entity.transform.position;
      return { startZ: z - entity.transform.scale[2] / 2, endZ: z + entity.transform.scale[2] / 2, top: y + 1, width: entity.transform.scale[0], id: entity.id };
    })
    .sort((left, right) => left.startZ - right.startZ);
}
function advance(state: ParkourState, level: ParkourLevel, seconds: number, input: (step: number) => Partial<ParkourInputState>): void {
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step++) stepParkour(state, level, { ...createInputState(), ...input(step) }, STEP, []);
}
/** Advances until `done()` or the budget runs out, so a landing test never sprints off the far edge. */
function advanceUntil(state: ParkourState, level: ParkourLevel, seconds: number, input: (step: number) => Partial<ParkourInputState>, done: () => boolean): void {
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step++) {
    stepParkour(state, level, { ...createInputState(), ...input(step) }, STEP, []);
    if (done()) return;
  }
}
/** Launches the runner off an edge at full tilt and reports the landing. */
function leap(level: ParkourLevel, from: { z: number; y: number }, speed: number, doubleJumpAtStep: number | null): { landed: boolean; z: number; y: number } {
  const state = createParkourState(level);
  state.position = { x: 0, y: from.y + 0.02, z: from.z };
  state.velocity = { x: 0, y: level.config.jumpVelocity, z: speed };
  state.grounded = false; state.jumps = 0;
  const steps = Math.round(4 / STEP);
  for (let step = 0; step < steps; step++) {
    const jump = doubleJumpAtStep !== null && step === doubleJumpAtStep;
    stepParkour(state, level, { ...createInputState(), moveZ: 1, sprint: true, jumpHeld: true, jump, cameraYaw: 0 }, STEP, []);
    if (state.grounded && step > 4) break;
  }
  return { landed: state.grounded, z: state.position.z, y: state.position.y };
}
const near = (value: number, target: number, tolerance: number): boolean => Math.abs(value - target) <= tolerance;

test('the campaign document sequences five registered, ascending-medal courses', () => {
  assert.equal(campaign.courses.length, 5);
  assert.equal(campaign.unlock, 'sequential');
  assert.equal(new Set(campaign.courses.map(course => course.sceneId)).size, 5);
  for (const course of campaign.courses) {
    assert.ok(course.goldSeconds < course.silverSeconds && course.silverSeconds < course.bronzeSeconds, course.name);
    assert.ok(fixture.scenes.some(scene => scene.sceneId === course.sceneId));
  }
  assert.equal(fixture.manifest.campaign, 'progression/campaign.json');
  for (const scene of fixture.scenes) {
    const players = scene.entities.filter(entity => entity.components.some(component => component.type === 'player' && component.enabled));
    const cameras = scene.entities.filter(entity => entity.components.some(component => component.type === 'camera' && component.enabled));
    const goals = scene.entities.filter(entity => entity.components.some(component => component.type === 'goal' && component.enabled));
    assert.equal(players.length, 1, `${scene.name} has one runner`);
    assert.equal(cameras.length, 1, `${scene.name} has one camera`);
    assert.equal(goals.length, 1, `${scene.name} has one goal`);
  }
});

test('every course deck is joined by a clearable jump, a ferry or a lift', () => {
  for (const [index, level] of levels.entries()) {
    const decks = decksOf(courseScenes[index]!);
    assert.ok(decks.length >= 4, `course ${index + 1} is a real route`);
    for (const [deckIndex, deck] of decks.entries()) {
      const next = decks[deckIndex + 1];
      if (!next) continue;
      const gap = next.startZ - deck.endZ;
      const rise = next.top - deck.top;
      const platform = level.platforms.find(candidate => candidate.waypoints.some(point => near(point.y, next.top - 0.5, 0.6) && point.z > next.startZ - 7 && point.z < next.startZ + 1));
      if (platform) {
        // Platform routes are proven by the ride test below; the authored gap is intentional.
        assert.ok(gap > 0 || rise > 0.5, `course ${index + 1}: the platform covers a real obstacle`);
        continue;
      }
      if (gap > 6) {
        // A chasm: the only way across is the double jump, and walls must frame it.
        assert.ok(rise <= 0.2, `course ${index + 1}: a chasm cannot also climb`);
        const walls = level.solids.filter(solid => Math.abs(solid.box.min.x) > 3 || Math.abs(solid.box.max.x) > 3);
        assert.ok(walls.length >= 2, `course ${index + 1}: the chasm is framed by wall-run faces`);
        const result = leap(level, { z: deck.endZ - 0.4, y: deck.top }, level.config.sprintSpeed, 47);
        assert.equal(result.landed, true, `course ${index + 1}: the chasm must be jumpable`);
        assert.ok(result.z >= next.startZ - 0.9, `course ${index + 1}: chasm landed at z=${result.z.toFixed(2)}, need ${next.startZ.toFixed(2)}`);
        assert.ok(near(result.y, next.top, 0.2), `course ${index + 1}: chasm landed at y=${result.y.toFixed(2)}, need ${next.top.toFixed(2)}`);
        continue;
      }
      const result = leap(level, { z: deck.endZ - 0.4, y: deck.top }, level.config.sprintSpeed, null);
      assert.equal(result.landed, true, `course ${index + 1}: gap at z=${deck.endZ.toFixed(1)} must be jumpable (gap ${gap.toFixed(2)}, rise ${rise.toFixed(2)})`);
      assert.ok(result.z >= next.startZ - 0.8, `course ${index + 1}: landed at z=${result.z.toFixed(2)}, expected ${next.startZ.toFixed(2)} (gap ${gap.toFixed(2)})`);
      assert.ok(near(result.y, next.top, 0.2), `course ${index + 1}: landed at y=${result.y.toFixed(2)}, expected ${next.top.toFixed(2)}`);
    }
  }
});

test('every ferry and lift carries the runner to the next deck', () => {
  for (const [index, level] of levels.entries()) {
    const decks = decksOf(courseScenes[index]!);
    for (const platform of level.platforms) {
      const from = platform.waypoints[0]!;
      const to = platform.waypoints[platform.waypoints.length - 1]!;
      const vertical = near(from.x, to.x, 0.01) && near(from.z, to.z, 0.01) && !near(from.y, to.y, 0.01);
      const landing = decks.find(deck => near(deck.top, to.y + 0.5, 0.6) && deck.startZ >= to.z - 8 && deck.startZ <= to.z + 4);
      assert.ok(landing, `course ${index + 1}: platform ${platform.id} leads somewhere`);
      const state = createParkourState(level);
      state.position = { x: from.x, y: from.y + 0.52, z: from.z };
      state.velocity = { x: 0, y: 0, z: 0 };
      if (vertical) {
        // Hold forward against the terrace wall while the lift rises, then walk off the top.
        advanceUntil(state, level, 16, () => ({ moveZ: 1, sprint: true, jumpHeld: true }),
          () => state.grounded && state.position.z >= landing.startZ + 0.5 && near(state.position.y, landing.top, 0.2));
        assert.equal(state.deaths, 0, `course ${index + 1}: the lift route is safe`);
        assert.ok(state.position.z >= landing.startZ - 0.6, `course ${index + 1}: lift handed the runner to the deck`);
        assert.ok(near(state.position.y, landing.top, 0.2), `course ${index + 1}: lift ended at y=${state.position.y.toFixed(2)}, expected ${landing.top.toFixed(2)}`);
      } else {
        // Wait for the ferry to finish its leg instead of guessing the travel time.
        const motion = state.platforms[level.platforms.indexOf(platform)]!;
        const maxSteps = Math.round(14 / STEP);
        for (let step = 0; step < maxSteps; step++) {
          stepParkour(state, level, createInputState(), STEP, []);
          if (near(motion.position.x, to.x, 0.05) && near(motion.position.z, to.z, 0.05)) break;
        }
        assert.ok(near(state.position.z, to.z, 3), `course ${index + 1}: the ferry carried the runner`);
        advanceUntil(state, level, 2.2, () => ({ moveZ: 1, sprint: true, jumpHeld: true }),
          () => state.grounded && state.position.z >= landing.startZ + 0.6 && near(state.position.y, landing.top, 0.2));
        assert.equal(state.deaths, 0, `course ${index + 1}: stepping off the ferry is safe`);
        assert.ok(state.position.z >= landing.startZ - 0.6, `course ${index + 1}: the ferry handed the runner to the deck`);
        assert.ok(near(state.position.y, landing.top, 0.2), `course ${index + 1}: ferry ended at y=${state.position.y.toFixed(2)}, expected ${landing.top.toFixed(2)}`);
      }
    }
  }
});

test('every slide gate stops a standing runner and passes a sliding one', () => {
  let gates = 0;
  for (const [index, level] of levels.entries()) {
    const bars = courseScenes[index]!.entities.filter(entity => {
      const [width, height] = entity.transform.scale;
      return height === 1.2 && width >= 7 && entity.components.some(component => component.type === 'collision' && component.enabled);
    });
    for (const bar of bars) {
      gates++;
      const [x, y, z] = bar.transform.position;
      const top = y - 1.6;
      const approach = (slide: boolean): ParkourState => {
        const state = createParkourState(level);
        state.position = { x: 0, y: top + 0.02, z: z - 8 };
        state.velocity = { x: 0, y: 0, z: level.config.sprintSpeed };
        advanceUntil(state, level, 4, () => ({
          moveZ: 1, sprint: true, jumpHeld: true,
          slide: slide && state.position.z >= z - 4.5 && state.grounded,
        }), () => state.position.z > z + 1.2);
        return state;
      };
      const standing = approach(false);
      assert.ok(standing.position.z < z - 0.2, `course ${index + 1}: a standing runner is stopped by the gate at z=${z.toFixed(2)}, got ${standing.position.z.toFixed(2)}`);
      const sliding = approach(true);
      assert.ok(sliding.position.z > z + 0.6, `course ${index + 1}: a sliding runner passes the gate at z=${z.toFixed(2)}, got ${sliding.position.z.toFixed(2)}`);
      void x;
    }
  }
  assert.ok(gates >= 3, 'the campaign ships slide gates in more than one course');
});

test('the campaign is deterministic from its seed and seed-sensitive', () => {
  const again = createRooftopRelayFixture();
  assert.deepEqual(again.files, fixture.files);
  const other = createRooftopRelayFixture('night-shift');
  assert.deepEqual(other.scenes.map(scene => scene.entities.map(entity => entity.id)), fixture.scenes.map(scene => scene.entities.map(entity => entity.id)));
  assert.notDeepEqual(other.files['scenes/course-01.scene.json'], fixture.files['scenes/course-01.scene.json']);
  assert.deepEqual(other.campaign?.courses.map(course => course.sceneId), campaign.courses.map(course => course.sceneId));
});

test('medals follow the authored thresholds', () => {
  const course = campaign.courses[0]!;
  assert.equal(medalFor(course, course.goldSeconds - 0.01), 'gold');
  assert.equal(medalFor(course, course.goldSeconds), 'gold');
  assert.equal(medalFor(course, course.goldSeconds + 0.01), 'silver');
  assert.equal(medalFor(course, course.silverSeconds), 'silver');
  assert.equal(medalFor(course, course.silverSeconds + 0.01), 'bronze');
  assert.equal(medalFor(course, course.bronzeSeconds + 0.01), null);
  assert.equal(medalFor(course, Number.NaN), null);
});

test('a first clear unlocks exactly the next course and records the best run', () => {
  const first = campaign.courses[0]!;
  const second = campaign.courses[1]!;
  let progress = createProgress(campaign);
  assert.equal(isCourseUnlocked(campaign, progress, 0), true);
  assert.equal(isCourseUnlocked(campaign, progress, 1), false);
  const slow = recordRun(campaign, progress, first.sceneId, { seconds: first.bronzeSeconds + 5, shards: 1, completed: true });
  progress = slow.progress;
  assert.equal(slow.outcome.firstClear, true);
  assert.equal(slow.outcome.medal, null);
  assert.equal(slow.outcome.unlockedSceneId, second.sceneId);
  assert.equal(isCourseUnlocked(campaign, progress, 1), true);
  assert.equal(isCourseUnlocked(campaign, progress, 2), false);
  const fast = recordRun(campaign, progress, first.sceneId, { seconds: first.goldSeconds - 1, shards: 4, completed: true });
  progress = fast.progress;
  assert.equal(fast.outcome.newBest, true);
  assert.equal(fast.outcome.medal, 'gold');
  assert.equal(fast.outcome.unlockedSceneId, null, 're-clearing does not re-announce the unlock');
  assert.equal(progress.courses[first.sceneId]!.bestSeconds, first.goldSeconds - 1);
  assert.equal(progress.courses[first.sceneId]!.bestShards, 4);
  const abandoned = recordRun(campaign, progress, second.sceneId, { seconds: 0, shards: 0, completed: false });
  assert.equal(abandoned.outcome.firstClear, false);
  assert.equal(abandoned.progress.courses[second.sceneId]!.runs, 1);
  assert.equal(abandoned.progress.courses[second.sceneId]!.bestSeconds, null);
  assert.equal(isCourseUnlocked(campaign, abandoned.progress, 2), false, 'abandoning does not unlock');
});

test('save round-trips through storage and resets safely on damage', () => {
  const storage = createMemoryStorage();
  let progress = createProgress(campaign);
  progress = recordRun(campaign, progress, campaign.courses[0]!.sceneId, { seconds: 20, shards: 3, completed: true }).progress;
  progress = { ...progress, settings: { volume: 0.4, sensitivity: 1.75, reducedMotion: true } };
  assert.equal(persistProgress(campaign, progress, storage), true);
  const loaded = loadProgress(campaign, storage);
  assert.deepEqual(loaded.courses, progress.courses);
  assert.deepEqual(loaded.settings, progress.settings);
  const raw = storage.read(saveKey(campaign))!;
  storage.write(saveKey(campaign), '{not json');
  assert.deepEqual(loadProgress(campaign, storage), createProgress(campaign), 'corrupt saves reset instead of throwing');
  storage.write(saveKey(campaign), JSON.stringify({ version: 99, campaignId: campaign.campaignId }));
  assert.deepEqual(loadProgress(campaign, storage), createProgress(campaign), 'unknown save versions reset');
  assert.equal(loadProgress(campaign, null).settings.volume, DEFAULT_SETTINGS.volume);
  assert.equal(persistProgress(campaign, progress, null), false, 'a missing store reports that nothing was saved');
  const refusing = { read: () => raw, write: () => false, remove: () => undefined };
  assert.equal(persistProgress(campaign, progress, refusing), false);
});

test('migration clamps settings, ignores foreign courses and keeps real records', () => {
  const first = campaign.courses[0]!;
  const migrated = migrateProgress({
    version: 1, campaignId: campaign.campaignId,
    settings: { volume: 9, sensitivity: -3, reducedMotion: true },
    courses: {
      [first.sceneId]: { bestSeconds: first.goldSeconds + 2, bestShards: 7.9, runs: 3.2, bestMedal: 'gold' },
      not_a_course: { bestSeconds: 1, bestShards: 1, runs: 1, completed: true },
    },
    lastPlayedSceneId: first.sceneId,
  }, campaign);
  assert.equal(migrated.settings.volume, 1);
  assert.equal(migrated.settings.sensitivity, 0.25);
  assert.equal(migrated.settings.reducedMotion, true);
  assert.equal(migrated.courses[first.sceneId]!.bestSeconds, first.goldSeconds + 2);
  assert.equal(migrated.courses[first.sceneId]!.bestShards, 7);
  assert.equal(migrated.courses[first.sceneId]!.bestMedal, 'silver', 'the medal is recomputed from the saved time');
  assert.equal(migrated.courses['not_a_course'], undefined);
  assert.equal(migrated.lastPlayedSceneId, first.sceneId);
  assert.equal(formatSeconds(null), '—');
  assert.equal(formatSeconds(62.5), '1:02.50');
});

test('every course has audio and a proven goal', () => {
  for (const [index, scene] of courseScenes.entries()) {
    const audio = scene.entities.flatMap(entity => entity.components).filter(component => component.type === 'audio' && component.enabled);
    assert.ok(audio.some(component => component.properties.on === 'goal'), `course ${index + 1} has a finish cue`);
    assert.ok(audio.some(component => component.properties.autoplay === true), `course ${index + 1} has ambient audio`);
    const level = levels[index]!;
    assert.ok(level.goal, `course ${index + 1} has a goal`);
    assert.equal(level.checkpoints.filter(checkpoint => checkpoint.spawn).length, 1);
    assert.ok(level.collectibles.length >= 4, `course ${index + 1} has shards`);
    for (const checkpoint of level.checkpoints) {
      const supported = level.solids.some(solid => Math.abs(solid.box.max.y - checkpoint.groundY) < 1e-6
        && checkpoint.center.x >= solid.box.min.x && checkpoint.center.x <= solid.box.max.x
        && checkpoint.center.z >= solid.box.min.z && checkpoint.center.z <= solid.box.max.z);
      assert.ok(supported, `course ${index + 1}: checkpoint ${checkpoint.index} sits on a deck`);
    }
  }
});

test('every course starts on its spawn gate and ends at its goal', () => {
  for (const [index, level] of levels.entries()) {
    const state = createParkourState(level);
    assert.ok(near(state.position.x, level.spawn.x, 0.001) && near(state.position.y, level.spawn.y, 0.001) && near(state.position.z, level.spawn.z, 0.001));
    const goal = level.goal!;
    state.position = { x: goal.center.x, y: goal.center.y, z: goal.center.z - 0.6 };
    state.velocity = { x: 0, y: 0, z: 0 };
    const events: ParkourEvent[] = [];
    for (let step = 0; step < Math.round(2 / STEP) && !state.finished; step++) {
      stepParkour(state, level, { ...createInputState(), moveZ: 1, sprint: true, jumpHeld: true }, STEP, events);
    }
    assert.ok(events.some(event => event.type === 'goal'), `course ${index + 1}: the goal ends the run`);
    assert.equal(state.finished, true);
  }
});

test('every scene entity is well-formed for the shared schema', () => {
  for (const scene of fixture.scenes) {
    for (const entity of scene.entities) {
      assert.equal(entity.enabled, true);
      assert.ok(entity.name.trim().length > 0);
      for (const component of entity.components) {
        assert.ok(component.id.length <= 128);
        assert.ok(Object.keys(component.properties).every(key => typeof key === 'string'));
      }
    }
    const ids = new Set(scene.entities.map(entity => entity.id));
    for (const entity of scene.entities) {
      for (const component of entity.components) {
        for (const ref of component.entityRefs) assert.ok(ids.has(ref), `missing entity ref ${ref}`);
      }
    }
  }
});
