import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ProjectReader, readProject } from '@forgon/project-io/node';
import { outputDestination, publishArtifact, readAssetBytes, sha256 } from './export-files.js';

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forgon game</title><style>html,body,#game{margin:0;width:100%;height:100%;overflow:hidden;background:#121722;color:#fff;font:16px system-ui}#start,#status{position:absolute;z-index:1;left:50%;top:50%;transform:translate(-50%,-50%)}#start{padding:1em 2em;font:inherit}#status{top:65%;max-width:80%;text-align:center}</style><div id="game" aria-label="Game viewport"></div><button id="start" disabled>Start game</button><p id="status" role="status">Loading game…</p><script type="module" src="./game.js"></script></html>`;

export async function buildWeb(root: string, output: string): Promise<{ status: 'built'; target: 'web'; output: string; manifestHash: string }> {
  const destination = await outputDestination(output);
  const project = await readProject(root);
  for (const scene of project.scenes) {
    for (const entity of scene.entities) for (const component of entity.components) {
      if (component.type === 'script') throw new Error(`Unsupported script component ${component.id}; safe script builds are unavailable`);
    }
  }
  const { validatePlayableScene } = await import('@forgon/game-runtime/runtime');
  for (const scene of project.scenes) validatePlayableScene(scene, { assets: project.assets.assets, prefabs: project.prefabs });
  const reader = await ProjectReader.create(root);
  const files = new Map<string, Uint8Array>();
  const assetUrls: Record<string, string> = {};
  const assets = [];
  let total = 0;
  for (const asset of project.assets.assets) {
    const path = `assets/${asset.id}/${basename(asset.path)}`;
    const bytes = await readAssetBytes(await reader.containedPath(asset.path));
    if ((total += bytes.length) > 512 * 1024 * 1024) throw new Error('Registered assets exceed 512 MiB export limit');
    files.set(path, bytes);
    assetUrls[asset.id] = `./${path.split('/').map(encodeURIComponent).join('/')}`;
    assets.push({ id: asset.id, sourcePath: asset.path, path, bytes: bytes.length, sha256: sha256(bytes), provenance: asset.provenance ?? null });
  }
  files.set('game.json', json({ manifest: project.manifest, scenes: project.scenes, prefabs: project.prefabs, assets: project.assets, assetUrls }));
  const { build } = await import('vite');
  const result = await build({
    configFile: false, envFile: false, publicDir: false, root: fileURLToPath(new URL('..', import.meta.url)),
    base: './', logLevel: 'silent',
    build: {
      write: false, minify: true, target: 'es2022', sourcemap: false,
      lib: { entry: fileURLToPath(new URL('./web-player.ts', import.meta.url)), formats: ['es'], fileName: () => 'game.js' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  for (const bundle of Array.isArray(result) ? result : [result]) {
    if (!('output' in bundle)) throw new Error('Unexpected web bundler result');
    for (const item of bundle.output) {
      if (item.type === 'chunk' && (item.imports.length || item.dynamicImports.length)) throw new Error('Standalone game contains external imports');
      if (item.type === 'chunk' && item.moduleIds.some(id => /(?:editor-viewport|editor-camera|gizmos|picking|project-io|agent-service|@tauri-apps|apps\/studio)/.test(id.replaceAll('\\', '/')))) throw new Error('Game bundle imports development studio code');
      if (files.has(item.fileName)) throw new Error(`Bundler output collides with game content: ${item.fileName}`);
      files.set(item.fileName, Buffer.from(item.type === 'chunk' ? item.code : item.source));
    }
  }
  if (!files.has('game.js')) throw new Error('Web bundler did not emit the game runtime');
  files.set('index.html', Buffer.from(html));
  const runtimeRequire = createRequire(import.meta.resolve('@forgon/game-runtime/runtime'));
  const schemaRequire = createRequire(import.meta.resolve('@forgon/project-schema'));
  files.set('licenses/playcanvas.txt', await readFile(join(dirname(dirname(runtimeRequire.resolve('playcanvas'))), 'LICENSE')));
  files.set('licenses/ammo.txt', await readFile(new URL('../../game-runtime/vendor/AMMO-LICENSE.txt', import.meta.url)));
  files.set('licenses/ammo-provenance.md', await readFile(new URL('../../game-runtime/vendor/PROVENANCE.md', import.meta.url)));
  files.set('licenses/zod.txt', await readFile(join(dirname(schemaRequire.resolve('zod')), 'LICENSE')));
  const manifest = json({ formatVersion: 1, target: 'web', projectId: project.manifest.projectId, startScene: project.manifest.startScene,
    toolchain: { exporter: '@forgon/cli@0.0.0', vite: '8.3.4', esbuild: '0.28.2', runtime: '@forgon/game-runtime@0.0.0', playcanvas: '2.23.3' },
    generator: project.authoring?.generator ?? null,
    scenes: project.scenes.map(scene => ({ id: scene.sceneId, sourcePath: project.manifest.scenes.find(ref => ref.id === scene.sceneId)!.path, sha256: sha256(json(scene)) })),
    assets, files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) });
  files.set('build-manifest.json', manifest);
  await publishArtifact(destination, files);
  return { status: 'built', target: 'web', output: destination, manifestHash: sha256(manifest) };
}
