# Agent bridge and service implementation

Author: agent lane (`packages/agent-bridge`, `apps/agent-service`)
Audited upstream revision: `2520821d575fb769875f67fca1b9c62784817452` (`LICENSES/t3code.txt`)

This note is the contract for everything that consumes the agent lane: the desktop worker, the
renderer via IPC, and the studio lane that publishes `StudioServices.agent`. It lists the exact
callable interfaces, what each refusal means, and what is proven versus only prepared — including
the one thing that is **not** yet proven end to end (a live pinned T3 handshake) with the precise
remaining step.

---

## 1. Status

| Area | State |
| --- | --- |
| `packages/agent-bridge` (wire + mapping) | Implemented, typechecks, 124 tests pass |
| `apps/agent-service` (sidecar + facade) | Implemented, typechecks, 105 tests (104 pass + 1 opt-in skip) |
| Desktop config descriptor + runtime preflight | Implemented, typechecks, tested (§3.5) |
| Real T3 socket handshake | **Proven against a real HTTP+WebSocket stub** (`test/handshake.integration.test.ts`), using Node's global `fetch` and `WebSocket` |
| Pinned T3 artifact | **Built and hashed** from the audited revision with an isolated Node (§9); entry + whole-bundle digests below |
| Real pinned T3 sidecar handshake | **Prepared, not yet run** — the artifact exists and the opt-in integration test is written, but this lane is not permitted to launch app processes, so the live handshake is unproven (§9). No fake success is reported. |

Nothing here has been committed; all work is uncommitted in the workspace.

---

## 2. Packages

- `packages/agent-bridge` — protocol-v2 constants and wire schemas, the RPC/WebSocket client, the
  HTTP auth client, provider/permission maps, command builders, the stateful `ThreadEventMapper`,
  and the browser-safe IPC adapter (`agentIpc.ts`, §3.4). No `node:*` imports: it is browser-safe
  and is the home of the renderer-facing types.
- `apps/agent-service` — the managed sidecar process, isolated-home and provenance guards,
  durable thread refs, and the `AgentService` facade. This is Node-only (`node:child_process`,
  `node:fs`, `node:path`).

The rotation `agent-service → connectT3 → orchestration client → RPC session → transport` is the
only path to T3. The sidecar manager never speaks the protocol; the bridge never spawns a process.

---

## 3. Published callable interface

### 3.1 Node entry (desktop worker)

```ts
import { startAgentService, type RunningAgentService, type StartAgentServiceOptions }
  from '@forgon/agent-service';

const running: RunningAgentService = await startAgentService(options);
```

`StartAgentServiceOptions`:

```ts
interface StartAgentServiceOptions {
  artifact: T3Artifact;               // pinned entry file + expected SHA-256 (§8)
  homeDir: string;                    // isolated state dir; must be absolute and not the live ~/.t3
  liveHomeDir?: string;               // defaults to ~/.t3; only for tests/overrides
  port: number;                       // loopback port for the sidecar
  host?: string;                      // default '127.0.0.1'
  nodePath?: string;                  // default process.execPath
  clientLabel?: string;
  forgonEnforcesInspect?: boolean;    // set only when Forgon enforces read-only itself (§5)
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;                    // injectable (tests / alternate launch)
  fetch?: FetchLike;                  // injectable
  webSocketFactory?: WebSocketFactory;// injectable; defaults to the global WHATWG WebSocket
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;                 // ISO clock injection
  idPrefix?: string;
  readinessTimeoutMs?: number;        // default 30_000
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;  // already redacted
  onWarning?: (message: string) => void;
  resumeOnStart?: boolean;            // default true: reattach persisted threads at startup
}
```

`RunningAgentService`:

```ts
interface RunningAgentService {
  service: AgentServiceFacade;      // Forgon AgentService + discovery (§3.2)
  sidecar: Sidecar;                 // pid, origin, homeDir, bootstrapToken, descriptor, artifact, stop()
  connection: T3Connection;         // live protocol-v2 session (token stays internal)
  agentConnection: AgentConnection; // browser-safe snapshot for the renderer (§3.3)
  resume: readonly ResumeOutcome[]; // per-thread reattach results, when resumeOnStart ran
  stop(): Promise<void>;            // closes the service, kills the captured pid, awaits exit
}
```

