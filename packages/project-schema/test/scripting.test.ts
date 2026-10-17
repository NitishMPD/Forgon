import test from 'node:test';
import assert from 'node:assert/strict';
import { componentSchema, createEntity, createScene, parseScene, parseScriptProps, resolveScriptParams } from '../src/index.js';

const attachment = { id: 'spin', type: 'script', enabled: true, properties: { src: 'scripts/spinner.ts', params: { speed: 45 } }, entityRefs: [], assetRefs: [] };
test('script attachments validate paths and finite JSON params, and allow repeated types with stable IDs', () => {
  assert.deepEqual(componentSchema.parse(attachment), attachment);
  const entity = createEntity('Spinner');
  entity.components = [attachment, { ...attachment, id: 'spin2' }];
  assert.equal(parseScene({ ...createScene('Scripts'), entities: [entity] }).entities[0]!.components.length, 2);
  for (const src of ['scripts/../escape.ts', '../scripts/spin.ts', '/scripts/spin.ts', 'scripts\\spin.ts', 'scripts/spin.js', 'https://site/script.ts']) assert.equal(componentSchema.safeParse({ ...attachment, properties: { src, params: {} } }).success, false, src);
  for (const params of [null, [], 'bad', { speed: Infinity }, { callback: () => 1 }]) assert.equal(componentSchema.safeParse({ ...attachment, properties: { src: 'scripts/a.ts', params } }).success, false);
});
test('script defaults and declared values are validated without losing explicit null entity references', () => {
  const props = parseScriptProps({ speed: { type: 'number', default: 90, min: 0, max: 200, step: 1 }, target: { type: 'entity', default: 'target' }, tint: { type: 'color', default: [1, 0, 0] }, mode: { type: 'enum', default: 'walk', options: ['walk', 'run'] } });
  const params = resolveScriptParams(props, { target: null });
  assert.equal(params.speed, 90); assert.equal(params.target, null);
  for (const input of [{ speed: -1 }, { speed: '3' }, { tint: [2, 0, 0] }, { target: '../bad' }, { mode: 'fly' }]) assert.throws(() => resolveScriptParams(props, input));
  for (const invalid of [{ type: 'number', default: 3, min: 4 }, { type: 'number', default: 3, min: 4, max: 2 }, { type: 'number', default: 0, step: 0 }, { type: 'enum', default: 'missing', options: ['walk'] }]) assert.throws(() => parseScriptProps({ invalid }));
  (params.tint as number[])[0] = 0;
  assert.deepEqual(props.tint!.default, [1, 0, 0], 'mutable instance params never change declaration defaults');
});
