# Desktop implementation
Author: Nitish

## Ownership and status

Implemented `apps/studio-desktop/**`, Studio's service loader and entry wiring, and its desktop workspace dependency. Root install/lockfile, project/design documents and task log remain parent-owned. Agent service/bridge and project IO implementations remain owned by their respective lanes. No branches, commits, builds, dev servers or GUI launches were performed.

The desktop implementation is concrete code, with passing Node/proxy/IO tests and connected TypeScript checks. Native compilation, window behavior, CSP execution and installer acceptance are **unverified**, not completed acceptance gates. Earlier desktop-io research proposals for Rust filesystem persistence are superseded here: there is no second Rust IO implementation.

## Runtime and public entry

`@forgon/studio-desktop` exports browser-safe `createDesktopServices(transport)`, `connectDesktop()`, `isDesktop()` and the `Transport` type. Its renderer code imports Node service contracts only as erased types. Runtime Node imports exist only in the separate Node entry and bridge.

Studio's `loadStudioServices()` retains its real viewport and browser sample services outside Tauri. Inside Tauri it awaits native adapters before rendering. Connection failure is a visible accessible startup error, not a silent sample fallback. The original `studioServices` export remains the browser/sample object.

Tauri 2 owns one studio window, native folder/file dialogs, bounded stdio forwarding, and process lifecycle. Rust launches the bundled `resources/node.exe resources/bridge.mjs <app-local-data>` with hidden Windows process creation, fixed resource paths/cwd, and no inherited NODE_OPTIONS/NODE_PATH. It never looks for Node, shell commands or project executables inside an opened project. The bundling script copies the Node executable running that script and esbuild bundles workspace Node dependencies into one ESM file.

The Node bridge owns one `createNodeProjectHost`, actual NodeProjectSession objects, watcher removers, recent-project metadata and optional `startAgentService`. Filesystem parsing, validation, generated overrides, save revisions, journal recovery, watch polling and import validation remain in project-io/asset-pipeline. Opening a project executes no project hooks, scripts or generators.

## Session and IO boundary

Protocol 1 uses NDJSON on private child stdin/stdout. Requests contain `{v:1,id,method,args}` inside a native-only envelope; replies preserve `{result}` versus `{error:{code,message}}`. Rust generates correlation IDs and sets the native privilege bit; renderer arguments cannot set it. Protocol mismatch/malformed frames close the process connection. Frame limit is 48 MiB, allowing base64 encoding of IO's existing 32 MiB asset ceiling. Native and Node pending-request limits are 64. Rust fails a request after 60 seconds and terminates the connection: an interrupted write has an unknown outcome and is never automatically retried.

Only the `studio` window at the local app origin (or exact development origin `http://127.0.0.1:5173`) may call the project command. The window receives event-listen/unlisten and destroy permissions; it receives no shell or filesystem plugin permissions. No preview webview is created or granted desktop capabilities.

Folder selection grants a canonical root in Node. Other grants come only from validated app-local recent records, an explicitly planned child destination, or the host-created example location. Renderer-supplied arbitrary roots and native-only commands are refused. New projects require a Windows-safe single folder name, an approved parent, and a current create-only plan; existing folders are not merged or overwritten. File import always replaces renderer source-path arguments with a fresh native file selection and reuses real asset import with a captured registry revision and explicit license.

Serializable open results contain metadata and a random session ID. Scene read/save/watch/unwatch, catalog refresh and asset reads resolve that handle to the owning Node session. Reads expose registered asset IDs, never a generic absolute-path reader; bytes cross as base64 and become Uint8Array in the renderer. There are at most 16 open sessions and 32 scene watches per session. Explicit close removes all session watchers. Unsubscribe remains ordered when it races async watch registration. Renderer reconnect resets previous sessions, watches, pending creation plans and folder grants except stored recents, and attempts to cancel prior runs. In-flight opens/starts cannot attach themselves to a newer renderer generation.