`stop()` is idempotent. Kill targets only the PID captured at spawn; nothing searches by name or
port.

### 3.2 `AgentServiceFacade` (implements `AgentService`)

```ts
interface AgentServiceFacade extends AgentService {
  start(request: AgentRunRequest): Promise<{ runId: string }>;   // reuses an existing durable thread
  cancel(runId: string): Promise<void>;                          // run.interrupt only
  approve(runId: string, requestId: string, allow: boolean): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;

  // discovery
  availableProviders(): Promise<readonly ProviderId[]>;          // enabled + installed
  listProviders(): Promise<readonly AgentProviderInfo[]>;        // cached discovery
  refreshProviders(): Promise<readonly AgentProviderInfo[]>;     // forces server.refreshProviders
  connection(): AgentConnection;                                 // last snapshot + refresh
  threadRefs(): Promise<readonly ThreadRef[]>;                   // persisted refs, oldest first
  permissionModesFor(provider: ProviderId): Promise<readonly PermissionMode[]>;
  instanceIdForThread(threadId: string): string | undefined;

  // resume / reattach
  resumeThread(threadId: string): Promise<ResumeResult>;         // adopt projection + stream once
  reattachPersistedThreads(): Promise<readonly ResumeOutcome[]>; // per-thread, never throws a batch

  // diffs
  turnDiff(request: { threadId; fromTurnCount; toTurnCount; ignoreWhitespace? }): Promise<TurnDiffResult>;
  fullThreadDiff(request: { threadId; toTurnCount; ignoreWhitespace? }): Promise<TurnDiffResult>;

  // live thread controls
  setModel(request: { threadId; model }): Promise<void>;              // thread.model-selection.set
  setRuntimeMode(request: { threadId; permissionMode }): Promise<void>; // thread.runtime-mode.set
  setInteractionMode(request: { threadId; interactionMode }): Promise<void>;
  switchProvider(request: { threadId; provider; model? }): Promise<void>; // provider.switch

  close(): void;
}
```

Every diff and control call requires a **tracked** thread (`start` or `resumeThread` first); an
untracked id is refused with `run_not_found` before any command is dispatched. `TurnDiffResult`
carries the real diff text plus `paths: string[]` parsed from it (no fabricated summary), and the
same diff is folded into the thread's live event stream as a `diff` event. Controls refuse rather
than guess: changing a model on a provider that reports `requiresNewThreadForModelChange` is
`unsupported_control`, as is a runtime mode the provider does not list; a model change with no known
provider instance (`instanceIdForThread` undefined) is refused until the thread is reattached.

`createAgentService(options)` is the lower-level factory when the caller already owns a
`T3Connection` and a `ThreadRefStore` (used by `startAgentService` and by tests).

### 3.3 Browser-safe renderer contract

The renderer must **not** import `apps/agent-service/src/service.ts` (it pulls `node:path` and the
persistence layer). The browser-safe types live in `@forgon/agent-bridge` and are structurally
identical to `packages/editor-ui/src/services.ts`:

```ts
type ProviderReadiness = 'ready' | 'not-ready' | 'unknown';

interface AgentProviderInfo {
  id: ProviderId;                    // 'codex' | 'opencode' | 'claude-code'
  name: string;
  readiness: ProviderReadiness;
  message?: string;                  // present and specific whenever readiness !== 'ready'
  models: readonly string[];         // model slugs; empty means the adapter reported none
  permissionModes: readonly PermissionMode[];  // modes this connection can actually enforce
  limits?: readonly string[];        // plain-word adapter limits; absent means none reported
}

interface AgentConnection {
  service: AgentService;             // real object, or an IPC proxy with the same method names
  providers: readonly AgentProviderInfo[];
  refreshProviders?: () => Promise<readonly AgentProviderInfo[]>;
}

createAgentConnection({ service, providers, refreshProviders? }): AgentConnection;
permissionModesForConnection({ forgonEnforcesInspect? }): readonly PermissionMode[];
```

`permissionModesForConnection()` returns `['supervised','auto-edits','full-local']` by default and
only adds `inspect` when `forgonEnforcesInspect === true`. The composer and any mode picker must
render exactly the modes present in `AgentProviderInfo.permissionModes`; offering `inspect` when the
connection cannot enforce it would be the "faux security toggle" the brief forbids.

### 3.4 Desktop worker IPC shape

