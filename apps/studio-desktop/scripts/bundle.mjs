import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const bundledNode = fileURLToPath(new URL('../src-tauri/resources/node.exe', import.meta.url));

// Use agent-service's own T3 Node rule so the bundled runtime can never drift from what the service accepts.
const check = await build({ absWorkingDir: desktop, stdin: { contents: "export { satisfiesT3Node, describeT3NodeRequirement } from '@forgon/agent-service';", resolveDir: desktop }, bundle: true, platform: 'node', format: 'esm', write: false });
const { satisfiesT3Node, describeT3NodeRequirement } = await import(`data:text/javascript;base64,${Buffer.from(check.outputFiles[0].text).toString('base64')}`);

await mkdir(new URL('../src-tauri/resources/', import.meta.url), { recursive: true });
await build({ absWorkingDir: desktop, entryPoints: ['src/node-main.ts'], outfile: 'src-tauri/resources/bridge.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'bundle' });

// Bundle the known host runtime, never resolve an executable from an opened project or PATH at runtime.
let current;
try { current = execFileSync(bundledNode, ['--version'], { encoding: 'utf8' }).trim(); } catch { current = undefined; }
if (satisfiesT3Node(process.version)) {
  // Skip an identical runtime: a running app holds node.exe open, so copying over it fails with EBUSY.
  if (current !== process.version) await copyFile(process.execPath, bundledNode);
} else if (current !== undefined && satisfiesT3Node(current)) {
  // Never downgrade a compatible bundled runtime to an incompatible host one.
  console.warn(`Keeping bundled Node ${current}; host Node ${process.version} does not meet T3's requirement.`);
} else {
  throw new Error(`No compatible Node to bundle (host ${process.version}, bundled ${current ?? 'none'}): ${describeT3NodeRequirement()} Run this script with a compatible node.exe.`);
}
