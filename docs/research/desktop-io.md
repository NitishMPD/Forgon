# Desktop host + project IO research (wave 1)

Owner: MiMo V2.6 Pro (desktop worker — `apps/studio-desktop`, `packages/project-io`)
Date: 17 October 2026. Status: **research + interface proposal only. No app code written this wave, per instructions.**
Inputs read: `project.md`, `docs/handoff/build-brief.md`, `docs/handoff/contracts.md` (v1, present — interfaces below align to it).

Everything in §1 is measured on this machine today. Everything in §3 cites upstream docs fetched today. Items that must still be proven by a build or test are labelled **[verify]**, not claimed.

---

## 1. Installed toolchain inventory (verified 17 Oct 2026)

| Component | Detected | Evidence |
|---|---|---|
| Rust | `rustc 1.92.0 (ded5c06cf 2025-12-08)`, `cargo 1.92.0`, `rustup 1.28.2` | `rustc -V`, `cargo -V`, `rustup -V` |
| Rust host target | `x86_64-pc-windows-msvc` (default); `x86_64-pc-windows-gnu` also installed | `rustup show` |
| MSVC toolchain | Visual Studio Build Tools **2026**, install `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`, version 18.3.11505.172, VC Tools **14.50.35717** | `vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` |
| Windows SDK | 10.0.26100 (also 10.0.22621 includes present) | Kits registry + `Windows Kits\10\Include` |
| Link test | **Passed**: `cargo new hello-msvc && cargo build --release` linked with MSVC and the binary ran (`Hello, world!`) | executed in `%TEMP%\opencode\forgon-toolcheck` |
| WebView2 runtime | Evergreen **155.0.4283.60** machine-wide (HKLM WOW6432Node EdgeUpdate client `pv`), two versions under `C:\Program Files (x86)\Microsoft\EdgeWebView\Application` | registry + directory listing |
| Node | `v24.2.0` (`C:\nvm4w\nodejs\node.exe`); dependents are system DLLs only — **no VC runtime DLL dependency** (checked with `dumpbin /dependents`) | `node -v`, dumpbin |
| pnpm / npm | pnpm `12.5.1`, npm `11.3.0` (matches "pnpm only" rule) | `pnpm -v` |
| Git | `git version 2.49.0.windows.1` (needed later for checkpoints) | `git -v` |
| signtool | `Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe` present (22621 kit also) | file listing |
| Long paths | `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1` | registry |
| Developer Mode | `HKLM\...\AppModelUnlock\AllowDevelopmentWithoutDevLicense = 1` → unprivileged symlink creation available for tests | registry |
| Workspace volume | `D:` NTFS, 4096-byte clusters (rename-replace + directory flush semantics discussed below assume NTFS) | `Get-Volume` |

Missing / not installed / not verified (details in §11):

- `aarch64-pc-windows-msvc` and `i686-pc-windows-msvc` rustup targets absent (needed only for ARM64/32-bit exports later); ARM64 also needs the VS "C++ ARM64 build tools" component.
- `fsutil 8dot3name query D:` needs elevation (Error 5) — 8.3 short-name aliasing state of the volume is **unverified**; tests must not assume it is disabled.
- No code-signing certificate on this machine (external gate). signtool exists; a cert to sign with does not.
- Tauri bundler prerequisites (NSIS fetch on first `tauri build`; WiX needs the VBSCRIPT optional Windows feature per upstream docs) — **[verify]** on first real build; no Tauri project exists in the repo yet.

**Conclusion:** the Windows Rust/MSVC/WebView2/Node stack for a Tauri 2 desktop host is fully present and proven to compile and link natively. Nothing in the host toolchain blocks Sprint 1.

---

## 2. Contract alignment status

`docs/handoff/contracts.md` v1 **is available**, so the interfaces in §4 are aligned to its *Optimistic IO boundary* section:

- `Revision = string` (opaque hash of exact file bytes), `SceneRead`, `SaveSnapshot`, `SaveSceneRequest`, `SaveSceneResult`, `SceneIO`, `SceneWatchEvent`, `Diagnostic` — project-io implements these exactly as specified in project-schema's exported types. No renaming proposed.
- Host duties quoted from the contract are treated as requirements: serializes compare+write across all app writers; atomic temp+rename; byte-revision check immediately before commit; reports external races/conflicts; confines paths; never runs project scripts; watch callbacks are notifications, not authority.
- The contract's honesty requirement is preserved: *"Atomic rename alone is not cross-process compare-and-swap: document and test OS constraints before claiming arbitrary third-party writer safety."* §6 and §7 document those constraints; §12 lists the tests that must pass before we claim anything.

**Deltas the contract does not cover yet** (proposed here, returned to parent in §14):

1. The **host command surface** (Rust `io_*` commands + events). contracts.md defines `SceneIO` (TS, semantically) but not the IPC seam between project-io and the Rust host.
2. A **`HostIO` TS seam** so project-io is testable in Node without Tauri.
3. The **export API** (web/Windows export writes outside the project root — needs explicit shape).
4. A **preview capability contract** (what the preview/play surface is allowed to touch).
5. A **sidecar lifecycle/version-handshake protocol** (spawning, restart, contract version pinning).

---

## 3. Tauri 2 surface audit (upstream docs, fetched 17 Oct 2026)

### 3.1 `tauri-plugin-fs` — read/write APIs

Verified facts (v2.tauri.app/plugin/file-system):