Functions cannot cross an IPC boundary, so the browser-safe adapter in
`packages/agent-bridge/src/agentIpc.ts` splits the seam in two:

```ts
// Renderer (browser-safe, no node:*): rebuild a live-looking AgentService from the transport.
createAgentServiceProxy(transport: AgentServiceTransport): AgentService;
createRemoteAgentConnection({ transport, providers, refreshProviders? }): AgentConnection;

// Host (Node/Tauri main): turn the real service into an IPC handler and forward its events.
createAgentServiceRpcHandler(service: AgentService): (call: unknown) => Promise<AgentServiceCallResult>;
parseAgentServiceCall(value: unknown): AgentServiceCall;   // malformed calls are protocol_shape
```

`AgentServiceTransport` is the only thing the desktop lane must implement: `call(call)` forwards one
discriminated `AgentServiceCall` (`start` / `cancel` / `approve`) and `onEvent(listener)` carries
host-forwarded events. No transport mechanism (Tauri events, Worker port, test double) is guessed
here. Failure replies are values, and the proxy rebuilds an `AgentBridgeError` with the **same code**
the host threw, so `approval_unbound` and `unsupported_permission_mode` survive the boundary instead
of degrading to a generic error; an unrecognised code degrades to a plain `Error`. `start` refuses to
report a run the host did not confirm with a `runId`.

