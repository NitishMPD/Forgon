import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateProject } from '@forgon/project-schema';
import { createEmpty3dFixture, createFixture, createHotelFixture, createRooftopRelayFixture, createSectorFixture, receptionWav, sectorWav } from '../src/index.js';

test('hotel is a valid original catalog with at least 30 entities and 5 prefab instances', () => {
  const fixture = createHotelFixture(); validateProject(fixture);
  const entities = fixture.scenes[0]!.entities;
  assert.ok(entities.length >= 30);
  assert.equal(new Set(entities.filter(entity => entity.prefab).map(entity => entity.prefab!.instanceId)).size, 5);
  for (const type of ['camera', 'light', 'render', 'collision', 'guestQueue', 'audio', 'vfx']) assert.ok(entities.some(entity => entity.components.some(component => component.type === type)), type);
  for (const asset of fixture.assets.assets) {
    assert.ok(fixture.files[asset.path]); assert.equal(asset.provenance!.license, 'CC0-1.0');
  }
});

test('fixture outputs are deterministic, seed-sensitive and preserve object identity', () => {
  const first = createHotelFixture('one'); assert.deepEqual(first, createHotelFixture('one'));
  const other = createHotelFixture('two');
  assert.deepEqual(first.scenes[0]!.entities.map(entity => entity.id), other.scenes[0]!.entities.map(entity => entity.id));
  assert.notEqual(first.files['scenes/main.scene.json'], other.files['scenes/main.scene.json']);
});

test('sector is a complete parkour course with the gameplay vocabulary and provenance', () => {
  const fixture = createSectorFixture(); validateProject(fixture);
  const entities = fixture.scenes[0]!.entities;
  const count = (type: string): number => entities.filter(entity => entity.components.some(component => component.type === type && component.enabled)).length;
  assert.ok(entities.length >= 60, 'the course is a real rooftop network, not a stub');
  assert.equal(count('player'), 1, 'one controllable runner');
  assert.equal(count('goal'), 1, 'a single uplink goal');
  assert.equal(count('hazard'), 3, 'three sentinel hazards');
  assert.equal(count('checkpoint'), 4, 'a spawn gate and three relay gates');
  assert.equal(count('collectible'), 8, 'eight data shards');
  assert.equal(count('movingPlatform'), 2, 'the relay ferry and the uplink lift');
  assert.ok(count('collision') >= 13, 'enough solids to run, wall-run and slide on');
  assert.equal(count('camera'), 1);
  assert.equal(count('light'), 3);
  assert.equal(count('audio'), 1);
  const scripted = entities.filter(entity => entity.components.some(component => component.type === 'script'));
  assert.equal(scripted.length, 1);
  assert.equal(scripted[0]!.components.filter(component => component.type === 'script').length, 2);
  assert.ok(scripted[0]!.components.some(component => component.type === 'render'), 'scripts demonstrate two attachments on a visible shard');
  assert.match(String(fixture.files['scripts/spinner.ts']), /defineScript/);
  assert.match(String(fixture.files['scripts/bobber.ts']), /frequency: prop.number/);
  // Two prefabs: the relay lift instantiated twice and the sentinel hazard three times.
  assert.equal(fixture.prefabs.length, 2);
  assert.equal(new Set(entities.filter(entity => entity.prefab).map(entity => entity.prefab!.instanceId)).size, 5);
  const camera = entities.find(entity => entity.components.some(component => component.type === 'camera'))!.components.find(component => component.type === 'camera')!;
  assert.equal(camera.properties.mode, 'follow', 'the cinematic camera chases the runner');
  for (const asset of fixture.assets.assets) {
    assert.ok(fixture.files[asset.path]); assert.equal(asset.provenance!.license, 'CC0-1.0');
  }
});

test('sector is deterministic, seed-sensitive and preserves object identity', () => {
  const first = createSectorFixture('one'); assert.deepEqual(first, createSectorFixture('one'));
  const other = createSectorFixture('two');
  assert.deepEqual(first.scenes[0]!.entities.map(entity => entity.id), other.scenes[0]!.entities.map(entity => entity.id));
  assert.notEqual(first.files['scenes/main.scene.json'], other.files['scenes/main.scene.json']);
});

