import { mountCampaign, mountGame } from '@forgon/game-runtime/runtime';
import type { AssetRecord, CampaignDocument, PrefabDocument, SceneDocument } from '../../../packages/project-schema/src/index.js';
import hotelScene from '../../../examples/hotel-vertical-slice/scenes/main.scene.json';
import hotelAssets from '../../../examples/hotel-vertical-slice/assets/registry.json';
import hotelPrefab from '../../../examples/hotel-vertical-slice/prefabs/gen_e815b722e2fda7a3.prefab.json';
import sectorScene from '../../../examples/sector/scenes/main.scene.json';
import sectorAssets from '../../../examples/sector/assets/registry.json';
import sectorLift from '../../../examples/sector/prefabs/gen_1f2515aaff3c10e7.prefab.json';
import sectorSentinel from '../../../examples/sector/prefabs/gen_9a060ef876d0ef10.prefab.json';
import relayCampaign from '../../../examples/rooftop-relay/progression/campaign.json';
import relayAssets from '../../../examples/rooftop-relay/assets/registry.json';
import relayScene1 from '../../../examples/rooftop-relay/scenes/course-01.scene.json';
import relayScene2 from '../../../examples/rooftop-relay/scenes/course-02.scene.json';
import relayScene3 from '../../../examples/rooftop-relay/scenes/course-03.scene.json';
import relayScene4 from '../../../examples/rooftop-relay/scenes/course-04.scene.json';
import relayScene5 from '../../../examples/rooftop-relay/scenes/course-05.scene.json';
import relayPrefab1 from '../../../examples/rooftop-relay/prefabs/gen_4b8ec62442fe3753.prefab.json';
import relayPrefab2 from '../../../examples/rooftop-relay/prefabs/gen_675f0a1675fd7bc8.prefab.json';
import relayPrefab3 from '../../../examples/rooftop-relay/prefabs/gen_969c34785fc08c47.prefab.json';
import relayPrefab4 from '../../../examples/rooftop-relay/prefabs/gen_aa1adcd94d4875e2.prefab.json';
import relayPrefab5 from '../../../examples/rooftop-relay/prefabs/gen_e1b6d080e2bb0641.prefab.json';
import { parseAssetRegistry, parseCampaign, parsePrefab, parseScene } from '../../../packages/project-schema/src/index.js';

interface Preview {
  scenes: SceneDocument[];
  campaign?: CampaignDocument;
  assets: AssetRecord[];
  prefabs: PrefabDocument[];
  /** Bundled audio, keyed by project-relative asset path. */
  audio: Record<string, URL>;
  /** Opening card text for a single-scene parkour game. */
  title?: string;
  subtitle?: string;
}

const relayScenes = [relayScene1, relayScene2, relayScene3, relayScene4, relayScene5].map(scene => parseScene(scene));
const relayAssetsParsed = parseAssetRegistry(relayAssets).assets;

/** The checked-in fixtures the standalone player can mount. Each is a real, validated project. */
const projects: Record<string, Preview> = {
  'rooftop-relay': {
    scenes: relayScenes,
    campaign: parseCampaign(relayCampaign, { sceneIds: relayScenes.map(scene => scene.sceneId) }),
    assets: relayAssetsParsed,
    prefabs: [relayPrefab1, relayPrefab2, relayPrefab3, relayPrefab4, relayPrefab5].map(prefab => parsePrefab(prefab)),
    audio: {
      'assets/relay-loop.wav': new URL('../../../examples/rooftop-relay/assets/relay-loop.wav', import.meta.url),
      'assets/relay-chime.wav': new URL('../../../examples/rooftop-relay/assets/relay-chime.wav', import.meta.url),
    },
  },
  sector: {
    scenes: [parseScene(sectorScene)], assets: parseAssetRegistry(sectorAssets).assets,
    prefabs: [parsePrefab(sectorLift), parsePrefab(sectorSentinel)],
    audio: { 'assets/relay.wav': new URL('../../../examples/sector/assets/relay.wav', import.meta.url) },
    title: 'SECTOR 07', subtitle: 'reach the uplink relay',
  },
  hotel: {
    scenes: [parseScene(hotelScene)], assets: parseAssetRegistry(hotelAssets).assets, prefabs: [parsePrefab(hotelPrefab)],
    audio: { 'assets/reception.wav': new URL('../../../examples/hotel-vertical-slice/assets/reception.wav', import.meta.url) },
  },
};

const container = document.getElementById('game')!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-play]'));
const stop = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('status')!;
let game: { dispose(): void } | undefined;
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
  const loadAssetBytes = async (assetId: string): Promise<Uint8Array> => {
    const asset = project.assets.find(candidate => candidate.id === assetId);
    const url = asset ? project.audio[asset.path] : undefined;
    if (!url) throw new Error(`Unsupported fixture asset ${assetId}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fixture audio failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const onRuntimeEvent = (event: { type: string; message?: string }): void => {
    if (token !== generation) return;
    if (event.type === 'fault') status.textContent = event.message ?? 'Engine fault';
  };
  try {
    const mounted = project.campaign
      ? await mountCampaign(container, {
        campaign: project.campaign, scenes: project.scenes, assets: project.assets, prefabs: project.prefabs,
        loadAssetBytes, onRuntimeEvent: event => onRuntimeEvent(event),
      })
      : await mountGame(container, {
        scene: project.scenes[0]!, assets: project.assets, prefabs: project.prefabs, loadAssetBytes,
        onRuntimeEvent: event => {
          onRuntimeEvent(event);
          if (event.type === 'goal') status.textContent = `Uplink reached in ${event.time.toFixed(1)}s — ${event.collected}/${event.total} shards.`;
          if (event.type === 'arrival') status.textContent = `Guest arrived at ${event.waypointEntityId}`;
          if (event.type === 'death') status.textContent = `Run reset (${event.reason}); ${event.deaths} deaths.`;
        },
        ...(project.title ? { title: project.title, subtitle: project.subtitle } : {}),
      });
    if (token !== generation) { mounted.dispose(); return; }
    game = mounted;
    status.textContent = project.campaign
      ? 'Rooftop Relay — menu opens in the game. Progress saves on this device.'
      : 'Playing detached scene.';
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
