import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDestination } from '../src/model/projectDestination.js';

test('create destinations preserve parent path format and reject unsafe child names', () => {
  assert.equal(projectDestination('D:\\Games', 'My game'), 'D:\\Games\\My game');
  assert.equal(projectDestination('/tmp/games/', 'hotel'), '/tmp/games/hotel');
  for (const name of ['', '.', '..', '../game', 'a/b', 'a\\b', 'CON', 'nul.txt', 'a.', ' a', 'a ', 'LPT1']) {
    assert.throws(() => projectDestination('D:\\Games', name), name);
  }
});
