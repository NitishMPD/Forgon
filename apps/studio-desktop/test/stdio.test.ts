import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

test('real stdio transport preserves errors, correlates replies and exits on parent EOF', { timeout: 12000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgon-stdio-'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/node-main.ts', import.meta.url)), join(root, 'state')], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FORGON_T3_CONFIG: '' }, windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const replies = new Map<string, (value: Record<string, any>) => void>();
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  lines.on('line', line => { const value = JSON.parse(line); if (value.id) replies.get(value.id)?.(value); });
  let id = 0;
  function request(method: string, args: Record<string, unknown> = {}, native = false) {
    const key = String(++id);
    return new Promise<Record<string, any>>(resolve => {
      replies.set(key, value => { replies.delete(key); resolve(value); });
      child.stdin.write(`${JSON.stringify({ request: { v: 1, id: key, method, args }, native })}\n`);
    });
  }
  try {
    const providers = await request('agent:providers');
    assert.equal(providers.v, 1); assert.equal(providers.result[0].readiness, 'not-ready');
    const unauthorized = await request('native:grant', { root });
    assert.equal(unauthorized.error.code, 'DESKTOP_ERROR');
    const grant = await request('native:grant', { root }, true);
    const plan = await request('project:planChild', { parent: grant.result, name: 'Game' });
    const opened = await request('project:create', { root: plan.result.root });
    const session = opened.result.session.id;
    const [badPath, catalog] = await Promise.all([
      request('scene:read', { session, path: '../escape' }),
      request('catalog:read', { session }),
    ]);
    assert.equal(badPath.error.code, 'INVALID_PATH');
    assert.ok(catalog.result.manifest.projectId);
    // Leave an active watcher: EOF must still close the IO session and terminate the child.
    await request('scene:watch', { session, path: catalog.result.manifest.scenes[0].path, watch: 'watch' });
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
  } finally {
    child.kill(); lines.close(); await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed/version-mismatched stdio input closes rather than executing a request', { timeout: 8000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgon-bad-stdio-'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/node-main.ts', import.meta.url)), root], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FORGON_T3_CONFIG: '' }, windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  try {
    child.stdin.write('{"request":{"v":2,"id":"1","method":"project:example","args":{}}}\n');
    assert.equal(await exited, 0);
    assert.equal(output, '');
  } finally { child.kill(); await exited; await rm(root, { recursive: true, force: true }); }
});