Recent roots are stored atomically under the native app-local-data directory, limited to 20, and revalidated on listing. Invalid state grants no paths. Recent-write failure does not turn a successfully created project into a failed creation that invites unsafe retry; persistence is best effort. Examples use create-only `hotel` fixture copies under unique app-data directories; opening an example never edits the repository fixture. Copies remain until the user removes them; no automatic project deletion is implemented.

## Agent integration

The native Node entry now uses agent-service's shared `loadAgentServiceConfig` for strict descriptor validation rather than an independent parser. Parent verification after integration: desktop typecheck and all eight desktop tests pass. Startup failures retain a fixed safe readiness message; raw configuration paths and error details are not sent to the renderer.

No configured artifact means three provider rows with `not-ready`, an explicit missing-isolated-artifact message, zero models and zero supported permission modes. There are no fabricated provider successes or model choices. Check again performs a real provider refresh when the isolated service is available.

The only agent configuration input is an **absolute, trusted native launch environment** `FORGON_T3_CONFIG` pointing to a bounded JSON file. It is never loaded from a game project or renderer-provided path. Shape:

```json
{
  "port": 57831,
  "artifact": {
    "entryPath": "D:/trusted/pinned-t3/dist/bin.mjs",
    "expectedSha256": "<64 hexadecimal characters>",
    "expectedServerVersion": "<verified descriptor server version>",
    "bundle": [
      { "path": "bin.mjs", "sha256": "<entry digest>" },
      { "path": "<sibling chunk filename>", "sha256": "<chunk digest>" }
    ]
  }
}
```

Use the real agent-service artifact hashing/verification helpers to prepare that manifest. Entry-only pinning is supported by that service but verifies only the launcher; supply the full bundle manifest to cover sibling chunks. There is no automatic download/install/build of T3. Startup errors produce an unavailable-provider message, leaving project editing usable. Native RPC agent failures retain their code and use a fixed safe message; service-owned provider facts and events retain their redaction rules.

Agent state is fixed to `<app-local-data>/agent-home`; desktop never reads/copies live `~/.t3` credentials. The agent-service's own isolation/provenance checks remain authoritative. T3 uses the bundled Node executable, so its version must satisfy the pinned T3 package (the research reports `^22.16 || ^23.11 || >=24.10`; host Node 24.2 does not satisfy that). `bundle:bridge` copies the Node that runs it into `resources/node.exe`, so it never downgrades: an incompatible host keeps an already-compatible bundled runtime (with a warning) and fails only when neither is compatible (using agent-service's `satisfiesT3Node`); it skips the copy when the bundled version already matches. Live handshake/provider acceptance remains the agent lane's separate gate. Automatic persisted-thread reattachment is disabled here because the desktop renderer does not yet recover prior thread UI/ownership. This does not claim conversation resume support.

The agent proxy exposes the shared start/cancel/approve/subscribe surface and discovery refresh. Start requires an open project root. Cancellation and approval require a run owned by this renderer; approval-request binding is additionally enforced by agent-service. Early events emitted during start are buffered before run ownership is known. No unsupported permission mode is invented. Provider approval labels and project cwd remain UX controls, not an OS sandbox.

## Native shutdown and CSP

Before any Node/T3 work begins, Node waits for its first stdin data and Rust assigns it to a Windows kill-on-close Job Object. Failure to assign the job fails startup and kills the captured Node child. Descendants inherit job membership. Normal app exit requests bridge shutdown, which closes watchers, stops the owned agent service and drains recent persistence; then Rust terminates/reaps the owned process tree. EOF also closes Node resources. Native crash closes the job handle, terminating descendants. These Windows mechanics have been implemented and Rust-parsed, but not compiled or runtime-tested.

Native close handling dispatches the existing cancelable beforeunload guard. Dirty work or an active save blocks window close and shows a native explanation: save, or explicitly discard via Close project, before closing the window. No second dirty-state implementation is introduced. Native close behavior remains an acceptance check.

