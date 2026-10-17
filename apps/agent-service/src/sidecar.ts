/**
 * Managed lifecycle for the pinned T3 sidecar process.
 *
 * Forgon starts one T3 server per service instance, on a loopback port, against an isolated state
 * directory, and owns its child process. The spawn contract is transcribed from the audited
 * desktop supervisor (apps/desktop/src/backend/DesktopBackendConfiguration.ts and
 * apps/server/src/cli/config.ts at the pinned revision, see LICENSES/t3code.txt):
 *
 *   node <entryPath> --mode desktop --host <host> --port <n> --base-dir <isolated>
 *        --no-browser --bootstrap-fd 0
 *
 * then one `DesktopBackendBootstrap` JSON line on stdin. `--bootstrap-fd 0` (stdin) is upstream's
 * own WSL delivery path and avoids fd-3 juggling; the primary desktop uses fd 3 for the same
 * envelope. Everything is injectable (`spawn`, `fetch`, `sleep`) so tests exercise the lifecycle
 * without a real artifact.
 *
 * Shutdown kills only the PID captured at spawn. Nothing here searches for a process by name or
 * port; a name/pattern match could hit an unrelated server (upstream `AGENTS.md` rule 1).
 */
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentBridgeError } from '@forgon/agent-bridge';
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
  executionEnvironmentDescriptorSchema,
  type ExecutionEnvironmentDescriptor,
  type T3DesktopBootstrap,
  protocolVersionMismatch,
  redactSecrets,
} from '@forgon/agent-bridge';
import { assertIsolatedHome } from './isolatedHome.js';
import { assertCompatibleT3Node } from './config-runtime.js';
import {
  assertServerVersion,
  verifyArtifact,
  type ArtifactIo,
  type ArtifactVerification,
  type T3Artifact,
} from './artifact.js';

/** Minimal child-process surface the manager needs; `node:child_process` satisfies it. */
export interface SidecarChildProcess {
  readonly pid: number | undefined;
  readonly stdin: { end(chunk?: string): void } | null;
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => SidecarChildProcess;

export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args as string[], options) as unknown as SidecarChildProcess;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Drop every T3/Vite environment variable so an inherited shell cannot redirect the child. */
export const sanitizeSidecarEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('T3CODE_') || key.startsWith('VITE_')) continue;
    out[key] = value;
  }
  return out;
};

export const buildBootstrapEnvelope = (input: {
  readonly port: number;
  readonly host: string;
  readonly homeDir: string;
  readonly token: string;
}): T3DesktopBootstrap => ({
  mode: 'desktop',
  noBrowser: true,
  port: input.port,
  t3Home: input.homeDir,
  host: input.host,
  desktopBootstrapToken: input.token,
  // Forgon never exposes the sidecar over the tailnet; the flag must still be a boolean.
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
});

export const buildSidecarArgs = (input: {
  readonly entryPath: string;
  readonly homeDir: string;
  readonly host: string;
  readonly port: number;
}): string[] => [
  input.entryPath,
  '--mode',
  'desktop',
  '--host',
  input.host,
  '--port',
  String(input.port),
  '--base-dir',
  input.homeDir,
  '--no-browser',
  '--bootstrap-fd',
  '0',
];

/** `executable` SEA binaries run directly; a script runs under Node. */
export const buildSidecarCommand = (input: {
  readonly artifact: ArtifactVerification;
  readonly nodePath?: string;
  readonly homeDir: string;
  readonly host: string;
  readonly port: number;
}): { command: string; args: string[] } => {
  const args = buildSidecarArgs({
    entryPath: input.artifact.entryPath,
    homeDir: input.homeDir,
    host: input.host,
    port: input.port,
  });
  if (input.artifact.kind === 'executable') {
    const [entryPath, ...rest] = args;
    return { command: entryPath as string, args: rest };
  }
  return { command: input.nodePath ?? process.execPath, args };
};

export interface SidecarExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** True when the server refused to start because another process owns the state directory. */
  readonly stateDirOwned: boolean;
}

