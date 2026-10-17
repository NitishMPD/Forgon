import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntity, createScene, parseScene } from '@forgon/project-schema';
import type { SceneDocument } from '@forgon/project-schema';
import { diffScenes } from '../src/model/sceneDiff.js';
import { buildRows, stepId, topmostIds } from '../src/model/tree.js';
import { noSelection, pruneSelection, rangeSelection, selectOne, toggleSelection } from '../src/model/selection.js';
import { parseFiniteNumber, formatNumber } from '../src/model/numbers.js';
import { defaultLayout, parseLayout, readLayout, writeLayout, type KeyValueStorage } from '../src/model/layout.js';
import { appendLog, countBySeverity, emptyLog, logCap } from '../src/model/consoleLog.js';

function sceneWithTree(): SceneDocument {
  const root = createEntity('Root');
  const child = createEntity('Child', root.id);
  const grandchild = createEntity('Grandchild', child.id);
  const sibling = createEntity('Sibling', root.id);
  return { ...createScene('Test'), entities: [root, child, grandchild, sibling] };
}

test('tree rows keep author order, depth, and collapsed subtrees hidden', () => {
  const scene = sceneWithTree();
  const [root, child, grandchild, sibling] = scene.entities;
  const rows = buildRows(scene.entities, new Set());
  assert.deepEqual(rows.map(row => [row.name, row.depth]), [['Root', 0], ['Child', 1], ['Grandchild', 2], ['Sibling', 1]]);
  assert.equal(rows[0]?.hasChildren, true);
  const collapsed = buildRows(scene.entities, new Set([child!.id]));
  assert.deepEqual(collapsed.map(row => row.id), [root!.id, child!.id, sibling!.id]);
  assert.equal(collapsed[1]?.expanded, false);
  assert.ok(!collapsed.some(row => row.id === grandchild!.id));
});

test('keyboard stepping clamps at the ends and handles no focus', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepId(ids, null, 1), 'a');
  assert.equal(stepId(ids, null, -1), 'c');
  assert.equal(stepId(ids, 'c', 1), 'c');
  assert.equal(stepId(ids, 'a', -1), 'a');
  assert.equal(stepId([], null, 1), null);
});

test('deleting several objects removes only topmost selections to avoid double deletes', () => {
  const scene = sceneWithTree();
  const [root, child, grandchild, sibling] = scene.entities.map(entity => entity.id);
  assert.deepEqual(topmostIds(scene.entities, [root!, child!, grandchild!]), [root!]);
  assert.deepEqual(topmostIds(scene.entities, [child!, sibling!]), [child!, sibling!]);
});

test('selection toggles, ranges, and prunes deleted IDs while keeping survivors', () => {
  const visible = ['a', 'b', 'c', 'd'];
  let selection = selectOne('a');
  selection = rangeSelection(selection, visible, 'c');
  assert.deepEqual(selection.entityIds, ['a', 'b', 'c']);
  assert.equal(selection.primaryId, 'c');
  selection = toggleSelection(selection, 'b');
  assert.deepEqual(selection.entityIds, ['a', 'c']);
  const pruned = pruneSelection(selection, new Set(['a', 'd']));
  assert.deepEqual(pruned.entityIds, ['a']);
  assert.equal(pruned.primaryId, 'a');
  assert.equal(pruneSelection(pruned, new Set(['a'])), pruned);
  assert.deepEqual(noSelection, { entityIds: [], primaryId: null });
});

test('numeric fields accept only finite numbers and format stable text', () => {
  assert.equal(parseFiniteNumber(' 2.5 '), 2.5);
  assert.equal(parseFiniteNumber('-0'), -0);
  assert.equal(parseFiniteNumber(''), null);
  assert.equal(parseFiniteNumber('abc'), null);
  assert.equal(parseFiniteNumber('Infinity'), null);
  assert.equal(parseFiniteNumber('1e400'), null);
  assert.equal(formatNumber(3), '3');
  assert.equal(formatNumber(1 / 3), '0.3333');
});

test('scene diff reports per-property and per-object differences by stable ID', () => {
  const scene = sceneWithTree();
  const [root, child, grandchild] = scene.entities;
  const theirsEntities = scene.entities.map(entity => (entity.id === child!.id ? { ...entity, transform: { ...entity.transform, position: [1, 0, 0] as [number, number, number] } } : entity))
    .filter(entity => entity.id !== grandchild!.id);
  const theirs = parseScene({ ...scene, entities: [...theirsEntities, createEntity('Added')] });
  const changes = diffScenes(scene, theirs);
  const changed = changes.find(change => change.entityId === child!.id);
  assert.equal(changed?.status, 'changed');
  assert.deepEqual(changed?.changes.map(change => change.path), ['transform.position']);
  assert.equal(changes.find(change => change.entityId === grandchild!.id)?.status, 'only-ours');
  assert.ok(changes.some(change => change.status === 'only-theirs'));
  assert.deepEqual(diffScenes(scene, scene), []);
  assert.ok(root);
});

test('floating layout resets old dock formats and rejects invalid state', () => {
  for (const input of ['nope', { hierarchyWidth: 264 }, { version: 2, groups: {} }, { ...defaultLayout, expandedCard: 'unknown' }, { ...defaultLayout, inspector: 1 }]) {
    assert.deepEqual(parseLayout(input), { layout: defaultLayout, recovered: true });
  }
  const layout = { ...defaultLayout, hierarchy: false, expandedCard: 'console' };
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(layout))), { layout, recovered: false });
});

test('stored layout that is not JSON recovers silently and writes survive a failing storage', () => {
  const values = new Map<string, string>([['key', '{not json']]);
  const storage: KeyValueStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  assert.deepEqual(readLayout(storage, 'key'), { layout: defaultLayout, recovered: true });
  assert.deepEqual(readLayout(storage, 'missing'), { layout: defaultLayout, recovered: false });
  writeLayout(storage, 'key', defaultLayout);
  assert.deepEqual(readLayout(storage, 'key').layout, defaultLayout);
  const broken: KeyValueStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(readLayout(broken, 'key').recovered, true);
  assert.doesNotThrow(() => writeLayout(broken, 'key', defaultLayout));
});

test('console log keeps the newest entries up to the cap and reports dropped lines once', () => {
  let log = emptyLog;
  for (let index = 0; index < logCap + 5; index++) {
    log = appendLog(log, { source: 'editor', severity: index % 2 ? 'warning' : 'error', message: `line ${index}` }, '10:00:00');
  }
  assert.equal(log.entries.length, logCap);
  assert.equal(log.droppedCount, 5);
  assert.equal(log.entries[0]?.message, 'line 5');
  assert.deepEqual(countBySeverity(log.entries.slice(0, 2)), { errors: 1, warnings: 1 });
});

test('hierarchy search reveals matching descendants and ancestors without changing collapse state', () => {
  const root = createEntity('Lobby');
  const child = createEntity('Reception', root.id);
  const unrelated = createEntity('Garden');
  const collapsed = new Set([root.id]);
  assert.deepEqual(buildRows([root, child, unrelated], collapsed, '  RECEPT  ').map(row => row.id), [root.id, child.id]);
  assert.deepEqual(buildRows([root, child, unrelated], collapsed, child.id).map(row => row.id), [root.id, child.id]);
  assert.deepEqual(buildRows([root, child, unrelated], collapsed, 'missing'), []);
  assert.deepEqual(buildRows([root, child, unrelated], collapsed).map(row => row.id), [root.id, unrelated.id]);
  assert.deepEqual([...collapsed], [root.id]);
});
