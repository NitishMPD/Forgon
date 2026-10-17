import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { compileProjectScripts, extractScriptProps } from '../src/scripting.js';

const imports = `import { defineScript, prop } from '@forgon/game-runtime/scripting';\n`;
async function project(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'forgon-scripts-'));
  try {
    for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('property extraction reads every literal kind and aliases without executing project code', () => {
  const text = `import { defineScript as script, prop as p } from '@forgon/game-runtime/scripting';
    throw new Error('must not execute');
    export default script({ props: {
      speed: p.number(90, {min: -20, max: 200, step: 0.5}), enabled: p.boolean(true),
      title: p.string('Runner'), tint: p.color([1, 0.5, 0]), offset: p.vec3([0, -1, 2] as const),
      target: p.entity(), mode: p.enum('walk', ['walk', 'run']),
    }, start() { throw new Error('also never executes'); } });`;
  const props = extractScriptProps(text)!;
  assert.deepEqual(props.speed, { type: 'number', default: 90, min: -20, max: 200, step: 0.5 });
  assert.equal(props.target!.default, null);
  assert.deepEqual(props.offset!.default, [0, -1, 2]);
  assert.equal(Object.keys(props).length, 7);
  for (const props of ['{ speed: prop.number(compute()) }', '{ ...other }', '{ speed: prop.number(1, { min: 5 }) }', '{ speed: prop.number(1, { default: 3 }) }', '{ speed: prop.number(1), speed: prop.number(2) }']) assert.throws(() => extractScriptProps(`${imports}export default defineScript({ props: ${props} });`));
  assert.equal(extractScriptProps('export const helper = 1;'), null);
});
test('compilation bundles contained helpers and exports a deferred loader with runtime-provided modules', async () => {
  await project({
    'scripts/main.ts': `${imports}import factor from './helper.js'; import { Marker } from 'three';\nthrowIfExecuted();\nexport default defineScript({props: { speed: prop.number(3) }, update(ctx, dt) {ctx.entity.value = new Marker(factor * dt);}});`,
    'scripts/helper.ts': 'export default 2;',
  }, async root => {
    const catalog = await compileProjectScripts(root);
    assert.deepEqual(catalog.diagnostics, []);
    assert.equal(catalog.scripts.length, 1);
    const compiled = await import(`data:text/javascript;base64,${Buffer.from(catalog.scripts[0]!.code).toString('base64')}`);
    assert.equal(typeof compiled.load, 'function', 'importing generated ESM does not yet run project code');
    assert.throws(() => compiled.load({}), /Unsupported script module/);
  });
});
test('successful compilation executes only on explicit module load and uses injected dependency identity', async () => {
  await project({ 'scripts/main.ts': `${imports}import { Marker } from 'three'; export default defineScript({props: { speed: prop.number(3) }, start(ctx) { ctx.entity.value = new Marker(); }});` }, async root => {
    const catalog = await compileProjectScripts(root);
    assert.deepEqual(catalog.diagnostics, []);
    const compiled = await import(`data:text/javascript;base64,${Buffer.from(catalog.scripts[0]!.code).toString('base64')}`);
    class Marker {}
    const module = compiled.load({ three: { Marker }, '@forgon/game-runtime/scripting': { defineScript: (value: unknown) => value, prop: { number: (value: number) => ({ type: 'number', default: value }) } } });
    const entity: { value: unknown } = { value: null }; module.default.start({ entity });
    assert.ok(entity.value instanceof Marker);
  });
});
test('syntax and static-property errors become file/line/column diagnostics', async () => {
  await project({ 'scripts/broken.ts': `${imports}export default defineScript({ props: {}, update( { });` }, async root => {
    const result = await compileProjectScripts(root);
    assert.equal(result.scripts.length, 0);
    assert.ok(result.diagnostics.length);
    assert.equal(result.diagnostics[0]!.line, 2);
    assert.ok(result.diagnostics[0]!.column! > 0);
    assert.match(result.diagnostics[0]!.path, /scripts\/broken.ts/);
  });
});
test('resolver rejects external packages, traversal, require and dynamic import without evaluating code', async () => {
  for (const statement of ["import fs from 'node:fs';", "import x from '../../outside.ts';", "import x from 'some-package';", "const x = require('three');", "const x = import('three');"]) {
    await project({ 'scripts/main.ts': `${imports}${statement}\nexport default defineScript({props: {}});` }, async root => {
      const catalog = await compileProjectScripts(root);
      assert.ok(catalog.diagnostics.length, statement);
      assert.equal(catalog.scripts.length, 0);
    });
  }
});
test('missing scripts directory is empty and symlink escapes are rejected', async () => {
  await project({}, async root => {
    assert.deepEqual(await compileProjectScripts(root), { scripts: [], diagnostics: [] });
    const outside = await mkdtemp(join(tmpdir(), 'forgon-outside-'));
    try {
      await mkdir(join(root, 'scripts'));
      await symlink(outside, join(root, 'scripts', 'escape'), 'junction');
      assert.ok((await compileProjectScripts(root)).diagnostics.length);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