export interface Sidecar {
  readonly pid: number | undefined;
  readonly origin: string;
  readonly homeDir: string;
  /** One-time bootstrap token. Hand to `connectT3`; never log it. */
  readonly bootstrapToken: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly artifact: ArtifactVerification;
  /** Resolves when the child exits (or immediately after `stop` triggers the exit). */
  readonly exited: Promise<SidecarExit>;
  /** Kill the captured PID only. Safe to call once; repeat calls are no-ops. */
  stop(): void;
}

export interface StartSidecarOptions {
  readonly artifact: T3Artifact;
  readonly homeDir: string;
  readonly liveHomeDir?: string;
  readonly port: number;
  readonly host?: string;
  readonly nodePath?: string;
  /**
   * Version of the Node that will run a `node-script` artifact, when that runtime is this very
   * executable (the case `startSidecar` can check without spawning). Injectable so the refusal is
   * testable without launching anything; defaults to `process.versions.node`.
   */
  readonly nodeVersion?: () => string;
  readonly bootstrapToken?: string;
  readonly clientLabel?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnFn;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly readinessTimeoutMs?: number;
  readonly readinessIntervalMs?: number;
  readonly artifactIo?: ArtifactIo;
  readonly prepareHomeDir?: (dir: string) => Promise<void>;
  /** Receives each stdout/stderr line, already redacted. */
  readonly onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_INTERVAL_MS = 250;

const sidecarUnavailable = (detail: string): AgentBridgeError =>
  new AgentBridgeError('sidecar_unavailable', 'The managed T3 sidecar could not be started.', {
    detail,
  });

/**
 * True when `nodePath` names this very Node executable (or was left unset, which defaults to it).
 * Both sides are resolved so `.`/`..` do not matter; Windows comparison is case-insensitive.
 */
const sameNodeExecutable = (nodePath: string | undefined): boolean => {
  if (nodePath === undefined) return true;
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(nodePath) === normalize(process.execPath);
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const randomToken = (): string => randomBytes(32).toString('base64url');

const advertiseHost = (host: string): string =>
  host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;

const wireLogging = (
  child: SidecarChildProcess,
  onLog: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined,
): void => {
  if (onLog === undefined) return;
  const attach = (stream: 'stdout' | 'stderr', readable: SidecarChildProcess['stdout']): void => {
    readable?.on('data', (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) onLog(redactSecrets(line), stream);
      }
    });
  };
  attach('stdout', child.stdout);
  attach('stderr', child.stderr);
};

/** Poll the environment descriptor until protocol v2 is advertised, or the deadline passes. */
const waitForReadiness = async (input: {
  readonly origin: string;
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly exited: () => SidecarExit | undefined;
}): Promise<ExecutionEnvironmentDescriptor> => {
  const deadline = input.now() + input.timeoutMs;
  let lastDetail = 'no descriptor was returned yet';
  for (;;) {
    const exit = input.exited();
    if (exit !== undefined) {
      throw exit.stateDirOwned
        ? sidecarUnavailable(
            `The sidecar exited with code ${SERVER_EXIT_CODE_STATE_DIR_OWNED}: another process already owns the state directory. Do not restart on the same home.`,
          )
        : sidecarUnavailable(
            `The sidecar exited before becoming ready (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'}).`,
          );
    }
    try {
      const response = await input.fetch(new URL('/.well-known/t3/environment', input.origin).toString());
      if (response.ok) {
        const parsed = executionEnvironmentDescriptorSchema.safeParse(await response.json());
        if (parsed.success) {
          if (parsed.data.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
            return parsed.data;
          }
          throw protocolVersionMismatch(
            ORCHESTRATION_PROTOCOL_VERSION,
            parsed.data.orchestrationProtocolVersion,
          );
        }
        lastDetail = `descriptor failed validation: ${parsed.error.message}`;
      } else {
        lastDetail = `descriptor request returned HTTP ${response.status}`;
      }
    } catch (cause) {
      if (cause instanceof AgentBridgeError && cause.code === 'protocol_version_mismatch') throw cause;
      lastDetail = cause instanceof Error ? cause.message : String(cause);
    }
    if (input.now() >= deadline) {
      throw sidecarUnavailable(`Timed out waiting for the sidecar descriptor: ${redactSecrets(lastDetail)}`);
    }
    await input.sleep(input.intervalMs);
  }
};

