/**
 * Real pinned T3 sidecar integration: descriptor → OAuth exchange → WS ticket → protocol-2 socket.
 *
 * Unlike `handshake.integration.test.ts` in `@forgon/agent-bridge` (which drives a real HTTP+WS
 * *stub*), this test spawns the **actual** `vp pack` output of the audited revision
 * (`2520821d575fb769875f67fca1b9c62784817452`) and lets `startAgentService` complete the whole
 * lifecycle against it: readiness poll, RFC 8693 bootstrap exchange, websocket ticket, and a real
 * `server.refreshProviders` round-trip over the socket.
 *
 * The artifact lives in the gitignored `.research/t3code` checkout, so the test skips with an
 * explicit, evidenced message when it is absent. It never fabricates a pass. Everything is
 * loopback, the state directory is a temp dir, and the child runs under the isolated Node pinned
 * by `FORGON_T3_NODE` (the upstream monorepo engines require `^24.13.1`).
 *
 * It **launches a server process**, so it is opt-in: it runs only when `FORGON_T3_LIVE=1` is set
 * *and* the artifact is present. A plain `pnpm test` never spawns the sidecar.
 *
 *   FORGON_T3_LIVE  set to `1` to allow the real launch           (required)
 *   FORGON_T3_DIST  absolute path to `apps/server/dist`            (defaults to the checkout)
 *   FORGON_T3_NODE  absolute path to a Node >= 24.13.1 executable  (defaults to the checkout)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashArtifactBundle, startAgentService } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const checkout = path.join(repoRoot, '.research', 't3code');

const distDir = process.env['FORGON_T3_DIST'] ?? path.join(checkout, 'apps', 'server', 'dist');
const entryPath = path.join(distDir, 'bin.mjs');
const nodePath =
  process.env['FORGON_T3_NODE'] ??
  path.join(
    checkout,
    '..',
    'tools',
    process.platform === 'win32' ? 'node-v24.13.1-win-x64' : 'node-v24.13.1-linux-x64',
    process.platform === 'win32' ? 'node.exe' : 'bin/node',
  );

const artifactAvailable = existsSync(entryPath) && existsSync(nodePath);
const live = process.env['FORGON_T3_LIVE'] === '1';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

test('real pinned T3 sidecar completes the protocol-2 handshake and provider discovery', { timeout: 180_000 }, async (t) => {
  if (!live) {
    t.skip(
      'Opt-in only: this test launches the real pinned sidecar. Set FORGON_T3_LIVE=1 (with the artifact built) to run it; see docs/research/agent-implementation.md §9.',
    );
    return;
  }
  if (!artifactAvailable) {
    t.skip(
      `No pinned T3 artifact at "${entryPath}" (or Node at "${nodePath}"). Build it from the audited checkout first; see docs/research/agent-implementation.md §9.`,
    );
    return;
  }

  const { entrySha256, bundle } = await hashArtifactBundle(entryPath);
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'forgon-t3-real-'));
  const logs: string[] = [];
  const warnings: string[] = [];
  let running: Awaited<ReturnType<typeof startAgentService>> | undefined;

  try {
    running = await startAgentService({
      artifact: { entryPath, expectedSha256: entrySha256, bundle },
      homeDir,
      port: await freePort(),
      nodePath,
      clientLabel: 'forgon-test',
      idPrefix: 'forgon-real-test',
      readinessTimeoutMs: 120_000,
      onLog: (line) => logs.push(line),
      onWarning: (message) => warnings.push(message),
    });

    // The descriptor the readiness gate read and the bridge re-read must both be protocol 2.
    assert.equal(running.sidecar.descriptor.orchestrationProtocolVersion, 2);
    assert.equal(running.connection.descriptor.orchestrationProtocolVersion, 2);
    assert.ok(running.connection.serverVersion.length > 0, 'serverVersion must be reported');
    assert.ok(running.connection.environmentId.length > 0, 'environmentId must be reported');
    // Whole-bundle provenance, not just the launcher file.
    assert.equal(running.sidecar.artifact.scope, 'bundle');
    assert.equal(running.sidecar.artifact.bundleFiles, bundle.length);

    // `listProviders` performs a real `server.refreshProviders` over the authenticated socket.
    const providers = await running.service.listProviders();
    assert.ok(Array.isArray(providers), 'provider discovery must return an array');
    for (const provider of providers) {
      assert.ok(['codex', 'opencode', 'claude-code'].includes(provider.id));
      assert.ok(Array.isArray(provider.models));
      assert.ok(provider.permissionModes.length > 0, 'a ready-capable provider must list modes');
      if (provider.readiness !== 'ready') {
        assert.ok(provider.message !== undefined, 'not-ready must carry a specific reason');
      }
    }

    // The renderer-facing snapshot is plain data reconstructed from the same service.
    const connection = running.service.connection();
    assert.equal(connection.providers.length, providers.length);
    assert.equal(connection.service, running.service);

    // Fresh isolated home: no persisted refs, and reattach is a clean no-op.
    assert.deepEqual(await running.service.threadRefs(), []);
    assert.deepEqual(await running.service.reattachPersistedThreads(), []);

    // The sidecar is reachable and reports a descriptor over loopback HTTP.
    const descriptor = await fetch(`${running.sidecar.origin}/.well-known/t3/environment`);
    assert.equal(descriptor.ok, true);
    const body = (await descriptor.json()) as { orchestrationProtocolVersion?: number };
    assert.equal(body.orchestrationProtocolVersion, 2);
  } finally {
    const pid = running?.sidecar.pid;
    if (running !== undefined) {
      await running.stop();
      const exit = await running.sidecar.exited;
      // A clean shutdown must not be the "state dir owned" refusal.
      assert.notEqual(exit.code, 78, `sidecar refused to start: ${logs.join('\n')}`);
    }
    await rm(homeDir, { recursive: true, force: true });
    // Nothing should have warned about the happy path.
    assert.deepEqual(warnings, []);
    assert.ok(pid === undefined || typeof pid === 'number');
  }
});
