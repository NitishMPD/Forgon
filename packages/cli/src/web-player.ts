import { mountGame } from '@forgon/game-runtime/runtime';
import type { SceneDocument, AssetRegistry, PrefabDocument, ProjectManifest } from '@forgon/project-schema';

interface GameData {
  manifest: ProjectManifest;
  scenes: SceneDocument[];
  prefabs: PrefabDocument[];
  assets: AssetRegistry;
  assetUrls: Record<string, string>;
}
const container = document.getElementById('game')!;
const status = document.getElementById('status')!;
const start = document.getElementById('start') as HTMLButtonElement;
let game: Awaited<ReturnType<typeof mountGame>> | undefined;
let closed = false;
window.addEventListener('pagehide', () => { closed = true; game?.dispose(); });
const fault = (error: unknown): void => {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.hidden = false;
  start.disabled = true;
};
try {
  const response = await fetch(new URL('./game.json', document.baseURI));
  if (!response.ok) throw new Error(`Game data unavailable (${response.status})`);
  const data = await response.json() as GameData;
  const scene = data.scenes.find(scene => scene.sceneId === data.manifest.startScene);
  if (!scene) throw new Error('Start scene missing');
  document.title = data.manifest.name;
  start.disabled = false;
  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      game = await mountGame(container, {
        scene, assets: data.assets.assets, prefabs: data.prefabs,
        loadAssetBytes: async (id: string) => {
          const path = data.assetUrls[id];
          if (!path) throw new Error(`Unregistered asset ${id}`);
          const response = await fetch(new URL(path, document.baseURI));
          if (!response.ok) throw new Error(`Asset unavailable (${response.status}): ${id}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        onRuntimeEvent: event => { if (event.type === 'fault') fault(event.message); },
      });
      if (closed) { game.dispose(); return; }
      start.hidden = true;
      status.hidden = true;
    } catch (error) { fault(error); }
  }, { once: true });
} catch (error) { fault(error); }
