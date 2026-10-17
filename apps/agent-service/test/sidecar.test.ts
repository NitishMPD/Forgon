import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isAgentBridgeError, type AgentBridgeError } from '@forgon/agent-bridge';
import {
  buildBootstrapEnvelope,
  buildSidecarArgs,
  buildSidecarCommand,
  sanitizeSidecarEnv,
  startSidecar,
  type ArtifactIo,
  type SidecarChildProcess,
  type SpawnFn,
} from '../src/index.js';

const DIGEST = 'a'.repeat(64);
const ENTRY = path.resolve('C:/forgon/t3/dist/bin.mjs');
const HOME = path.resolve('C:/forgon/state/t3');
const LIVE = path.resolve('C:/users/dev/.t3');

const artifactIo: ArtifactIo = {
  hashFile: async () => DIGEST,
  statFile: async () => ({ size: 1, isFile: true }),
};

const artifact = { entryPath: ENTRY, expectedSha256: DIGEST };
const descriptorBody = {
  environmentId: 'env-1',
  label: 'Forgon sidecar',
  platform: { os: 'windows', arch: 'x64' },
  serverVersion: '1.0.0',
  orchestrationProtocolVersion: 2,
  capabilities: {},
};
const descriptorResponse = (): Response => new Response(JSON.stringify(descriptorBody), { status: 200 });

interface FakeChild {
  readonly child: SidecarChildProcess;
  readonly stdinWrites: string[];
  isKilled(): boolean;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
  emitStdout(text: string): void;
}

const createFakeChild = (): FakeChild => {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const stdoutListeners: Array<(chunk: unknown) => void> = [];
  const stderrListeners: Array<(chunk: unknown) => void> = [];
  const stdinWrites: string[] = [];
  let killed = false;

  const child = {
    pid: 4321,
    stdin: {
      end: (chunk?: string) => {
        if (chunk !== undefined) stdinWrites.push(chunk);
      },
    },
    stdout: {
      on: (_event: 'data', listener: (chunk: unknown) => void) => {
        stdoutListeners.push(listener);
      },
    },
    stderr: {
      on: (_event: 'data', listener: (chunk: unknown) => void) => {
        stderrListeners.push(listener);
      },
    },
    kill: () => {
      killed = true;
      return true;
    },
    once: ((event: string, listener: (...args: never[]) => void) => {
      if (event === 'exit') exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      else errorListeners.push(listener as (error: Error) => void);
    }) as unknown as SidecarChildProcess['once'],
  } as SidecarChildProcess;

  return {
    child,
    stdinWrites,
    isKilled: () => killed,
    emitExit: (code, signal = null) => exitListeners.forEach((listener) => listener(code, signal)),
    emitError: (error) => errorListeners.forEach((listener) => listener(error)),
    emitStdout: (text) => stdoutListeners.forEach((listener) => listener(text)),
  };
};

/** A clock the test advances explicitly, so readiness timeouts are deterministic. */
const createClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};

const spawnSpy = (fake: FakeChild): { spawn: SpawnFn; calls: Array<{ command: string; args: readonly string[] }> } => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    return fake.child;
  };
  return { spawn, calls };
};

const baseOptions = (fake: FakeChild, fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) => {
  const clock = createClock();
  const { spawn } = spawnSpy(fake);
  return {
    artifact,
    homeDir: HOME,
    liveHomeDir: LIVE,
    port: 3777,
    bootstrapToken: 'TOKEN',
    prepareHomeDir: async () => undefined,
    artifactIo,
    env: {},
    spawn,
    fetch: fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    readinessTimeoutMs: 1_000_000,
    readinessIntervalMs: 250,
  };
};

test('buildSidecarArgs matches the audited desktop supervisor argv', () => {
  assert.deepEqual(buildSidecarArgs({ entryPath: ENTRY, homeDir: HOME, host: '127.0.0.1', port: 3777 }), [
    ENTRY,
    '--mode',
    'desktop',
    '--host',
    '127.0.0.1',
    '--port',
    '3777',
    '--base-dir',
    HOME,
    '--no-browser',
    '--bootstrap-fd',
    '0',
  ]);
});

