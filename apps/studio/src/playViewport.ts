import type { ViewportMount } from '@forgon/editor-ui';
import { mountEditorViewport } from '@forgon/game-runtime/editor-viewport';
import { validatePlayableScene } from '@forgon/game-runtime/runtime';
import { validateScriptsForPlay } from './scripts.js';

/** Project code runs only in an opaque-origin iframe, with a port granting catalog asset reads. */
export const mountStudioViewport: ViewportMount = (container, callbacks, options) => {
  const editor = mountEditorViewport(container, callbacks, options);
  let release: (() => void) | null = null;
  let disposed = false;
  return {
    ...editor,
    async playCompiled(scene, catalog, signal) {
      signal.throwIfAborted();
      if (disposed) throw new Error('Viewport is closed');
      release?.();
      editor.interruptProgressiveDesign?.();
      const assets = structuredClone([...(options?.context?.assets ?? [])]);
      const prefabs = structuredClone([...(options?.context?.prefabs ?? [])]);
      const snapshot = validatePlayableScene(scene, { assets, prefabs });
      validateScriptsForPlay(snapshot, catalog);
      const preview = createIsolatedPreview(container, { scene: snapshot, catalog, assets, prefabs,
        readAsset: options?.loadAssetBytes, onFault: message => callbacks.onFault(`Play: ${message}`), signal });
      release = preview.dispose;
      await preview.ready;
    },
    stop() { release?.(); editor.stop?.(); },
    dispose() { disposed = true; release?.(); editor.dispose(); },
  };
};

export function createIsolatedPreview(container: HTMLElement, input: {
  scene: import('@forgon/project-schema').SceneDocument;
  catalog: import('@forgon/project-schema').ScriptCatalog;
  assets: import('@forgon/project-schema').AssetRecord[];
  prefabs: import('@forgon/project-schema').PrefabDocument[];
  readAsset?: ((assetId: string) => Promise<Uint8Array | null>) | undefined;
  onFault(message: string): void;
  signal: AbortSignal;
}): { ready: Promise<void>; dispose(): void } {
  const { scene: snapshot, catalog, assets, prefabs, readAsset, onFault, signal } = input;
  signal.throwIfAborted();
  let dispose = (): void => {};
  const allowedAssets = new Set(assets.map(asset => asset.id));
  const iframe = document.createElement('iframe');
  iframe.title = 'Game preview';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('allow', 'autoplay');
  iframe.className = 'fg-play-preview';
  iframe.src = new URL('play.html', window.location.href).href;
  const channel = new MessageChannel();
  let stopped = false;
  let loading = true;
  let pendingAssets = 0;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error('Game preview did not start within 30 seconds. Check Console.')), 30_000);
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      channel.port1.close(); channel.port2.close(); iframe.remove();
      if (loading) reject(new DOMException('Play cancelled', 'AbortError'));
    };
    const fail = (error: Error): void => { loading = false; cleanup(); reject(error); };
    const abort = (): void => cleanup();
    dispose = cleanup;
    signal.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = event => {
      if (stopped) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (message['type'] === 'ready') {
        loading = false; clearTimeout(timeout); resolve(); iframe.focus();
      } else if (message['type'] === 'fault' && typeof message['message'] === 'string') {
        const text = message['message'].slice(0, 4000);
        if (loading) fail(new Error(text)); else onFault(text);
      } else if (message['type'] === 'stop') {
        iframe.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
      } else if (message['type'] === 'asset' && typeof message['assetId'] === 'string'
        && typeof message['id'] === 'number' && Number.isSafeInteger(message['id'])) {
        const { assetId, id } = message;
        if (!allowedAssets.has(assetId) || pendingAssets >= 32) {
          channel.port1.postMessage({ type: 'asset', id, error: 'Asset is unavailable in this Play snapshot' });
          return;
        }
        pendingAssets++;
        Promise.resolve().then(() => readAsset?.(assetId) ?? null).then(
          bytes => { if (!stopped) channel.port1.postMessage({ type: 'asset', id, bytes }); },
          error => { if (!stopped) channel.port1.postMessage({ type: 'asset', id, error: String(error).slice(0, 1000) }); },
        ).finally(() => { pendingAssets--; });
      }
    };
    iframe.onload = () => {
      if (stopped) return;
      iframe.onload = null;
      iframe.contentWindow?.postMessage({ type: 'forgon-play', scene: snapshot, catalog, assets, prefabs }, '*', [channel.port2]);
    };
    iframe.onerror = () => fail(new Error('Could not load the isolated game preview'));
    container.appendChild(iframe);
  });
  return { ready, dispose: () => dispose() };
}
