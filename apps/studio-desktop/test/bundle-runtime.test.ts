import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('bridge ESM banner lets the bundled TypeScript CommonJS module initialize', async () => {
  const script = await readFile(new URL('../scripts/bundle.mjs', import.meta.url), 'utf8');
  const banner = /banner: \{ js: ("[^\n]*") \}/.exec(script)?.[1];
  assert.ok(banner, 'Use the actual bridge banner, without running a build');
  const require = createRequire(new URL('../../../packages/project-io/package.json', import.meta.url));
  const compiler = await readFile(require.resolve('typescript'), 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'forgon-bundle-runtime-'));
  try {
    const entry = join(root, 'bridge.mjs');
    // esbuild wraps TypeScript in a CommonJS closure inside the ESM bundle.
    await writeFile(entry, `${JSON.parse(banner)}\nconst module = { exports: {} };\n(function(module, exports) {\n${compiler}\n})(module, module.exports);\nconst ts = module.exports;\nif (!ts.sys || ts.createSourceFile('test.ts', 'const n = 1;', ts.ScriptTarget.Latest).parseDiagnostics.length) throw new Error('Compiler failed to initialize');\nconsole.log('compiler ready');`);
    const result = await promisify(execFile)(process.execPath, [entry], { windowsHide: true, timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
    assert.equal(result.stdout.trim(), 'compiler ready');
  } finally { await rm(root, { recursive: true, force: true }); }
});