Production CSP permits scripts only from the app itself, and `wasm-unsafe-eval` for bundled local Ammo WASM. It permits local/blob asset/media and workers; no remote script host, arbitrary frame, shell or generic network agent endpoint is granted. The separate development CSP permits Vite's inline refresh preamble and its exact loopback HMR socket. Both must be verified against WebView2; no native CSP success is claimed from static inspection.

## Dependencies and user-run commands

Parent owns root install and lock reconciliation. Desktop declares workspace dependencies on project-schema, project-io, asset-pipeline and agent-service; external dependencies are `@tauri-apps/api ^2.10.0`, `@tauri-apps/cli ^2.10.0` and `esbuild ^0.25.0`. Studio adds `@forgon/studio-desktop: workspace:*`. Cargo declares Tauri 2/tauri-build, serde_json, rfd 0.15, uuid 1 and Windows-only windows-sys 0.59 Job Object APIs. No separate Rust project-IO or Node shell plugin is added.

Tooling ownership note: the initial `pnpm exec` automatically bootstrapped the configured package-manager runtime (three cached additions). There was no explicit install or manual root/lockfile edit. Subsequent verification invoked the existing TypeScript/tsx executables directly to avoid another bootstrap; parent should reconcile root install/lock state.

Run from the repository root, with the Rust/MSVC/WebView2 prerequisites established by prior research:

```powershell
pnpm install
pnpm --filter @forgon/studio-desktop typecheck
pnpm --filter @forgon/studio-desktop test
pnpm --filter @forgon/studio typecheck
pnpm --filter @forgon/studio test

# Build the Node resource, frontend and native NSIS package in order (not run by this worker):
pnpm --filter @forgon/studio-desktop build

# Launch native development only when authorized:
pnpm --filter @forgon/studio-desktop dev
```

Tauri before-build/dev hooks run bundle:bridge and the corresponding Studio build/dev command. The NSIS bundle includes the Node executable and bridge resource. First native packaging can fetch Cargo/NSIS dependencies; installers use WebView2's download bootstrapper and can require network access. There is no signing certificate or signed-release claim. Cargo.lock is not generated by this lane; native dependency resolution and lock review remain part of the first user-run native build. This is Studio packaging, not game export.

## Verification performed

- `node node_modules/typescript/bin/tsc --noEmit -p apps/studio-desktop/tsconfig.json`: passed.
- `node node_modules/typescript/bin/tsc --noEmit -p apps/studio/tsconfig.json`: passed with the real desktop and runtime imports.
- Studio's three tests passed using `node --import tsx --test test/*.test.ts test/*.test.tsx` from apps/studio (its own JSX tsconfig is required). A combined root-directory invocation initially selected the wrong JSX transform; rerunning from the package directory passed without changing test or app code.
- `node --import tsx --test apps/studio-desktop/test/*.test.ts`: 8 passed, 0 failed. Real temp files cover create/save/stale conflict/external watch/reopen, persistent recents, separate example copies, actual asset bytes and native import, grant/session/plan boundaries, reconnect disposal and asynchronous unsubscribe. Injected agent service covers early events and run ownership. Actual Node child tests cover version refusal, correlated requests/coded errors and EOF termination with an active watcher. They do not start Tauri or a provider.
- Rustfmt parsed/formatted native source. No Cargo compile/check, frontend/Node bundling, native launch, browser automation, installer or real T3 startup was performed.

## Remaining practical boundaries

IO retains its documented cross-process CAS, hostile concurrent namespace mutation and power-loss durability limits. Multiple independent app processes are not coordinated by a new global lock. Recent persistence is best effort; app-data examples accumulate. There is no renderer recovery of previous agent threads, game-export shell, separate arbitrary-code preview process, updater/signing or clean-VM installation proof in this change. Native Job Object, dialog, close guard, bundled resource resolution and Ammo CSP behavior are the next concrete Windows acceptance checks. Parent must update project.md/design.md and the daily task file after accepting this lane, without calling unverified native acceptance complete.