Wiring it (the host side is the desktop lane's app code):

1. Node side: `const providers = await service.listProviders();`
2. Host exposes `createAgentServiceRpcHandler(service)` over its IPC channel and calls
   `service.subscribe(push)` to forward events to the renderer's `onEvent`.
3. Renderer: `createRemoteAgentConnection({ transport, providers, refreshProviders })`, where
   `refreshProviders` is itself an IPC call.

After a refresh, publish a **new** connection snapshot and keep the same `service`, matching the
studio note (`docs/research/studio-integration.md`). The facade now also exposes the live-thread
controls (`setModel`/`setRuntimeMode`/`setInteractionMode`/`switchProvider`, §3.2) whose command
builders live in `packages/agent-bridge`.

### 3.5 Desktop configuration descriptor (`FORGON_T3_CONFIG`)

The native host reads exactly one trusted JSON file — the path named by `FORGON_T3_CONFIG`, which
only the launch environment can set. Renderer code and project files cannot reach it. This lane
publishes the descriptor's authoritative shape and parser; the desktop Node entry now uses
`loadAgentServiceConfig` and passes its validated `{ artifact, port }` to `startAgentService`.
The shape mirrors `T3Artifact` (`apps/agent-service/src/config.ts`):

```json
{
  "port": 3777,
  "artifact": {
    "entryPath": "C:\\app-local-data\\forgon-t3\\dist\\bin.mjs",
    "expectedSha256": "<64-hex entry digest>",
    "expectedServerVersion": "<the serverVersion your T3 build reports>",
    "kind": "node-script",
    "bundle": [
      { "path": "bin.mjs", "sha256": "<64-hex>" },
      { "path": "binCli-CsDHl451.mjs", "sha256": "<64-hex>" }
    ]
  }
}
```

```ts
loadAgentServiceConfig(filePath, io?): Promise<AgentServiceConfig>  // { port, artifact }
parseAgentServiceConfig(value): AgentServiceConfig                  // already-parsed object
AGENT_SERVICE_CONFIG_MAX_BYTES = 256 * 1024
```

- The configuration path must be **absolute**; a relative path is refused rather than resolved
  against the child's cwd.
- `entryPath` must be absolute, `expectedSha256` and every bundle `sha256` must be 64-hex, `port`
  must be an integer in 1–65535, and **unknown fields are refused** (zod strict), so a mistyped key
  such as `expectedSHA256` fails loudly instead of silently dropping the pin.
- A `bundle` array, when present, must list at least one file. Supplying the full 18-file manifest
  produced by `hashArtifactBundle` (§8) is what upgrades provenance from `entry-file-only` to
  `bundle`.
- Every rejection is `AgentBridgeError` code `invalid_configuration` with a `detail` naming the bad
  field. Byte-level verification stays in `verifyArtifact`; this module only shapes and bounds the
  input, so there is one verification implementation, not two.

The abbreviated example above is for readability; a real descriptor lists all 18 packed chunks (the
entry digest and the whole-bundle digest are in §9, so a preparer can confirm they built the same
output before writing the manifest).

**Compatible runtime.** A `node-script` artifact runs under Node, and the pinned `t3` package
requires `^22.16 || ^23.11 || >=24.10` (§9). `apps/agent-service` exports the range and a pure check
so a host fails early instead of surfacing an opaque child crash:

```ts
T3_NODE_RANGE = '^22.16 || ^23.11 || >=24.10';
satisfiesT3Node(version): boolean;        // unparseable → false, never assumed compatible
assertCompatibleT3Node(version, path?);   // throws sidecar_unavailable naming version + range
describeT3NodeRequirement(): string;
```

`startSidecar` itself refuses before it does anything it cannot undo: for a `node-script` artifact
whose runtime is **this very executable** (`nodePath` unset or equal to `process.execPath`), it
checks `process.versions.node` against the range after artifact verification and the isolation
guard, and before creating a directory or spawning. An injected `spawn` is a caller-owned launch
seam and is left untouched; a `nodePath` naming some other executable is not probed, so no extra
process is started merely to discover a version.

For the desktop bundle this is load-bearing: its build copies `process.execPath` as the bundled Node
(`apps/studio-desktop/scripts/bundle.mjs` line that `copyFile(process.execPath, …node.exe)`), so the
desktop must be built **under** a Node that satisfies the range. Built under the host's `v24.2.0`,
it would ship an incompatible Node, and `startAgentService` now refuses with a message naming both
`24.2.0` and the range instead of failing somewhere inside the child. The exact isolated Node used to
build and run the pinned artifact is recorded in §9; the concrete build guidance is to make that
Node the one running the bundling script:

```powershell
# Any Node in ^22.16 || ^23.11 || >=24.10 works; the verified pin is 24.13.1.
$env:PATH = "$PWD\.research\tools\node-v24.13.1-win-x64;$env:PATH"
pnpm --filter @forgon/studio-desktop build
```

That is guidance only: this lane built no desktop bundle (the desktop's own build is the desktop
lane's, and the no-build rule applies here).

One more desktop detail: `apps/studio-desktop/src/node-main.ts` catches the start failure and shows a
fixed "Verify artifact, Node version and port configuration." message, discarding the specific
`sidecar_unavailable` detail. The refusal is still correct (no child is spawned), but if the desktop
wants the exact version diagnosis on screen it must include the error's `detail` (it is a version and
a path, not a secret) in that message.

---

## 4. Lifecycle

1. `verifyArtifact` hashes the entry file and compares it to the pinned SHA-256, and — when a
   `bundle` manifest is supplied — re-hashes every sibling chunk and returns the manifest digest
   (§8).
2. `assertIsolatedHome` refuses a home that equals, contains, or is inside `~/.t3` (§8).
3. For a `node-script` artifact whose runtime is this very executable, the Node version is checked
   against the pinned range and an incompatible runtime is refused before any state is created
   (§3.5).
4. The isolated home is created; the child is spawned with the audited argv (§7).
5. One `DesktopBackendBootstrap` JSON line is written to stdin (`--bootstrap-fd 0`).
6. `startSidecar` polls `GET /.well-known/t3/environment` until it advertises protocol 2, or the
   readiness deadline passes. Exit code `78` means another process owns the state dir: reported as
   "already owns", never retried on the same home.
7. `connectT3` re-fetches the descriptor, enforces protocol 2, exchanges the one-time bootstrap
   token (RFC 8693) for a bearer token, obtains a WebSocket ticket, and opens
   `/ws?orchestrationProtocol=2&wsTicket=<ticket>`.
8. `createAgentService` loads persisted refs and performs best-effort provider discovery.
9. When `resumeOnStart !== false`, every persisted thread is reattached (`reattachPersistedThreads`):
   its projection is adopted, its events stream once, and a per-thread failure is reported without
   failing the whole start. Any failure before step 8 kills the captured child; a failed start never
   leaves a stray process.

The access token never leaves the `connectT3` closure: `T3Connection.projects.{snapshot,create}`
own the bearer header internally, so the token cannot leak into a log or an event.

---

## 5. Provider metadata, readiness, models and permissions

- **Routing.** `codex → codex`, `opencode → opencode`, `claude-code → claudeAgent`. Any other
  provider id is refused with `unsupported_provider`; Forgon will not silently substitute a
  different adapter.
- **Readiness.** `'not-ready'` always carries a specific `message`:
  - adapter disabled/not installed → the adapter's own `unavailableReason`/`message`;
  - `auth.status === 'unauthenticated'` → `Sign in to <name> to use it.`;
  - `auth.status === 'unknown'` → `Authentication state could not be determined.`;
  - ready adapter that reported **zero models** → `not-ready`, message `The provider reported no
    models to run.`
  - `'unknown'` is reserved for a reachable adapter whose auth state is unknown.
- **Models.** `models` are the adapter-reported slugs (`ServerProviderModel.slug`), which is the id
  `ModelSelection.model` needs. `start()` uses `request.model` or the adapter's default model
  (`isDefault` first, then the first model). If an adapter reports no models and no explicit model
  is given, `start` refuses with `unsupported_provider` rather than fabricating a default.
- **Limits.** `limits` is populated only from explicit adapter facts, so far:
  `reportsContextWindow === false` → `Context window not reported by the provider.`;
  `supportsConversationRollback === false` → `Conversation rollback is not supported by this
  provider.`; `requiresNewThreadForModelChange === true` → `Changing the model requires a new
  thread.`; `usageLimits` → one plain line per reported window (`<label>: <n>% used (resets …)`), or
  an explicit "not reported / could not be read" line for `unsupported`/`probeFailed`. No
  reassurance is invented when the adapter says nothing.
- **Permission modes.** `inspect` has no T3 equivalent and is refused (`unsupported_permission_mode`)
  unless Forgon supplies its own read-only enforcer. The other three map to T3 `RuntimeMode` values:

  | Forgon | T3 `runtimeMode` | Guarantee |
  | --- | --- | --- |
  | `supervised` | `approval-required` | T3 UX gate only |
  | `auto-edits` | `auto-accept-edits` | T3 UX gate only |
  | `full-local` | `full-access` | T3 UX gate only |
  | `inspect` | *(refused)* | Forgon-enforced read-only, only with `forgonEnforcesInspect` |

  Every mapping carries a `caveat`: T3 approval is a UX gate, not a sandbox, and Forgon's cwd
  containment does not constrain arbitrary child processes. T3's `auto` runtime mode is unreachable
  from Forgon and reported as an unsupported control.

---

## 6. Event mapping (`ThreadEventMapper`)

One mapper per subscribed thread. It consumes `OrchestrationV2ThreadStreamItem` frames and emits
Forgon `AgentEvent`s.

- **Envelope.** `runId` is the T3 run id. `sequence` is **Forgon's own per-run monotonic counter**,
  not T3's per-thread `sequence` (T3's number is kept only as the reconnect cursor). `timestamp` is
  ISO UTC.
