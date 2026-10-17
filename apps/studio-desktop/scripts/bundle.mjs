import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../src-tauri/resources/', import.meta.url), { recursive: true });
await build({ absWorkingDir: desktop, entryPoints: ['src/node-main.ts'], outfile: 'src-tauri/resources/bridge.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'bundle' });
// Bundle the known host runtime, never resolve an executable from an opened project or PATH at runtime.
await copyFile(process.execPath, new URL('../src-tauri/resources/node.exe', import.meta.url));