test('buildBootstrapEnvelope points the sidecar at the isolated home and never the tailnet', () => {
  const envelope = buildBootstrapEnvelope({ port: 3777, host: '127.0.0.1', homeDir: HOME, token: 'T' });
  assert.deepEqual(envelope, {
    mode: 'desktop',
    noBrowser: true,
    port: 3777,
    t3Home: HOME,
    host: '127.0.0.1',
    desktopBootstrapToken: 'T',
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  });
});

test('buildSidecarCommand runs a script under Node and an executable directly', () => {
  const script = buildSidecarCommand({
    artifact: { entryPath: ENTRY, sha256: DIGEST, sizeBytes: 1, kind: 'node-script', scope: 'entry-file-only' },
    nodePath: 'C:/node.exe',
    homeDir: HOME,
    host: '127.0.0.1',
    port: 3777,
  });
  assert.equal(script.command, 'C:/node.exe');
  assert.equal(script.args[0], ENTRY);

  const executable = buildSidecarCommand({
    artifact: { entryPath: ENTRY, sha256: DIGEST, sizeBytes: 1, kind: 'executable', scope: 'entry-file-only' },
    homeDir: HOME,
    host: '127.0.0.1',
    port: 3777,
  });
  assert.equal(executable.command, ENTRY);
  assert.equal(executable.args[0], '--mode');
});

test('sanitizeSidecarEnv drops T3CODE_ and VITE_ variables and keeps the rest', () => {
  const sanitized = sanitizeSidecarEnv({
    PATH: '/usr/bin',
    HOME: '/home/dev',
    T3CODE_SECRET: 'x',
    VITE_API: 'y',
  });
  assert.deepEqual(sanitized, { PATH: '/usr/bin', HOME: '/home/dev' });
});

test('startSidecar verifies, spawns, delivers the envelope and waits for readiness', async () => {
  const fake = createFakeChild();
  const sidecar = await startSidecar(baseOptions(fake, async () => descriptorResponse()));

  assert.equal(sidecar.pid, 4321);
  assert.equal(sidecar.origin, 'http://127.0.0.1:3777');
  assert.equal(sidecar.homeDir, HOME);
  assert.equal(sidecar.bootstrapToken, 'TOKEN');
  assert.equal(sidecar.descriptor.serverVersion, '1.0.0');

  const first = fake.stdinWrites[0];
  assert.ok(first !== undefined);
  assert.ok(first.endsWith('\n'));
  assert.equal(JSON.parse(first)['t3Home'], HOME);
});

test('startSidecar retries readiness until the descriptor appears', async () => {
  const fake = createFakeChild();
  let attempts = 0;
  const sidecar = await startSidecar(
    baseOptions(fake, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return descriptorResponse();
    }),
  );
  assert.equal(attempts, 3);
  assert.equal(sidecar.pid, 4321);
});

test('a descriptor advertising the wrong protocol is refused and kills the child', async () => {
  const fake = createFakeChild();
  await assert.rejects(
    startSidecar(
      baseOptions(fake, async () =>
        new Response(JSON.stringify({ ...descriptorBody, orchestrationProtocolVersion: 1 }), { status: 200 }),
      ),
    ),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'protocol_version_mismatch',
  );
  assert.equal(fake.isKilled(), true);
});

