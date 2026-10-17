import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScriptPlaySupported, prepareScriptsForPlay } from '../src/scripts.js';
import { createEntity, createScene } from '@forgon/project-schema';

test('desktop Play rejects every scene with script attachments before compilation or module loading', () => {
  const scene = createScene('Desktop gate'); const entity = createEntity('Cube'); scene.entities = [entity];
  assert.doesNotThrow(() => assertScriptPlaySupported(scene, true));
  entity.components.push({ id: 'script', type: 'script', enabled: false, properties: { src: 'scripts/spinner.ts', params: {} }, entityRefs: [], assetRefs: [] });
  assert.throws(() => assertScriptPlaySupported(scene, true), /Scripts can't run in the desktop app yet \(isolated script context pending\)/);
  assert.doesNotThrow(() => assertScriptPlaySupported(scene, false));
});

test('Play preparation blocks compilation failures before evaluating any compiled module', async () => {
  const marker = '__forgonScriptExecuted';
  await assert.rejects(prepareScriptsForPlay({ scripts: [{ src: 'scripts/fail.ts', props: {}, code: `globalThis.${marker} = true;` }], diagnostics: [{ path: 'scripts/fail.ts', line: 2, column: 3, message: 'Unexpected token' }] }), /did not compile.*Console/);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  assert.deepEqual({ ...await prepareScriptsForPlay({ scripts: [], diagnostics: [] }) }, {});
});