- **Text is a delta stream.** `assistant_message.text` and `proposed_plan.markdown` carry the whole
  current value, so the mapper emits only the new suffix. A snapshot primes the text baseline and
  does **not** replay history.
- **No secrets.** Every free-form string passes through `redactSecrets`. Strings are clamped to
  8 000 characters.

| T3 source | Forgon `AgentEvent` |
| --- | --- |
| `run.created` / `run.updated` non-terminal (first sight) | `started { provider }` |
| `run.updated` terminal | `completed { outcome }` (`completed→succeeded`, `cancelled→cancelled`, else `failed`) |
| `assistant_message`, `proposed_plan` | `text` (delta) |
| `reasoning` | `tool { name: 'reasoning' }` |
| `command_execution` | `tool { name: 'command' }` (+ `diagnostic` on non-zero exit) |
| `file_search` / `web_search` | `tool { name: 'file-search' \| 'web-search' }` |
| `dynamic_tool` | `tool { name: <toolName> }` |
| `todo_list` | `tool { name: 'todo-list' }` |
| `subagent` | `tool { name: 'subagent' }` |
| `checkpoint`, `checkpoint.captured` | `tool { name: 'checkpoint' }` |
| `file_change` | `diff { paths }` |
| `orchestration.getTurnDiff` / `getFullThreadDiff` | `diff { paths, diff }` (real diff text, §3.2) |
| `approval_request`, `user_input_request`, pending `runtime-request.updated` | `approval { requestId, description }` |
| `error`, `system_notice`, `run_interrupt_result` | `diagnostic` |
| unknown/newer event type | skipped; cursor still advances (no re-read) |
| malformed stream frame | `diagnostic` (never an exception) |

