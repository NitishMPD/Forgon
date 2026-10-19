import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScriptsForPlay, prepareScriptsForPlay } from '../src/scripts.js';
import { createEntity, createScene } from '@forgon/project-schema';

test('Play validates enabled script attachments without executing project code in the editor', () => {
  const scene = createScene('Desktop Play'); const entity = createEntity('Cube'); scene.entities = [entity];
  const catalog = { scripts: [], diagnostics: [] };
  assert.doesNotThrow(() => validateScriptsForPlay(scene, catalog));
  const script = { id: 'script', type: 'script' as const, enabled: false, properties: { src: 'scripts/spinner.ts', params: {} }, entityRefs: [], assetRefs: [] };
  entity.components.push(script);
  assert.doesNotThrow(() => validateScriptsForPlay(scene, catalog));
  script.enabled = true;
  assert.throws(() => validateScriptsForPlay(scene, catalog), /Script not found/);
  assert.doesNotThrow(() => validateScriptsForPlay(scene, { scripts: [{ src: 'scripts/spinner.ts', props: {}, code: 'throw new Error("must not run")' }], diagnostics: [] }));
});

test('Play preparation blocks compilation failures before evaluating any compiled module', async () => {
  const marker = '__forgonScriptExecuted';
  await assert.rejects(prepareScriptsForPlay({ scripts: [{ src: 'scripts/fail.ts', props: {}, code: `globalThis.${marker} = true;` }], diagnostics: [{ path: 'scripts/fail.ts', line: 2, column: 3, message: 'Unexpected token' }] }), /did not compile.*Console/);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  assert.deepEqual({ ...await prepareScriptsForPlay({ scripts: [], diagnostics: [] }) }, {});
});