test('sector audio has a valid PCM16 WAV header and non-silent bounded samples', () => {
  const bytes = sectorWav(); const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint32(24, true), 22050); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), bytes.length - 44);
  assert.ok(bytes.subarray(44).some(byte => byte !== 0));
});

test('empty-3d has only a camera and lights and no fabricated assets', () => {
  const fixture = createEmpty3dFixture(); validateProject(fixture);
  assert.equal(fixture.scenes[0]!.entities.length, 3);
  assert.equal(fixture.prefabs.length, 0); assert.equal(fixture.assets.assets.length, 0);
  assert.throws(() => createFixture('untrusted-script.ts'), /Unavailable/);
});

test('original audio has valid PCM16 WAV headers and non-silent bounded samples', () => {
  const bytes = receptionWav(); const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint32(24, true), 22050); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), bytes.length - 44);
  assert.ok(bytes.subarray(44).some(byte => byte !== 0));
});

test('rooftop relay is a five-course campaign with a real gameplay vocabulary', () => {
  const fixture = createRooftopRelayFixture();
  validateProject(fixture);
  assert.equal(fixture.scenes.length, 5);
  assert.equal(fixture.campaign?.courses.length, 5);
  assert.equal(fixture.campaign?.unlock, 'sequential');
  assert.equal(fixture.manifest.campaign, 'progression/campaign.json');
  assert.equal(fixture.prefabs.length, 5, 'one ferry prefab per course, so each keeps its palette');
  const count = (type: string): number => fixture.scenes.reduce((total, scene) => total + scene.entities.filter(entity => entity.components.some(component => component.type === type && component.enabled)).length, 0);
  assert.equal(count('player'), 5, 'one runner per course');
  assert.equal(count('goal'), 5, 'one uplink per course');
  assert.equal(count('checkpoint'), 17, 'a spawn gate and two or three relay gates per course');
  assert.equal(count('collectible'), 25, 'the routes carry shards');
  assert.equal(count('hazard'), 6, 'sentinels guard the later courses');
  assert.ok(count('collision') >= 40, 'every course is solid run surface');
  assert.equal(count('movingPlatform'), 3, 'two ferries and one lift');
  assert.equal(count('audio'), 15, 'ambient, checkpoint and goal cues per course');
  for (const scene of fixture.scenes) assert.equal(scene.entities.filter(entity => entity.components.some(component => component.type === 'camera')).length, 1);
  for (const asset of fixture.assets.assets) {
    assert.ok(fixture.files[asset.path]); assert.equal(asset.provenance!.license, 'CC0-1.0');
  }
});

test('rooftop relay is deterministic, seed-sensitive and keeps stable identities', () => {
  const first = createRooftopRelayFixture('one');
  assert.deepEqual(first, createRooftopRelayFixture('one'));
  const other = createRooftopRelayFixture('two');
  assert.deepEqual(first.scenes.map(scene => scene.entities.map(entity => entity.id)), other.scenes.map(scene => scene.entities.map(entity => entity.id)));
  assert.notEqual(first.files['scenes/course-01.scene.json'], other.files['scenes/course-01.scene.json']);
  assert.notEqual(first.files['assets/palette.json'], other.files['assets/palette.json']);
  assert.deepEqual(first.campaign?.courses.map(course => course.sceneId), other.campaign?.courses.map(course => course.sceneId));
});

test('checked-in fixtures exactly match their built-in generators', async () => {
  for (const [directory, fixture] of [['examples/hotel-vertical-slice', createHotelFixture()], ['examples/sector', createSectorFixture()], ['examples/rooftop-relay', createRooftopRelayFixture()], ['templates/empty-3d', createEmpty3dFixture()]] as const) {
    for (const [path, expected] of Object.entries(fixture.files)) {
      const actual = await readFile(fileURLToPath(new URL(`../../../${directory}/${path}`, import.meta.url)));
      assert.deepEqual(actual, Buffer.from(expected), `${directory}/${path}`);
    }
  }
});
