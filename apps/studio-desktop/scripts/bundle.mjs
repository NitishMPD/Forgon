import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const bundledNode = fileURLToPath(new URL('../src-tauri/resources/node.exe', import.meta.url));

// Use agent-service's own T3 Node rule so the bundled runtime can never drift from what the service accepts.
const check = await build({ absWorkingDir: desktop, stdin: { contents: "export { satisfiesT3Node, describeT3NodeRequirement } from '@forgon/agent-service';", resolveDir: desktop }, bundle: true, platform: 'node', format: 'esm', write: false });
const { satisfiesT3Node, describeT3NodeRequirement } = await import(`data:text/javascript;base64,${Buffer.from(check.outputFiles[0].text).toString('base64')}`);

await mkdir(new URL('../src-tauri/resources/', import.meta.url), { recursive: true });
await build({ absWorkingDir: desktop, entryPoints: ['src/node-main.ts'], outfile: 'src-tauri/resources/bridge.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'bundle', external: ['esbuild'], banner: { js: "import { createRequire } from 'node:module'; import { fileURLToPath as bridgeFileURLToPath } from 'node:url'; import { dirname as bridgeDirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = bridgeFileURLToPath(import.meta.url); const __dirname = bridgeDirname(__filename);" } });

// esbuild locates its native executable relative to its own package; keep that package layout.
const compilerRequire = createRequire(new URL('../../../packages/project-io/package.json', import.meta.url));
const esbuildRoot = dirname(compilerRequire.resolve('esbuild/package.json'));
const esbuildRequire = createRequire(join(esbuildRoot, 'package.json'));
const binary = esbuildRequire.resolve('@esbuild/win32-x64/esbuild.exe');
const resources = fileURLToPath(new URL('../src-tauri/resources/', import.meta.url));
for (const [source, relative] of [
  [join(esbuildRoot, 'package.json'), 'node_modules/esbuild/package.json'],
  [join(esbuildRoot, 'lib/main.js'), 'node_modules/esbuild/lib/main.js'],
  [binary, 'node_modules/@esbuild/win32-x64/esbuild.exe'],
  [esbuildRequire.resolve('@esbuild/win32-x64/package.json'), 'node_modules/@esbuild/win32-x64/package.json'],
]) {
  const destination = join(resources, relative);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

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
