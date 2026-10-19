import type { AssetRecord, PrefabDocument, SceneDocument, ScriptCatalog } from '@forgon/project-schema';
import { mountGame } from '@forgon/game-runtime/runtime';
import { prepareScriptsForPlay, validateScriptsForPlay } from './scripts.js';

// No desktop client, editor state, project host or agent service is imported into this entry point.
window.addEventListener('message', async function initialize(event: MessageEvent) {
  if (event.source !== parent || event.data?.type !== 'forgon-play' || event.ports.length !== 1) return;
  window.removeEventListener('message', initialize);
  const port = event.ports[0]!;
  const input = event.data as { scene: SceneDocument; catalog: ScriptCatalog; assets: AssetRecord[]; prefabs: PrefabDocument[] };
  const requests = new Map<number, { resolve(bytes: Uint8Array | null): void; reject(error: Error): void }>();
  let sequence = 0;
  port.onmessage = event => {
    const message = event.data;
    if (message?.type !== 'asset') return;
    const pending = requests.get(message.id); if (!pending) return;
    requests.delete(message.id);
    if (typeof message.error === 'string') pending.reject(new Error(message.error));
    else pending.resolve(message.bytes instanceof Uint8Array ? message.bytes : null);
  };
  const fault = (message: string): void => port.postMessage({ type: 'fault', message });
  window.addEventListener('error', event => fault(event.message));
  window.addEventListener('unhandledrejection', event => fault(String(event.reason)));
  window.addEventListener('keydown', event => {
    if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p')) {
      event.preventDefault(); port.postMessage({ type: 'stop' });
    }
  });
  try {
    validateScriptsForPlay(input.scene, input.catalog);
    const scripts = await prepareScriptsForPlay(input.catalog);
    const game = await mountGame(document.getElementById('game')!, {
      ...input, scripts,
      loadAssetBytes: assetId => new Promise((resolve, reject) => {
        if (requests.size >= 32) { reject(new Error('Too many pending asset reads')); return; }
        const id = ++sequence; requests.set(id, { resolve, reject }); port.postMessage({ type: 'asset', id, assetId });
      }),
      onRuntimeEvent: event => { if (event.type === 'fault') fault(event.message); },
    });
    window.addEventListener('pagehide', () => { game.dispose(); port.close(); }, { once: true });
    document.querySelector('canvas')?.focus();
    port.postMessage({ type: 'ready' });
  } catch (error) { fault(String(error)); }
});