- Frontend file APIs (`readTextFile`, `writeTextFile`, `create`, `open/createNew`, `rename`, `copyFile`, `stat`, `readDir`, `remove`) all exist; on the Rust side the plugin offers only permission helpers — "use traditional Rust's libs (std::fs, tokio::fs…)".
- Permissions are deny-by-default; every command needs an explicit **scope** (`{ "identifier": "fs:allow-*", "allow": [{ "path": ... }] }`) or calls fail with `forbidden path`. Scope paths may be base-dir variables (`$APPDATA`, `$RESOURCE`, `$TEMP`, …).
- Path traversal with `..` is rejected by the API. `stat` follows symlinks and **errors if the symlink target leaves the scope** — i.e. scope resolution provides some escape containment already, but it is scope-string-based, not project-root-based.
- `writeTextFile`/`open+write` is **plain truncate-and-write** — not atomic, no compare-and-swap, no fsync. It cannot implement the contract's optimistic save.
- `watch` / `watchImmediate` need the crate feature `features = ["watch"]`; `watch` is debounced via `delayMs`, `watchImmediate` is not.
- MSI/NSIS `perMachine` installs require admin for writes under `$RESOURCES`; the WebView2 data folder `$APPLOCALDATA/EBWebView` is denied by default in `fs:default`.
- Plugin requires Rust ≥ 1.90 (we have 1.92).

**Decision:** do **not** route project IO through `tauri-plugin-fs`. It offers neither atomic replace nor CAS nor revision hashing, and its scope model is per-base-dir glob, not "inside this open project root". Use it only for app-private files where convenient (e.g. window-state, logs). Project IO goes through our own narrow Rust commands (§4.1), which are a strict subset in behavior but correct for the contract.

### 3.2 Watcher