/**
 * Verify the artifact, spawn the isolated server, deliver the bootstrap envelope, and wait until
 * it advertises protocol v2. Any failure kills the captured child before rejecting, so a failed
 * start never leaves a stray process behind.
 */
export const startSidecar = async (options: StartSidecarOptions): Promise<Sidecar> => {
  const artifact = await verifyArtifact(options.artifact, options.artifactIo);
  const { homeDir } = assertIsolatedHome({
    homeDir: options.homeDir,
    ...(options.liveHomeDir === undefined ? {} : { liveHomeDir: options.liveHomeDir }),
  });

  // A `node-script` artifact runs under Node. When that runtime is this very executable we already
  // know its version — `process.versions.node` — so refuse an incompatible one before creating any
  // state or spawning. An injected `spawn` is the caller's own launch seam (tests, alternate
  // launchers) and is left untouched; a nodePath we cannot identify is not probed here.
  if (options.spawn === undefined && artifact.kind === 'node-script' && sameNodeExecutable(options.nodePath)) {
    assertCompatibleT3Node(
      (options.nodeVersion ?? (() => process.versions.node))(),
      options.nodePath ?? process.execPath,
    );
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port;
  const token = options.bootstrapToken ?? randomToken();
  const prepareHomeDir =
    options.prepareHomeDir ?? ((dir: string) => mkdir(dir, { recursive: true }).then(() => undefined));
  await prepareHomeDir(homeDir);

  const { command, args } = buildSidecarCommand({
    artifact,
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
    homeDir,
    host,
    port,
  });

  const spawnFn = options.spawn ?? defaultSpawn;
  const child = spawnFn(command, args, {
    cwd: homeDir,
    env: sanitizeSidecarEnv(options.env ?? process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  wireLogging(child, options.onLog);

  let exitInfo: SidecarExit | undefined;
  let resolveExited: (info: SidecarExit) => void = () => undefined;
  const exited = new Promise<SidecarExit>((resolve) => {
    resolveExited = resolve;
  });
  const settleExit = (info: SidecarExit): void => {
    if (exitInfo !== undefined) return;
    exitInfo = info;
    resolveExited(info);
  };
  child.once('exit', (code, signal) =>
    settleExit({ code, signal, stateDirOwned: code === SERVER_EXIT_CODE_STATE_DIR_OWNED }),
  );
  child.once('error', (error) => {
    settleExit({ code: null, signal: null, stateDirOwned: false });
    options.onLog?.(`sidecar process error: ${redactSecrets(error.message)}`, 'stderr');
  });

  const envelope = buildBootstrapEnvelope({ port, host, homeDir, token });
  try {
    child.stdin?.end(`${JSON.stringify(envelope)}\n`);
  } catch (cause) {
    child.kill();
    throw sidecarUnavailable(
      `Failed to deliver the bootstrap envelope: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const origin = `http://${advertiseHost(host)}:${port}`;
  let descriptor: ExecutionEnvironmentDescriptor;
  try {
    descriptor = await waitForReadiness({
      origin,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? (() => Date.now()),
      timeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      intervalMs: options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
      exited: () => exitInfo,
    });
    // Checked here, inside the same guard as readiness, so a version mismatch also kills the
    // captured child. A failed start must never leave a stray provider server running.
    assertServerVersion(options.artifact.expectedServerVersion, descriptor.serverVersion);
  } catch (error) {
    child.kill();
    throw error;
  }

  let stopped = false;
  return {
    pid: child.pid,
    origin,
    homeDir,
    bootstrapToken: token,
    descriptor,
    artifact,
    exited,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        child.kill();
      } catch {
        // The process may already be gone; `exited` reports the real outcome.
      }
    },
  };
};
