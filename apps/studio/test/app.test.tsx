import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorStore } from '@forgon/editor-core';
import { parseScene } from '@forgon/project-schema';
import { App } from '../src/App.js';
import { sampleScene } from '../src/sample.js';
import type { StudioServices } from '@forgon/editor-ui';

const disconnectedServices: StudioServices = { project: null, agent: null, viewport: null };

test('studio with no desktop services renders the launcher with the capability gaps stated', () => {
  const html = renderToStaticMarkup(<App services={disconnectedServices} />);
  assert.match(html, /Forgon Engine/);
  assert.match(html, /desktop host is not connected/);
  assert.match(html, /In-memory sample/);
});

test('the in-memory sample is a valid scene with stable IDs and a working edit history', () => {
  const scene = sampleScene();
  assert.deepEqual(parseScene(scene), scene);
  assert.equal(scene.entities.length, 6);
  assert.equal(new Set(scene.entities.map(entity => entity.id)).size, scene.entities.length);
  const store = new EditorStore(scene, null);
  const guest = scene.entities.find(entity => entity.name === 'Guest')!;
  store.execute({ type: 'rename', entityId: guest.id, name: 'Guest 2' });
  assert.equal(store.scene.entities.find(entity => entity.id === guest.id)?.name, 'Guest 2');
  assert.equal(store.undo(), true);
  assert.equal(store.dirty, true, 'sample has no disk revision, so it is never clean');
});
