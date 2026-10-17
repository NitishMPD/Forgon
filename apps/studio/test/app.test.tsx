import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorStore } from '@forgon/editor-core';
import { parseScene } from '@forgon/project-schema';
import { App } from '../src/App.js';
import { sampleScene } from '../src/sample.js';
import { defaultLayout, readLayout, writeLayout, type LayoutState } from '@forgon/editor-ui';
import type { StudioServices } from '@forgon/editor-ui';

const disconnectedServices: StudioServices = { project: null, agent: null, viewport: null };

test('studio with no desktop services renders the launcher with the capability gaps stated', () => {
  const html = renderToStaticMarkup(<App services={disconnectedServices} />);
  assert.match(html, /Forgon <span>Engine<\/span>/);
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

test('Studio project layout key recovers a stored dock and persists floating visibility/card state', () => {
  const key = 'forgon.layout.v2:project_hotel';
  const values = new Map([[key, JSON.stringify({ version: 2, groups: { topLeft: { tabs: ['viewport'], active: 'viewport' } } })]]);
  const storage = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); } };
  const recovered = readLayout(storage, key);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.layout, defaultLayout);
  writeLayout(storage, key, recovered.layout);
  assert.equal(readLayout(storage, key).recovered, false);
  const next: LayoutState = { ...recovered.layout, hierarchy: false, inspector: true, expandedCard: 'agents' };
  writeLayout(storage, key, next);
  assert.deepEqual(readLayout(storage, key).layout, next);
  assert.deepEqual(readLayout(storage, 'forgon.layout.v2:other').layout, defaultLayout);
});
