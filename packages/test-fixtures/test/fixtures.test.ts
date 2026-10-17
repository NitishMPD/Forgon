import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateProject } from '@forgon/project-schema';
import { createEmpty3dFixture, createFixture, createHotelFixture, receptionWav } from '../src/index.js';

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

test('checked-in fixtures exactly match their built-in generators', async () => {
  for (const [directory, fixture] of [['examples/hotel-vertical-slice', createHotelFixture()], ['templates/empty-3d', createEmpty3dFixture()]] as const) {
    for (const [path, expected] of Object.entries(fixture.files)) {
      const actual = await readFile(fileURLToPath(new URL(`../../../${directory}/${path}`, import.meta.url)));
      assert.deepEqual(actual, Buffer.from(expected), `${directory}/${path}`);
    }
  }
});
