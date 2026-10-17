import { mountCampaign, mountGame } from '@forgon/game-runtime/runtime';
import type { AssetRegistry, CampaignDocument, PrefabDocument, ProjectManifest, SceneDocument } from '@forgon/project-schema';

interface GameData {
  manifest: ProjectManifest;
  scenes: SceneDocument[];
  prefabs: PrefabDocument[];
  assets: AssetRegistry;
  assetUrls: Record<string, string>;
  campaign?: CampaignDocument;
}
const container = document.getElementById('game')!;
const status = document.getElementById('status')!;
const start = document.getElementById('start') as HTMLButtonElement;
let game: Awaited<ReturnType<typeof mountGame>> | undefined;
let campaign: Awaited<ReturnType<typeof mountCampaign>> | undefined;
let closed = false;
window.addEventListener('pagehide', () => { closed = true; game?.dispose(); campaign?.dispose(); });
const fault = (error: unknown): void => {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.hidden = false;
  start.disabled = true;
};
try {
  const response = await fetch(new URL('./game.json', document.baseURI));
  if (!response.ok) throw new Error(`Game data unavailable (${response.status})`);
  const data = await response.json() as GameData;
  const loadAssetBytes = async (id: string): Promise<Uint8Array> => {
    const path = data.assetUrls[id];
    if (!path) throw new Error(`Unregistered asset ${id}`);
    const asset = await fetch(new URL(path, document.baseURI));
    if (!asset.ok) throw new Error(`Asset unavailable (${asset.status}): ${id}`);
    return new Uint8Array(await asset.arrayBuffer());
  };
  document.title = data.campaign?.title ?? data.manifest.name;
  if (data.campaign) {
    // A campaign owns its own menu; the shell's Play button supplies the audio gesture.
    start.hidden = true;
    status.textContent = 'Opening campaign…';
    const handle = await mountCampaign(container, {
      campaign: data.campaign, scenes: data.scenes, prefabs: data.prefabs, assets: data.assets.assets, loadAssetBytes,
    });
    if (closed) { handle.dispose(); } else { campaign = handle; status.hidden = true; }
  } else {
    const scene = data.scenes.find(candidate => candidate.sceneId === data.manifest.startScene);
    if (!scene) throw new Error('Start scene missing');
    start.disabled = false;
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        game = await mountGame(container, {
          scene, assets: data.assets.assets, prefabs: data.prefabs, loadAssetBytes,
          onRuntimeEvent: event => { if (event.type === 'fault') fault(event.message); },
        });
        if (closed) { game.dispose(); return; }
        start.hidden = true;
        status.hidden = true;
      } catch (error) { fault(error); }
    }, { once: true });
  }
} catch (error) { fault(error); }