**Approval binding.** A request id is emitted once and held as pending. `approve(runId, requestId,
allow)` succeeds only when the id is currently pending for that run (`consumeApproval`); a stale,
guessed, or already-answered id is refused with `approval_unbound` and never reaches
`runtime-request.respond`. `allow: true` → `accept`, `allow: false` → `decline`; `acceptAlways` is
deliberately unreachable from a boolean, and `acceptForSession` is a separate explicit call.

---

## 7. Commands and wire facts

Client-dispatchable commands Forgon uses: `message.dispatch`, `run.interrupt`,
`runtime-request.respond`, `checkpoint.rollback`, `thread.model-selection.set`,
`thread.runtime-mode.set`, `thread.interaction-mode.set`, `provider.switch`. **Cancellation is
`run.interrupt`;** server-only commands such as `thread.stop` are never dispatched.

- `orchestration.launchThread` input has **no `createdBy`** — the server hardcodes it to `"user"`.
  Forgon sends `creationSource: 'web'` only. A launch with `initialMessage` creates a durable run
  synchronously and the run is present in the returned `projection.runs`; `start` refuses with
  `protocol_shape` if T3 accepted the launch but surfaced no run.
- The prompt is always delivered as `initialMessage.text` (with `attachments: []`); composer
  context is optional. `AgentContext.files` become `mention` records; scene/entity/asset ids ride in
  one `forgon-scene` record (an upstream unknown-context record, so drift degrades to "no structured
  context" instead of failing the turn).
- Sidecar argv: `node <entryPath> --mode desktop --host <host> --port <n> --base-dir <isolated>
  --no-browser --bootstrap-fd 0`, then one bootstrap JSON line on stdin.
- HTTP auth: `POST /oauth/token` (form-urlencoded RFC 8693 token exchange), then
  `POST /api/auth/websocket-ticket` (Bearer). Only `/api/orchestration/*` HTTP endpoints require
  `x-t3-orchestration-protocol: 2`; the WS upgrade requires
  `?orchestrationProtocol=2&wsTicket=<ticket>`.

---

## 8. Provenance and isolation

- **Artifact.** `T3Artifact = { entryPath, expectedSha256, expectedServerVersion?, kind?, bundle? }`.
  `verifyArtifact` requires an absolute path, a 64-hex digest, and a regular file whose bytes hash to
  that digest; anything else is `provenance_unverified`. It returns an honest `scope`:
  `entry-file-only` when no `bundle` manifest was supplied (the entry-only claim identifies the
  launcher, not every chunk it loads), or `bundle` when a manifest of sibling chunks was verified,
  with `bundleFiles` and a deterministic `bundleDigest` (`bundleManifestDigest`, SHA-256 over sorted
  `sha256␠␠path` lines). `hashArtifactBundle(entryPath)` builds that manifest for a packed output.
  Bundle entries may not escape the entry directory, must be regular files, and must match their own
  digest. Forgon never `npm install`s `t3` by name.
- **Isolated home.** `assertIsolatedHome` refuses a relative path, the filesystem root, the live
  `~/.t3`, a directory inside it, or a directory that contains it (`containment_violation`). Forgon
  never copies `~/.t3` contents: the sidecar starts with no provider credentials of its own, and a
  missing login is reported as `not-ready`.
- **Environment.** `sanitizeSidecarEnv` drops every `T3CODE_*` and `VITE_*` variable so an inherited
  shell cannot redirect the child.
- **Thread refs.** `ThreadRefStore` persists only routing keys (run/thread/project id, provider,
  instance, model, permission mode, title, createdAt). It never persists prompts, transcripts,
  provider output or tokens. `assertNoSecrets` rejects a ref that gains a secret-shaped field. Writes
  are atomic (sibling temp file + rename).

---

## 9. Real pinned artifact and handshake status

The pinned artifact **has been produced and hashed** in this workspace, using an isolated Node; the
live handshake itself is **prepared but not yet run**, because this lane may not launch app
processes. Both facts are recorded here rather than blurred into "done".

What was verified (17 October 2026):

| Check | Command | Result |
| --- | --- | --- |
| `t3` on PATH | `where.exe t3` | not found |
| global npm package | `npm root -g` + filter | no `t3*` directory |
| audited clone | `git -C .research/t3code rev-parse HEAD` | `2520821d575fb769875f67fca1b9c62784817452` (matches the pin) |
| built artifact | `.research/t3code/apps/server/dist/bin.mjs` | present, 1 793 B launcher + 17 sibling chunks (18 files) |
| entry digest | `hashArtifactBundle(...).entrySha256` | `2211993a193dc36327e010af47446f824f67dc3d234f633195e11b882eb25cac` |
| bundle digest | `hashArtifactBundle(...).bundleDigest` | `78c0660697600b0aa1daa21e47db5624ab9dc38d0e63ada3a1f4b68c2ec531ee` (18 files) |
| live T3 home | `Test-Path ~/.t3` | present (so the containment guard is load-bearing) |
| local Node | `node --version` | `v24.2.0` — below the monorepo floor |

**Node engine constraint.** Two different pins apply. The root T3 monorepo requires `engines.node`
`^24.13.1` (its `packageManager` is `pnpm@11.10.0`), and the `t3` app package requires
`^22.16 || ^23.11 || >=24.10`. The host's `v24.2.0` satisfies neither, so the artifact must be built
**and** run under a satisfying Node. This lane used an isolated, SHA-256-verified portable Node
`v24.13.1` under the gitignored `.research/tools/` — it never touched the machine-global Node or
`~/.t3`. That is a scoped local runtime, not an external blocker.

Concretely, the artifact was built and is run with `.research/tools/node-v24.13.1-win-x64/node.exe`,
whose official win-x64 zip has SHA-256
`fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279`. It is passed to
`startAgentService`/`startSidecar` as `nodePath`. The desktop bundle instead copies
`process.execPath`, so the desktop build itself must run under a satisfying Node — see §3.5 for the
preflight that refuses an incompatible runtime and for what happens if it does not.

Exact build commands (from the audited clone, under the isolated Node):

```sh
git clone https://github.com/pingdotgg/t3code <path>
git -C <path> checkout 2520821d575fb769875f67fca1b9c62784817452
pnpm -C <path> install --filter "t3..."      # upstream lockfile; no root Forgon lock/install changes
pnpm -C <path> --filter t3 run build:bundle  # = `vp pack`; ~8 s; emits apps/server/dist/bin.mjs
# `vp run --filter t3 build` also works (it wires the @t3tools/web#build dependency first).
# `pnpm --filter t3 build` does NOT: the `t3` package declares no `build` script.
```

Then produce the manifest and pass it to `startAgentService`:

```ts
const artifact = { entryPath, expectedSha256: entrySha256, bundle };  // from hashArtifactBundle
const running = await startAgentService({ artifact, homeDir, port, nodePath /* isolated Node */ });
```

**The live handshake test exists and is opt-in.**
`apps/agent-service/test/real-t3.integration.test.ts` spawns the real built artifact through
`startAgentService` and asserts the whole lifecycle (protocol-2 descriptor, RFC 8693 bootstrap
exchange, websocket ticket, a real `server.refreshProviders` round-trip, whole-bundle provenance).
Because it launches a server process, it runs only when `FORGON_T3_LIVE=1` is set *and* the artifact
is present; a plain `pnpm test` skips it and never spawns the sidecar. It has **not** been run to
completion yet under the current no-launch rule, so the live pinned handshake remains unproven —
exactly what this line says, with no simulated pass.

**What *is* proven over a real socket:** `packages/agent-bridge/test/handshake.integration.test.ts`
starts a `node:http` server that serves the real descriptor, `POST /oauth/token`,
`POST /api/auth/websocket-ticket`, and `GET /api/projects`, and performs a real RFC 6455 upgrade with
the exact `?orchestrationProtocol=2&wsTicket=` gate. `connectT3` then drives it with Node's global
`fetch` and `WebSocket`: `refreshProviders`, `getTurnDiff`, project snapshot, and the
server-originated-request arm all round-trip over the socket, and a protocol-1 descriptor is refused
before any socket opens. This exercises the real transport, framing and JSON envelopes; only the T3
server itself is stubbed.

---

## 10. Test coverage and exact results

Run:

```sh
pnpm --filter @forgon/agent-bridge typecheck && pnpm --filter @forgon/agent-bridge test
pnpm --filter @forgon/agent-service typecheck && pnpm --filter @forgon/agent-service test
```

Last run on this host:

- `@forgon/agent-bridge`: typecheck clean; **124 tests, 124 pass, 0 fail**
  (`protocol`, `rpcFraming`, `redaction`, `permissions`, `providers`, `commands`, `eventMapping`,
  `wsClient`, `connection`, `agentConnection`, `agentIpc`, `handshake.integration`).
- `@forgon/agent-service`: typecheck clean; **105 tests, 104 pass, 0 fail, 1 skipped**
  (`artifact`, `config`, `config-runtime`, `isolatedHome`, `sidecar`, `persistence`, `service`,
  `serviceControls`; the skip is the opt-in `real-t3.integration` test, which never launches under a
  plain `pnpm test`).

Coverage required by the brief and where it lives:

| Requirement | Test |
| --- | --- |
| Protocol mismatch | `connection` (unit) + `handshake.integration` (real socket) |
| Bad events / frames | `eventMapping` (malformed stream item), `rpcFraming`, `wsClient` |
| Redaction | `redaction`, `eventMapping` (text), `sidecar` (log lines) |
| Approval binding | `eventMapping` (consume once), `service` (unbound refused, replay refused) |
| Cancellation | `service` (`run.interrupt` only, untracked refused) |
| Sequence / reconnect | `eventMapping` (per-run monotonic, snapshot priming, cursor) |
| Provenance | `artifact` (digest/kind/version, bundle manifest + scope), `sidecar` (version mismatch kills the child) |
| Isolation | `isolatedHome`, `sidecar` (refused before spawn) |
| Resume / reattach | `serviceControls` (resume adopts projection, streams once, per-thread failure) |
| Diffs | `eventMapping` (`parseDiffPaths`/`applyDiff`), `serviceControls` (`turnDiff`/`fullThreadDiff`) |
| Live controls | `serviceControls` (each control dispatches its command; refusals keep their code) |
| Browser-safe IPC | `agentIpc` (call/refusal/subscribe round-trip), `agentConnection` |
| Permission intersection | `providers` (`enforceablePermissionModes`), `serviceControls` (`permissionModesFor`) |
| Desktop config descriptor | `config` (shape, strict fields, digest/port bounds, size limit, injected reader) |
| Runtime compatibility | `config-runtime` (range bounds, unparseable version), `sidecar` (refused before spawn) |

Two defects were found and fixed by these tests: `start` no longer drops the prompt when the context
is empty, and a post-readiness server-version mismatch now kills the captured child instead of
leaving a stray process.

---

## 11. Known limitations

- **The live pinned-T3 handshake is not yet proven end to end** (§9). The artifact is built and the
  opt-in integration test is written; this lane may not launch the sidecar, so it has not been run to
  completion. Everything else is exercised against real transports or injected seams, with no
  fabricated responses.
- `refreshProviders` (a live `server.refreshProviders`) is wired but has not been run against a real
  sidecar here; it is covered against the stub server and the fake connection.
- The browser-safe IPC adapter (§3.4) is complete and tested, but the renderer does not consume it
  yet. `apps/studio-desktop` now exists (desktop lane) and its Node entry calls `startAgentService`
  directly over its own stdio bridge rather than through `AgentServiceTransport`, so
  `StudioServices.agent` is still `null` in the browser-only Studio shell.
- The runtime preflight (§3.5) only knows the version of a Node that is this very executable. A
  `nodePath` naming a different binary is not probed, so an incompatible external runtime would be
  caught by T3 during launch rather than by Forgon beforehand.
- `start` resumes the conversation on an existing durable thread via `reuseExistingThread`, but a
  Forgon restart still re-derives project ids from the server snapshot rather than persisting them.
- `inspect` remains refused unless `forgonEnforcesInspect` is set; there is no Forgon-side read-only
  enforcement layer yet, so the mode is not advertised by default.

---

## 12. Licensing

See `LICENSES/t3code.txt`. Forgon copies MIT protocol constants and the license text and consumes T3
as a separately installed process; it does not vendor T3 source. `@anthropic-ai/claude-agent-sdk`
(non-SPDX, "SEE LICENSE IN README.md") and `@cursor/sdk` (non-SPDX, unused by Forgon's three
providers) live inside the sidecar, not in Forgon's workspace, and both need manual review before any
distribution that bundles them.