test('a state-directory-owned exit (78) is reported as already owned, not retried', async () => {
  const fake = createFakeChild();
  const promise = startSidecar(
    baseOptions(fake, async () => {
      throw new Error('ECONNREFUSED');
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  fake.emitExit(78);

  await assert.rejects(promise, (error: unknown) => {
    return (
      isAgentBridgeError(error) &&
      error.code === 'sidecar_unavailable' &&
      /already owns/.test(error.detail ?? '')
    );
  });
  assert.equal(fake.isKilled(), true);
});

test('an early exit is reported instead of waiting out the timeout', async () => {
  const fake = createFakeChild();
  const promise = startSidecar(
    baseOptions(fake, async () => {
      throw new Error('ECONNREFUSED');
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  fake.emitExit(1);

  await assert.rejects(
    promise,
    (error: unknown) => isAgentBridgeError(error) && error.code === 'sidecar_unavailable',
  );
});

test('a readiness timeout is reported as sidecar_unavailable', async () => {
  const fake = createFakeChild();
  const clock = createClock();
  const { spawn } = spawnSpy(fake);
  await assert.rejects(
    startSidecar({
      artifact,
      homeDir: HOME,
      liveHomeDir: LIVE,
      port: 3777,
      prepareHomeDir: async () => undefined,
      artifactIo,
      env: {},
      spawn,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      sleep: clock.sleep,
      now: clock.now,
      readinessTimeoutMs: 500,
      readinessIntervalMs: 250,
    }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'sidecar_unavailable',
  );
  assert.equal(fake.isKilled(), true);
});

test('a running server whose version differs from the pin is refused and killed', async () => {
  const fake = createFakeChild();
  await assert.rejects(
    startSidecar({
      ...baseOptions(fake, async () => descriptorResponse()),
      artifact: { entryPath: ENTRY, expectedSha256: DIGEST, expectedServerVersion: '9.9.9' },
    }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'provenance_unverified',
  );
  assert.equal(fake.isKilled(), true);
});

test('a non-isolated home is refused before any process is spawned', async () => {
  const fake = createFakeChild();
  const { spawn, calls } = spawnSpy(fake);
  await assert.rejects(
    startSidecar({
      artifact,
      homeDir: LIVE,
      liveHomeDir: LIVE,
      port: 3777,
      prepareHomeDir: async () => undefined,
      artifactIo,
      env: {},
      spawn,
      fetch: async () => descriptorResponse(),
      ...createClock(),
    }),
    (error: unknown) => isAgentBridgeError(error) && error.code === 'containment_violation',
  );
  assert.equal(calls.length, 0);
});

test('stop kills the captured pid exactly once and exited resolves', async () => {
  const fake = createFakeChild();
  const sidecar = await startSidecar(baseOptions(fake, async () => descriptorResponse()));
  assert.equal(fake.isKilled(), false);
  sidecar.stop();
  assert.equal(fake.isKilled(), true);
  fake.emitExit(0);
  assert.deepEqual(await sidecar.exited, { code: 0, signal: null, stateDirOwned: false });
});

test('a failed start does not leave an unhandled error when the child errors', async () => {
  const fake = createFakeChild();
  const promise = startSidecar(
    baseOptions(fake, async () => {
      throw new Error('ECONNREFUSED');
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  fake.emitError(new Error('spawn failed'));
  await assert.rejects(promise, (error: unknown): error is AgentBridgeError =>
    isAgentBridgeError(error) && error.code === 'sidecar_unavailable',
  );
});

test('log lines are redacted before they reach onLog', async () => {
  const fake = createFakeChild();
  const lines: string[] = [];
  await startSidecar({
    ...baseOptions(fake, async () => descriptorResponse()),
    onLog: (line) => lines.push(line),
  });
  fake.emitStdout('ticket=SECRETVALUE\nready\n');
  assert.deepEqual(lines, ['ticket="[redacted]"', 'ready']);
});

test('startSidecar refuses an incompatible Node runtime before spawning anything', async () => {
  // No `spawn` is injected, so this is the real launch path: the runtime alone is injected as the
  // host's 24.2.0, and the preflight must refuse before it could launch a child.
  await assert.rejects(
    startSidecar({
      artifact,
      homeDir: HOME,
      liveHomeDir: LIVE,
      port: 3777,
      prepareHomeDir: async () => undefined,
      artifactIo,
      env: {},
      nodeVersion: () => '24.2.0',
      fetch: async () => descriptorResponse(),
      ...createClock(),
    }),
    (error: unknown): error is AgentBridgeError =>
      isAgentBridgeError(error) &&
      error.code === 'sidecar_unavailable' &&
      error.detail?.includes('24.2.0') === true &&
      error.detail?.includes('24.10') === true,
  );
});

test('an injected spawn is a caller-owned launch seam, so the preflight is skipped', async () => {
  const fake = createFakeChild();
  const sidecar = await startSidecar({
    ...baseOptions(fake, async () => descriptorResponse()),
    nodeVersion: () => '24.2.0',
  });
  assert.equal(sidecar.origin, 'http://127.0.0.1:3777');
});
