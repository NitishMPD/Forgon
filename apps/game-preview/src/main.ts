import { mountGame } from '@forgon/game-runtime/runtime';
import type { GameHandle } from '@forgon/game-runtime/runtime';
import hotelScene from '../../../examples/hotel-vertical-slice/scenes/main.scene.json';
import hotelAssets from '../../../examples/hotel-vertical-slice/assets/registry.json';
import hotelPrefab from '../../../examples/hotel-vertical-slice/prefabs/gen_e815b722e2fda7a3.prefab.json';
import sectorScene from '../../../examples/sector/scenes/main.scene.json';
import sectorAssets from '../../../examples/sector/assets/registry.json';
import sectorLift from '../../../examples/sector/prefabs/gen_1f2515aaff3c10e7.prefab.json';
import sectorSentinel from '../../../examples/sector/prefabs/gen_9a060ef876d0ef10.prefab.json';
import { parseAssetRegistry, parsePrefab, parseScene } from '../../../packages/project-schema/src/index.js';
import type { AssetRecord, PrefabDocument, SceneDocument } from '../../../packages/project-schema/src/index.js';

interface Preview {
  scene: SceneDocument;
  assets: AssetRecord[];
  prefabs: PrefabDocument[];
  /** Bundled audio URL; static `new URL(..., import.meta.url)` keeps Vite's asset graph intact. */
  audio: URL;
  /** Opening card text for a parkour course. */
  title?: string;
  subtitle?: string;
}

/** The checked-in fixtures the standalone player can mount. Each is a real, validated project. */
const projects: Record<string, Preview> = {
  sector: {
    scene: parseScene(sectorScene), assets: parseAssetRegistry(sectorAssets).assets,
    prefabs: [parsePrefab(sectorLift), parsePrefab(sectorSentinel)],
    audio: new URL('../../../examples/sector/assets/relay.wav', import.meta.url),
    title: 'SECTOR 07', subtitle: 'reach the uplink relay',
  },
  hotel: {
    scene: parseScene(hotelScene), assets: parseAssetRegistry(hotelAssets).assets, prefabs: [parsePrefab(hotelPrefab)],
    audio: new URL('../../../examples/hotel-vertical-slice/assets/reception.wav', import.meta.url),
  },
};

const container = document.getElementById('game')!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-play]'));
const stop = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('status')!;
let game: GameHandle | undefined;
let generation = 0;

const setBusy = (busy: boolean): void => {
  for (const button of buttons) button.disabled = busy;
  stop.disabled = !busy;
};

async function play(id: string): Promise<void> {
  const project = projects[id];
  if (!project) return;
  const token = ++generation;
  setBusy(true);
  status.textContent = 'Loading engine and physics…';
  try {
    const mounted = await mountGame(container, {
      scene: project.scene, assets: project.assets, prefabs: project.prefabs,
      loadAssetBytes: async assetId => {
        const asset = project.assets.find(candidate => candidate.id === assetId);
        if (asset?.kind !== 'audio') throw new Error(`Unsupported fixture asset ${assetId}`);
        const response = await fetch(project.audio);
        if (!response.ok) throw new Error(`Fixture audio failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      ...(project.title ? { title: project.title, subtitle: project.subtitle } : {}),
      onRuntimeEvent: event => {
        if (token !== generation) return;
        if (event.type === 'arrival') status.textContent = `Guest arrived at ${event.waypointEntityId}`;
        if (event.type === 'goal') status.textContent = `Uplink reached in ${event.time.toFixed(1)}s — ${event.collected}/${event.total} shards.`;
        if (event.type === 'death') status.textContent = `Run reset (${event.reason}); ${event.deaths} deaths.`;
        if (event.type === 'fault' || (event.type === 'audio' && event.status !== 'played')) status.textContent = event.message ?? 'Audio unavailable';
      },
    });
    if (token !== generation) { mounted.dispose(); return; }
    game = mounted;
    status.textContent = mounted.parkour
      ? 'Playing Sector 07. Click for mouse look; WASD move, Shift sprint, Space jump, C slide, R restart.'
      : 'Playing detached hotel scene.';
  } catch (error) {
    status.textContent = String(error);
    setBusy(false);
  }
}

for (const button of buttons) button.addEventListener('click', () => { void play(button.dataset.play!); });
stop.addEventListener('click', () => {
  generation++; game?.dispose(); game = undefined;
  setBusy(false); status.textContent = 'Stopped.';
});
window.addEventListener('pagehide', () => { generation++; game?.dispose(); });
buttons[0]?.focus();
