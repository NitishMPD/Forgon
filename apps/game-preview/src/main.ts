import { mountGame } from '@forgon/game-runtime/runtime';
import type { GameHandle } from '@forgon/game-runtime/runtime';
import scene from '../../../examples/hotel-vertical-slice/scenes/main.scene.json';
import assets from '../../../examples/hotel-vertical-slice/assets/registry.json';
import prefab from '../../../examples/hotel-vertical-slice/prefabs/gen_e815b722e2fda7a3.prefab.json';
import { parseAssetRegistry, parsePrefab, parseScene } from '../../../packages/project-schema/src/index.js';

const container = document.getElementById('game')!;
const start = document.getElementById('start') as HTMLButtonElement;
const stop = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('status')!;
let game: GameHandle | undefined;
let generation = 0;
start.addEventListener('click', async () => {
  const token = ++generation;
  start.disabled = true;
  status.textContent = 'Loading engine and physics…';
  try {
    const mounted = await mountGame(container, {
      scene: parseScene(scene), assets: parseAssetRegistry(assets).assets, prefabs: [parsePrefab(prefab)],
      loadAssetBytes: async id => {
        const asset = assets.assets.find(asset => asset.id === id);
        if (asset?.kind !== 'audio') throw new Error(`Unsupported fixture asset ${id}`);
        const response = await fetch(new URL('../../../examples/hotel-vertical-slice/assets/reception.wav', import.meta.url));
        if (!response.ok) throw new Error(`Fixture audio failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      onRuntimeEvent: event => {
        if (token !== generation) return;
        if (event.type === 'arrival') status.textContent = `Guest arrived at ${event.waypointEntityId}`;
        if (event.type === 'fault' || (event.type === 'audio' && event.status !== 'played')) status.textContent = event.message ?? 'Audio unavailable';
      },
    });
    if (token !== generation) { mounted.dispose(); return; }
    game = mounted; stop.disabled = false;
    status.textContent = 'Playing detached hotel scene.';
  } catch (error) { status.textContent = String(error); start.disabled = false; }
});
stop.addEventListener('click', () => {
  generation++; game?.dispose(); game = undefined;
  start.disabled = false; stop.disabled = true; status.textContent = 'Stopped.';
});
window.addEventListener('pagehide', () => { generation++; game?.dispose(); });