- `tauri-plugin-fs` `watch` wraps the `notify` crate (the plugin's debounce is the coarse `delayMs` kind). We need more than it gives: rename-pair coalescing, overflow → rescan semantics, self-write suppression, and content-hash verification before declaring "changed".
- `notify` 8.2.0 (06 Sep 2026, CC0-1.0, windows-sys backend on Windows = ReadDirectoryChangesW). Documented known problems that map directly to our risk register:
  - **Editor behaviour varies**: some editors truncate-in-place, some write-new-and-replace — event kinds differ per editor ([known problem](https://docs.rs/notify/latest/notify/#editor-behaviour)). ⇒ treat events as *hints*, always re-read and hash (§7).
  - **Network filesystems** may emit no events (esp. WSL → Windows paths); workaround is `PollWatcher`. ⇒ network-root projects need polling mode (§5, §11).
  - **Watching large directories** can silently miss events (issue #412). ⇒ periodic health probe + authoritative hash compare (§7).
  - **Parent folder deletion** requires watching the parent path to observe it.
  - Official debouncers: `notify-debouncer-mini` / `notify-debouncer-full` (notify itself is not debounced).

**Decision:** own a small `watch` service in the Rust host on `notify` (Option A). Do not depend on the fs plugin's watch for correctness-critical reconciliation. Windows backend behavior we rely on and must pin by test: ReadDirectoryChangesW delivers renames as old-name/new-name pairs that can interleave with other events, coalesces bursts, and signals an overflow when its buffer fills — on overflow we must **rescan the watched subtree** and diff by content hash, never assume events were complete.

### 3.3 Atomic replacement / optimistic concurrency

Tauri provides nothing here. This is host code. Windows facts the protocol depends on:

- `std::fs::rename` on Windows maps to `MoveFileExW(src, dst, MOVEFILE_REPLACE_EXISTING)`: replaces an existing target in one namespace operation **on the same volume**; it is *not* a lock, *not* a CAS, and fails across volumes (no copy fallback). Transient `ERROR_SHARING_VIOLATION` (32) / `ERROR_ACCESS_DENIED` (5) are common when AV, Search indexer or another process holds the target without `FILE_SHARE_DELETE`.
- `ReplaceFileW` is the API designed for save-over-existing: it preserves the replaced file's attributes/ACLs and can write a backup file atomically with the swap. Preferred when the target exists (fallback: `MoveFileExW` with retries).
- Durability order: write temp file **in the same directory** → `FlushFileBuffers` on it (Rust `File::sync_all`) → replace → best-effort `FlushFileBuffers` on a directory handle opened with `FILE_FLAG_BACKUP_SEMANTICS` (NTFS persists the rename; FAT/exFAT/SMB do not guarantee it). **[verify by crash test]** (§6).
- There is no "directory fsync" in Rust std on Windows; the directory-flush needs `windows`/`winapi` calls.

Full protocol in §6. The contract's CAS semantics are enforced *by our process serialization + pre-commit hash check*, and honestly documented as best-effort against arbitrary external writers (§7).

### 3.4 Sidecar packaging (agent-service, Node/TS)

Verified (v2.tauri.app/develop/sidecar + /learn/sidecar-nodejs, pages current as of Jun/Sep 2026):

- `bundle.externalBin: ["binaries/agent-service"]` requires `src-tauri/binaries/agent-service-<target-triple>[.exe]`; on this host: `agent-service-x86_64-pc-windows-msvc.exe` (triple from `rustc --print host-tuple`, Rust ≥ 1.84 — we have 1.92).
- Runtime: `app.shell().sidecar("agent-service")` from Rust (`tauri_plugin_shell::ShellExt`) or `Command.sidecar('binaries/agent-service')` from JS; the argument is the **name only**, not the configured path. Long-lived sidecars should use stdin/stdout, local sockets or a localhost server rather than one-shot stdout.
- Permissions: `shell:allow-spawn`/`shell:allow-execute` capability entries with `"sidecar": true`, and argument patterns can be pinned with an ordered array of literals/regex validators (use this — never `"args": true`).
- Node packaging per official guide: `@yao-pkg/pkg` self-contained binary (recommended by the guide), or embed a Node runtime + JS as resources (guide notes the runtime route is usually larger and leaves readable JS). **Decision:** spike `pkg` vs `bun build --compile` vs embedded-V-24+JS-as-resource in wave 3 and pick by measured size/startup; the sidecar contract must not depend on the choice (stdio JSON protocol over a pipe).

### 3.5 WebView2 / installer / prerequisites (all numbers from upstream, "Windows Installer" page current 16 Oct 2026)

| `webviewInstallMode` | Internet at install? | Extra size | Notes |
|---|---|---|---|
| `downloadBootstrapper` (**default**) | yes | 0 MB | fine for dev; bad for offline installs |
| `embedBootstrapper` | yes | ~1.8 MB | better Win7/MSI compat |
| `offlineInstaller` | **no** | ~127 MB | recommended offline |
| `fixedRuntime` | **no** | ~180 MB | pinned runtime, we own security updates — poor fit with auto-update |
| `skip` | – | 0 | app won't run where runtime missing |

- WebView2 runtime ships with Windows 10 (April 2018+) and Windows 11; the machine here has 155.0.4283.60 installed. `minimumWebview2Version` exists in config if we need a floor.
- NSIS `-setup.exe`: `installMode` `perUser` (default, no admin, installs to `%LOCALAPPDATA%`) / `perMachine` (admin, `Program Files`) / `both`. NSIS hooks (`NSIS_HOOK_PRE/POSTINSTALL/UNINSTALL`) exist for bundling prerequisites such as VC redist (not needed for our Rust host: MSVC Rust links CRT statically by default **[verify at first link of the real app]**; node.exe here has no VC DLL dependency either).
- MSI (WiX v3) requires the Windows **VBSCRIPT optional feature** (documented footgun: `failed to run light.exe`). Cross-compiling Windows apps from Linux/macOS exists via `cargo-xwin` but is "last resort".
- Windows app signing: separate `distribute/sign/windows` flow; cert is an **external gate**.

---

## 4. Proposed interfaces (exact, narrow)

Design rule from contracts.md integration order: *"Host: parse unknown files at boundary, enforce project validation with catalogs, return byte revisions."* So the Rust host is byte-level and dumb-but-safe; `project-io` owns parsing/validation/semantics and implements `SceneIO` as contracted.

### 4.1 Rust host command surface (IPC seam)

All paths are **project-relative POSIX strings** as defined in contracts.md §"Documents and identity". The host resolves them underneath a canonical project root handle (`io_open_project`); every resolution is containment-checked (§5). Payloads are base64 for exact bytes (JSON text is UTF-8 but `Revision` hashes *exact bytes* including any BOM/line endings).

```rust
// apps/studio-desktop/src-tauri/src/io/mod.rs  (proposed)
#[tauri::command] async fn io_open_project(root_path: String) -> Result<ProjectHandleInfo, IoError>;
// validate root exists & is a directory; canonicalize; store cap_std::fs::Dir; return
// { rootId, canonicalRoot, fsKind: "local-ntfs" | "other", watchMode: "events" | "poll" }

#[tauri::command] async fn io_read(root_id: String, rel_path: String) -> Result<IoRead, IoError>;
// IoRead = { dataBase64: String, revision: String, size: u64, mtimeMs: u64 }

#[tauri::command] async fn io_stat(root_id: String, rel_path: String) -> Result<Option<IoStat>, IoError>;
// IoStat = { revision: String, size: u64, mtimeMs: u64, kind: "file" | "dir" }

#[tauri::command] async fn io_write_atomic(root_id: String, req: WriteRequest) -> Result<WriteResult, IoError>;
// WriteRequest = { relPath: String, dataBase64: String, expectedRevision: Option<String> }
//   expectedRevision == None  -> CREATE-ONLY (conflict if file exists)  [contract: "null expected revision
//                                means create-only, never unconditional overwrite"]
// WriteResult = { status: "saved", revision: String }
//            |  { status: "conflict", reason: "revision-mismatch" | "exists" | "missing",
//                 current: Option<{ revision: String }> }

#[tauri::command] async fn io_list(root_id: String, rel_path: String) -> Result<Vec<IoEntry>, IoError>; // manifest loading, rescan
#[tauri::command] async fn io_watch_start(root_id: String, debounce_ms: u32) -> Result<String, IoError>;  // subscription id
#[tauri::command] async fn io_watch_stop(root_id: String) -> Result<(), IoError>;
```

Host → frontend events (one channel, JSON payloads):

```text
event "forgon-io://activity"  payload { "rootId": string, "paths": [ { "relPath": string,
  "kind": "created" | "modified" | "deleted" | "renamed" | "rescan" } ], "source": "watch" | "poll" }
event "forgon-io://watch-status"  payload { "rootId": string, "state": "healthy" | "degraded" | "overflow-rescan" | "polling" | "stopped", "reason"?: string }
```

These are **notifications only** (contract: watch callbacks are not authority). The consumer re-reads via `io_read` and decides (§4.5).

Error taxonomy (`IoError` → rejected promise with structured payload; every code is testable):

```text
not-found | permission-denied | outside-root | invalid-path | invalid-sequence |
io-busy (sharing violation after retries) | io-full | unsupported-fs | internal
```

`revision` algorithm (host is the sole producer/consumer; project-io treats it as opaque):

```text
revision = "v1:sha256:" + lowercase_hex(SHA-256(exact_file_bytes))
```

The `v1:` prefix lets the algorithm evolve without silent CAS breakage.

### 4.2 `packages/project-io` layout and the `HostIO` seam

```text
packages/project-io/src/
  host.ts        // HostIO interface — the TS mirror of §4.1 command + events (pure TS, no Tauri import)
  scene-io.ts    // createSceneIO(host, opts): SceneIO  — exact contracts.md types from @forgon/project-schema
  watcher.ts     // activity events -> re-read -> parseScene/parsePrefab -> SceneWatchEvent
  diagnostics.ts // Diagnostic[] construction for invalid external edits
  export.ts      // ExportIO (§9) — contract need flagged
  index.ts
```

```ts
// host.ts — exact seam proposed (mockable in Node tests; implemented over Tauri invoke in apps/studio-desktop)
export interface HostIO {
  read(rootId: string, relPath: string): Promise<{ dataBase64: string; revision: string; size: number; mtimeMs: number }>;
  stat(rootId: string, relPath: string): Promise<{ revision: string; size: number; mtimeMs: number; kind: 'file' | 'dir' } | null>;
  writeAtomic(rootId: string, req: { relPath: string; dataBase64: string; expectedRevision: string | null }):
    Promise<{ status: 'saved'; revision: string } | { status: 'conflict'; reason: 'revision-mismatch' | 'exists' | 'missing'; current: { revision: string } | null }>;
  list(rootId: string, relPath: string): Promise<{ name: string; kind: 'file' | 'dir' }[]>;
  watch(rootId: string, listener: (e: FsActivity | WatchStatus) => void): () => void;
}
```

`scene-io.ts` on top of `HostIO` implements, verbatim from contracts.md:

- `readScene(path): Promise<SceneRead>` — `io_read` → UTF-8 decode → `parseScene` (structural/local only unless catalogs supplied — never label it full project validation) → `{ document, revision }`. Invalid file → reject with `Diagnostic[]`, do not partially return.
- `saveScene(req: SaveSceneRequest): Promise<SaveSceneResult>` — serialize with `serializeScene` (deterministic), `writeAtomic` with `expectedRevision = req.expectedRevision` (null ⇒ create-only). Map conflict result straight through; on `saved` return the new revision. Never overwrite on conflict.
- `watchScene(path, listener): () => void` — per §4.5. `changed` events carry `SceneRead`; unparsable content ⇒ `invalid` with diagnostics; `deleted` ⇒ `deleted`. Invalid/deleted never replace last valid scene (contract).

### 4.3 The save path exactly as the contract requires

UI flow (already fixed by contracts.md integration order): `command -> EditorStore.prepareSave() -> IO.saveScene -> EditorStore.acknowledgeSave(snapshot, revision)`. `prepareSave` throws while a conflict is unresolved; `acknowledgeSave` records only what was actually written. project-io must not add any merging on top — "No automatic merge".

### 4.4 Host write protocol (crash-safe replace + CAS)

Executed under a single host-side save mutex (contract: *serialize compare+write across all app writers*; a global `tokio::sync::Mutex` around steps 2–6 suffices at our save rates and is trivially correct — **[verify]** no UI stall since commands are async):

1. Containment-check `rel_path` (§5). Reject with `outside-root`/`invalid-path` on failure.
2. Read current bytes (if any) → compute `current_revision`. CAS check:
   - `expectedRevision == None` and file exists ⇒ conflict `exists`.
   - `expectedRevision == Some(r)` and file missing ⇒ conflict `missing`.
   - `Some(r)` and current ≠ r ⇒ conflict `revision-mismatch` (return `{current}` revision).
3. Write temp `.<name>.forgon-<pid><nonce>.tmp` **in the same directory** (same volume ⇒ the later rename is a namespace swap). Write all bytes; `File::sync_all()` (flushes to disk).
4. Replace:
   - target exists ⇒ `ReplaceFileW(new, target, backup = .<name>.forgon-bk)` (preserves ACLs; gives a recoverable backup); fall back to `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` if `ReplaceFileW` fails with a non-transient error;
   - target missing ⇒ `MoveFileExW` without replace (fails if a concurrent creator won the race — that surfaces as conflict `exists`, not silent overwrite).
   - Retry `ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION`/`ERROR_ACCESS_DENIED` up to 5 times with backoff (AV/indexer); persistent ⇒ `io-busy`.
5. Verify: re-read target bytes, recompute revision. It must equal the revision of the bytes we just wrote. If not (external writer replaced it within the swap window) ⇒ report `conflict` with the observed revision and **never claim saved**. (This closes most of the CAS window; the residual race with an arbitrary third-party process is documented in §7, per contract honesty.)
6. Best-effort directory flush (dir handle + `FlushFileBuffers`) for rename durability; if the volume isn't NTFS-local, set `fsKind: "other"` on the project handle and downgrade the durability claim in the UI diagnostics.
7. Emit our own write into the recent-write registry (path, revision, timestamp) for watcher self-echo suppression (§7). Delete the temp/backup files after successful verify.

### 4.5 Watch → `SceneWatchEvent` pipeline

1. Host watcher (notify on `ReadDirectoryChangesW`) emits raw activity; host debounces ~150 ms per path (max latency ~500 ms), coalesces rename pairs into `renamed`, dedupes bursts, and emits `forgon-io://activity`.
2. On buffer overflow/error or missed-event suspicion → emit `overflow-rescan` + `rescan` per affected path (or whole root), and rely on step 3 to filter noise.
3. project-io, per changed path: `stat` (cheap filter) → if mtime/size unchanged vs its cache, drop; else `io_read` → compute/obtain revision:
   - revision equal to the document's current revision ⇒ **drop** (idempotent per contract);
   - matches a recent own save (path+revision registry) ⇒ drop (self-echo);
   - parse OK ⇒ emit `changed {value: SceneRead}`;
   - parse/validate **fails** ⇒ emit `invalid {diagnostics}` (last valid scene stays; per-field diagnostics where parse knows the field), and schedule one re-read after the quiet period (guards partial writes by non-atomic editors);
   - file gone at read time ⇒ `deleted`; temp-file staging churn (`.forgon-*.tmp`, `.forgon-bk`) is filtered from event streams entirely.
4. Events never touch dirty UI state directly — the store's `reconcile(input, revision)` decides `unchanged | reloaded | conflict` (contracts.md). Repeat events with same revision+content are idempotent.

---

## 5. Windows path / symlink / junction containment

Threat model: a malicious or careless project (or agent) plants a symlink/junction inside the project root that points at `C:\Windows`, a UNC share, or the webview profile; or smuggles paths via alternate streams, device names or short names. project-io must never hand the host a path it resolved itself — the host re-resolves and checks containment on **every** operation, including watch and export.

Spec (implements contracts.md "Paths are project-relative POSIX paths… Host must additionally resolve containment and reject symlink escapes"):

1. **Lexical gate** (host + project-io, both): reject absolute paths, drive letters, backslashes, empty/`.`/`..` segments, NUL and control chars, any `:` (kills NTFS alternate data streams like `file.json:stream` and `\\?\` smuggling), trailing dots/spaces, and reserved DOS device names (`CON PRN AUX NUL COM1-9 LPT1-9`) case-insensitively. Max length 260 chars per contract's spirit (IDs capped at 128; keep a generous 240 path cap).
2. **Resolution:** open paths relative to a canonicalized root `Dir` handle — use `cap-std` 4.0.3 (active, bytecodealliance; `cap_std::fs::Dir` gives capability-based resolution that refuses to follow a symlink/junction out of the directory tree on Windows). This is the primary control; string-prefix checks on `canonicalize()` output are the **fallback**, not the mechanism.
3. **Handle-based verification (belt and braces):** after open, `GetFinalPathNameByHandleW` and require the final path to start (case-insensitive) with the canonical root path; this catches junction reparse points and 8.3 short-name aliases (`PROGRA~1`) that string comparison misses. Root stored in `\\?\`-normalized form internally; presented simplified (e.g. `dunce`) on the IPC boundary.
4. **Case policy:** Windows comparison is case-insensitive; treat `Scenes/x.json` and `scenes/X.json` as potential aliases — canonical-key = lowercased relative path with `\`→`/`. Detect and warn on case-colliding entries (breaks Git checkouts on other machines).
5. **Symlink policy inside the root:** project IO reads/writes follow symlinks **only if the resolved target stays inside the root** (cap-std enforces by construction). Symlink entries themselves may be listed but are marked in `io_list` (`kindSymlink: true`) and warned in diagnostics; a project that relies on symlinks is flagged "non-portable".
6. **Long paths:** `LongPathsEnabled=1` here, but code must work regardless — normalize to `\\?\` for any internal Win32 calls and never rely on the registry setting. **[verify]** a >260-char project path save/read/watch test.
7. **Mount points/junctions pointing outside** are rejected at resolution time; a junction inside the root pointing to another directory inside the root is allowed.
8. **UNC / network roots:** allowed but recorded as `fsKind: "other"` at `io_open_project`: watcher switches to `notify::PollWatcher` with `compare_contents` (ReadDirectoryChangesW behavior over SMB/WSL is unreliable per notify known problems), durability claims are weakened ("rename atomic on same volume" is provider-dependent), and the UI surfaces "network project: slower external-change detection; crash-durability reduced".
9. **Export targets** (§9) are the only paths outside the root, and only via user-chosen directory (dialog) whose canonical path is registered as a separate one-shot write scope; same lexical + handle checks inside it.

---

## 6. Crash safety

Protocol is §4.4 steps 3–7; guarantees and their limits:

- **At every instant the target file is either the old complete bytes or the new complete bytes.** Temp write + fsync before the namespace swap is what makes this true; if we crash before the swap, the target is untouched and the `.forgon-*.tmp` is garbage; if during/after the swap, the target is the complete new content and `.forgon-bk` holds the prior version (when `ReplaceFileW` was used).
- **Startup recovery sweep** (runs before any project opens): in each staged directory delete stale `.forgon-*.tmp` (never valid content — safe delete), and if a `.forgon-bk` is newer than its target or the target is missing, surface a one-click recovery ("previous version of X found — restore?") instead of silently acting. Recorded as a diagnostic with timestamps.
- **Durability after save:** NTFS local volume + directory flush ⇒ rename survives power loss **[verify by crash test]**; on `fsKind: "other"` we only claim "no partial file", not "rename persisted".
- **Play-mode protection (contract):** IO writes never touch the in-memory play snapshot; snapshots are detached copies (`prepareSave`/`reconcile` semantics in contracts.md). Reloads must not reset play simulation.
- **Not claimed:** atomicity against an arbitrary concurrently-writing third-party process (see §7 rule "external-writer honesty"), multi-file atomicity (a project save touches several files — batch = ordered list of per-file CAS saves + final manifest CAS as the commit marker; on failure, surface which files committed and let the user rebase; the manifest is the recovery anchor). Batch semantics need a contract decision (§14).

---

## 7. External watcher race matrix (documented, with mitigations)

| Race / hazard | What actually happens on Windows | Mitigation |
|---|---|---|
| Editor saves non-atomically (truncate-in-place) | read catches empty/partial file → parse error | `invalid` event keeps last good state; one scheduled re-read after quiet period (§4.5) |
| Editor saves via write-temp+rename (VS Code, vim) | rename old→new pairs, interleaved bursts | coalesce rename pairs into `renamed`; debounce; hash-compare before declaring changed |
| `git checkout`/branch switch replaces many files | flood of create/delete/rename + possible ReadDirectoryChangesW overflow | overflow → `rescan` + content-hash filter; empty-then-recreate of workspace dotfiles filtered |
| Our own save echoed back as change | classic feedback loop | recent-write registry (path+revision) drops echo; revision-equality drop is the hard guarantee (idempotent reconcile) |
| External writer edits between our CAS check and rename | silent last-writer-wins without care | pre-commit hash check (§4.4.2) + post-commit verify (§4.4.5); residual window reported, not hidden — **we never claim cross-process CAS** without the test matrix (§12) passing |
| External writer holds file open w/o FILE_SHARE_DELETE | sharing violation on replace | bounded retry w/ backoff → `io-busy` diagnostic; user can retry; **never** fallback to non-atomic truncate |
| Metadata-only touch (indexer/AV) | mtime event, bytes unchanged | stat filter + revision equality → drop |
| Watcher silently dies / drops events (large dirs, notify #412) | no events, stale UI | `watch-status` health events + periodic root probe (stat sweep every ~30 s) comparing revisions; mismatch ⇒ targeted `rescan` |
| Delete racing read | `not-found` at `io_read` | treat as `deleted`; if the file reappears later with same revision → `changed` to `unchanged` (idempotent) |
| Network/WSL root event loss | notify known problem | polling mode (`PollWatcher` + `compare_contents`), `watch-status: polling` surfaced |
| Preview/play reading project files mid-save | preview sees partial state | preview reads from a materialized snapshot served by host (§8), never raw disk during save (save lane serializes snapshot publish after CAS success) |

---

## 8. Preview isolation (untrusted project code)

Acceptance-order item "imported code cannot execute on open" and §8.6 of project.md drive this design:

1. **Opening a project executes nothing.** project-io parses bytes with `project-schema` parsers only. TS scripts are data (`kind: 'script'` asset records) until a build/play step explicitly bundles them.
2. **Play/preview runs in a separate surface, not the studio window**: a dedicated `WebviewWindow` (`"preview"`) created with **zero app capabilities** (empty permission set in its capability entry — no fs, no shell, no process, no custom commands except a single `preview://` bridge if ever needed). The main window's capabilities list must not match the preview label.
3. **Content is served, not file-mounted:** the Rust host snapshots the play document + assets (detached copy per contracts.md) and serves them via a loopback listener on `127.0.0.1` with a per-session random token in the URL **[verify: vs. Tauri custom URI scheme registration — pick one in wave 3]**. The preview gets bytes, never filesystem access; content-type allowlist for served assets (json/js/wasm/png/jpg/webp/glb/mp3/wav), `Content-Security-Policy: default-src 'self' 'unsafe-inline' data: blob:` tightened as far as PlayCanvas allows **[verify minimum CSP with a real PlayCanvas boot]**.
4. **Separate WebView2 profile:** separate webview data directory for the preview surface so cookies/storage/session state cannot cross into the studio surface **[verify `WebviewBuilder::data_directory` behavior on Tauri 2 Windows]**; the fs plugin's default already denies `$APPLOCALDATA/EBWebView`, keep that denial.
5. **Game scripts only execute inside the preview runtime context** (sandbox layer of `apps/game-preview` / `packages/game-runtime`), never in the studio UI webview. Provider "full access" honesty (project.md §8.6) stays documented — our preview isolation limits *our* surfaces; an unrestricted external CLI is outside it.
6. Preview is read-only w.r.t. the project: the only writes it can trigger are explicit, UI-approved ("save playtest screenshot", "report").

---

## 9. Exports (web + Windows game) from the IO layer

Contracts.md has no export API (flagged in §14). Proposed minimal shape so the export worker (later waves) is not blocked:

```ts
// packages/project-io/src/export.ts (proposed; needs contract sign-off)
export interface ExportIO {
  // Reads project snapshot via SceneIO paths; writes a bundle to a user-approved target dir
  // OUTSIDE the project root. Staging: write into <target>.forgon-staging-<nonce>/ then
  // directory-rename publish (same volume), so a crash never leaves a half bundle at target.
  runExport(req: { rootId: string; outDir: string; target: 'web' | 'windows'; manifest: ExportManifest },
            progress: (e: { phase: string; fileDone: number; fileTotal: number }) => void):
    Promise<{ status: 'done'; outDir: string; manifestHash: string } | { status: 'failed'; phase: string; diagnostics: Diagnostic[] }>;
}
export interface ExportManifest { buildId: string; files: { rel: string; sha256: string; bytes: number }[]; target: string; createdAt: string; }
```

- `outDir` must be user-chosen (native folder dialog) or an explicitly granted scope — never a path the agent supplies silently. Same lexical/containment checks as §5 inside `outDir`.
- **Web export (P0):** static bundle (HTML/JS/WASM/assets) per project.md §13.1 — deterministic manifest (sorted paths + content hashes) is part of the definition of done. Vite or equivalent is the tooling worker's choice; IO only guarantees snapshot consistency and staged, atomic publish of the output tree.
- **Windows game export (P0):** per project.md §13.2 this is a Tauri-packaged web runtime shell. Studio-side IO duties: materialize the same web bundle as the shell's resources and emit a build report. Packaging mechanics (NSIS install mode, WebView2 mode table §3.5, `resources` mapping, per-file hashes) live in `apps/studio-desktop` build tooling. **External gates:** signing certificate, clean-VM license/AV scan policy, and a decision on `downloadBootstrapper` (small, online) vs `offlineInstaller` (~127 MB, offline) supported by measured data in wave 4.
- Exports must never execute project code in the studio process (§8 rule 1); any export-time scripting runs in the isolated preview/build context.

---

## 10. Agent sidecar packaging + lifecycle (desktop-side duties)

Aligned with contracts.md agent boundary ("Permission labels alone confer no sandbox guarantee"):

1. **Build/package:** `apps/agent-service` → single self-contained executable named `agent-service-x86_64-pc-windows-msvc.exe` into `apps/studio-desktop/src-tauri/binaries/`; `bundle.externalBin: ["binaries/agent-service"]`; spawn via `app.shell().sidecar("agent-service")` from Rust (name only). Capability entry `shell:allow-spawn` with `"sidecar": true` and an **ordered argv validator** (project root, `--stdio`, `--token` style args pinned by regex), never `"args": true`.
2. **Builder spike (wave 3):** `@yao-pkg/pkg` (official guide default) vs `bun build --compile` vs Node-24-V8-snapshot SEA. Measure: size on disk, cold start, npm-compat for T3-derived deps (agent sidecar npm deps may be native — e.g. `node-pty` is in T3's patch list — native modules favor pkg/SEA-with-care). Record decision + size table in this file.
3. **IPC:** newline-delimited JSON (NDJSON) RPC over stdio pipes (`CommandEvent::Stdout` handler in Rust emits to the frontend). But the `AgentEvent` envelope of contracts.md remains the semantic layer; sidecar startup handshake is `hello { contractVersion: 1, buildCommit, nodeRange }` and the host **refuses mismatched contract versions**.
4. **Process safety on Windows:** assign the sidecar into a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so studio crash/exit never orphans it; restart policy with backoff and a `health` event stream; cancel = kill child (provider-side cancellation semantics stay adapter-owned, per contract "unsupported controls must be reported unavailable").
5. **Permissions enforcement point:** host mediates every file write from sidecar runs through the same `io_write_atomic` lane (same CAS + containment), so agent writes participate in conflict detection instead of racing it. Direct disk writes by provider CLIs remain the documented residual risk (project.md §8.6 honesty) — mitigation: run agent tasks in isolated git worktrees (checkpoint worker's domain) and treat watcher-observed external writes as "theirs" in conflict UI.
6. **Secrets:** never in NDJSON payloads or logs (contract: "No secrets in events"); provider auth stays in provider-approved stores; audited at the T3-reuse layer, not copied here.

---

## 11. Missing platform prerequisites & external gates (honest list)

| Item | Status now | Gate |
|---|---|---|
| WebView2 runtime on end-user machines | present here (155.0.4283.60); ships in Win10 1803+/Win11 by default | installer must choose `webviewInstallMode` with real data: default `downloadBootstrapper` (needs internet) vs `offlineInstaller` (~127 MB) — decide in wave 4 with measured installer sizes |
| Tauri CLI/bundler prereqs | NSIS fetched/handled by Tauri at bundling; WiX/MSI needs Windows VBSCRIPT optional feature (upstream doc) | **[verify]** exactly what the first `tauri build` downloads (network needed or cache populator for CI) |
| Code signing (host exe, sidecar exe, installer) | signtool present; **no certificate** | **external gate** (purchase/issuance). Unsigned builds: document SmartScreen warnings; never claim signed distribution |
| Windows ARM64 export | rustup `aarch64-pc-windows-msvc` NOT installed; VS ARM64 C++ component not installed | later gate per project.md §15 (x64 first) — install both before starting ARM64 work |
| 8.3 short-name behavior of volumes | unverified (needs elevation for `fsutil 8dot3name`) | containment tests must include a short-name alias case regardless |
| Network-drive projects | unverified | polling watcher path must be proven by test before claiming support; otherwise state "local NTFS only, network unverified" |
| Crash-durability of rename on NTFS | design relies on it; **[verify]** with power-kill test | §12 test `T-CRASH-3` must pass before the claim ships in the user guide |
| Long paths on client machines | `LongPathsEnabled=1` here; client machines vary | code must not depend on it (§5.6) |
| Node runtime for sidecar packaging | Node 24 present; no VC redist dependency (verified) | packaging choice in wave 3 (§10.2) |
| Clean-VM test harness | not provisioned | required before "Windows game export runs without studio" claim (project.md §1.3) |

---

## 12. Test matrix — data-loss & security boundaries (required by build brief)

All run on Windows; security cases run against a hostile fixture project. Naming is stable so CI can track them.

**Containment (security):**
`T-SEC-1` symlink file pointing outside root → read/write/watch rejected `outside-root`.
`T-SEC-2` directory junction escaping root → rejected at resolution (cap-std + final-path check).
`T-SEC-3` `..`/absolute/backslash/drive-letter/UNC smuggling in `relPath` → `invalid-path`.
`T-SEC-4` ADS (`scene.json:hidden`) and device names (`NUL`, `CON`, `COM1`) → `invalid-path`.
`T-SEC-5` 8.3 short-name alias of an outside file → rejected (final-path check).
`T-SEC-6` >260-char nested path inside root → succeeds (long-path handling).
`T-SEC-7` case-collision entries (`Scenes/` and `scenes/`) → warn + deterministic resolution.
`T-SEC-8` preview surface: opening malicious project runs **zero** code (no script execution until play); preview window cannot invoke studio commands (capability probe test).

**Data-loss / CAS:**
`T-DL-1` save with stale `expectedRevision` ⇒ conflict, disk unchanged, last-good intact.
`T-DL-2` `expectedRevision=null` over existing file ⇒ conflict `exists` (never unconditional overwrite).
`T-DL-3` crash injection between temp-fsync and rename ⇒ target is old bytes; startup sweep recovers cleanly (loop 100×).
`T-DL-4` crash injection during/after replace ⇒ target is old or new complete bytes; `.forgon-bk` recovery offered when present (loop 100×).
`T-DL-5` external writer commits between CAS check and rename (forced with a test hook) ⇒ post-commit verify reports conflict, **not** silent success (this is the honesty test for cross-process claims).
`T-DL-6` file held open without `FILE_SHARE_DELETE` during save ⇒ retry → `io-busy`, no truncation, no data change.
`T-DL-7` invalid external edit (bad JSON) ⇒ `invalid` event, last valid scene retained, diagnostics point at field; invalid draft preserved for review (never applied).
`T-DL-8` batch save with manifest commit marker: kill mid-batch ⇒ recovery anchor (manifest) identifies committed subset; reopen consistent.
`T-DL-9` undo/redo across 100 ops with interleaved external accepted replacement ⇒ history cleared on external acceptance (contract), zero resurrection of stale disk state.

**Watcher races:**
`T-W-1` non-atomic editor save (truncate+write) during heavy load ⇒ final state converges to disk bytes.
`T-W-2` git checkout storm (500 files) ⇒ no spurious reload of unchanged documents (hash filter), rescan converges < 5 s.
`T-W-3` simulate ReadDirectoryChangesW overflow ⇒ `overflow-rescan` and full convergence (no missed change).
`T-W-4` self-save loop ⇒ zero infinite event loops; `reconcile` idempotency holds.
`T-W-5` playback snapshot unaffected by disk churn during play.

---

## 13. Actionable implementation plan (this is the desktop wave sequence)

**W1 — `packages/project-io` against the `HostIO` seam (no Tauri needed, ~1 day after interface sign-off)**
- Files: §4.2 layout. Implement `SceneIO` exactly per contracts.md using `@forgon/project-schema` exports; fake `HostIO` in tests.
- Tests: `T-DL-1/2/7`, watcher idempotency/reconcile interaction, contract type-level conformance (tsd or type tests), deterministic `serializeScene` byte round-trip.
- Exit: `SceneIO` behavioral conformance to contracts.md §Optimistic IO boundary, green in `pnpm test`. **Starts only after parent returns interface acceptance (§14).**

**W2 — Rust host IO module in `apps/studio-desktop`**
- Files: `src-tauri/src/io/{mod.rs, contain.rs, replace.rs, watch.rs, error.rs}`, Tauri command registration, `capabilities/desktop.json` restricted to the studio window; unit/integration tests in Rust + a Node driver test that exercises the real commands through `invoke` (or a thin CLI harness if headless is easier).
- Implement §4.1 commands, §4.4 write protocol, §4.5 watch service (notify + debounce + overflow rescan + health), §5 containment on `cap-std` + `GetFinalPathNameByHandleW`.
- Tests: `T-SEC-1..8`, `T-DL-1..9`, `T-W-1..5`. These gate any claim of conflict-safe persistence in the acceptance order.
- Exit: `SceneIO` running over real host IO in the Tauri shell; scene file → viewport → save → reopen proven on Windows with external edits.

**W3 — sidecar packaging spike + preview isolation + export staging**
- Files: `apps/studio-desktop/src-tauri/binaries/` script that builds/renames `agent-service-<triple>.exe`, NDJSON bridge, Job Object spawn; `export.ts` staged publish; preview `WebviewWindow` with empty capabilities + snapshot server.
- Measure and record here: sidecar size/startup matrix (pkg vs bun vs SEA), first `tauri build` bundling behavior (NSIS fetch), preview CSP minimum that still boots PlayCanvas.
- Tests: `T-SEC-8`, `T-DL-8`, export crash-mid-staging (target never half-written), sidecar kill/restart health.
- Exit: signed-off numbers in §3.4/§11, preview executes no code on open.

**W4 — packaging, prerequisites, honest reporting**
- `tauri.conf.json` bundle: `externalBin`, `resources`, `webviewInstallMode` decision (with measured installer sizes), NSIS `installMode`, `minimumWebview2Version` if needed.
- Prereq detection entry points (WebView2 presence check at first run with actionable message — runtime is present here, but installers must handle machines without it).
- Clean-VM test of Windows game export (external-gated: no cert until provided; report unsigned status honestly).
- Exit: verification matrix rows updated with "implemented / verified / unverified / externally blocked" per project.md §26.

Ordering rationale: W1 is unblocked by interface sign-off alone and de-risks the contract semantics before any Rust exists; W2's tests are the acceptance-order gate for persistence; W3/W4 need only W2's command surface.

---

## 14. Interface needs returned to the parent (for contracts v2)

The following are proposed above but **not yet in contracts.md**; they need the parent/Sol's contract decision before W2/W3 align code to them:

1. **Host IPC surface** (§4.1): command names/payloads (`io_open_project`, `io_read`, `io_stat`, `io_write_atomic`, `io_list`, `io_watch_start/stop`) + `forgon-io://activity` / `forgon-io://watch-status` events + `IoError` codes + `revision = "v1:sha256:<hex>"`.
2. **`HostIO` TS seam** (§4.2) as the testable boundary between project-io and Tauri.
3. **Export API** (`ExportIO` §9): export target scope rules (user-approved out-of-root dir), staged atomic publish, manifest-with-hashes requirement.
4. **Preview capability contract** (§8): empty-capability preview window, snapshot-served content with session token, no code execution on open, separate WebView2 profile.
5. **Sidecar lifecycle protocol** (§10): `hello {contractVersion}` handshake, NDJSON event transport carrying the contract's `AgentEvent` envelope, Job Object containment, "host mediates agent writes through the save lane" rule.
6. **Multi-file save semantics** (§6): proposed commit marker = CAS on `game.project.json` manifest as the batch anchor; ordered per-file CAS otherwise. Needs contract wording so editor-core/UI can model partial failure.

Nothing above changes any existing contracts.md type; all are additive seams around the agreed `SceneIO` / `EditorStore` / `AgentService` boundaries.