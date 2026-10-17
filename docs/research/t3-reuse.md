# T3 Code reuse audit

Author: reuse-research worker (Forgon wave 1)
Deliverable status: **decision input**, not implementation. No code in `apps/agent-service` or `packages/agent-bridge` was written this wave.

## 0. Scope and method

Question this document answers: for Forgon's agent boundary (`ProviderId`, `PermissionMode`, `AgentEvent`, `AgentService` in `docs/handoff/contracts.md` §Agent boundary), should we **extract** T3 Code source into Forgon, or **maintain T3 as a sidecar** and talk to it over a versioned transport?

Method actually used:

- Read upstream source from a shallow clone at `.research/t3code` (read-only audit artifact, not a dependency).
- Read upstream's own `AGENTS.md`, `docs/internals/`, `package.json`s, license, and the provider/contracts/orchestration source.
- Counted non-test LOC per package to size extraction honestly.
- Did **not** run upstream, install its dependencies, exercise its protocol, or touch the developer's live T3 install (`~/.t3/userdata`). Everything below is source-level reality, not runtime-verified.

Anything not directly read is marked **Unverified**, and nothing here is an invented protocol or a guessed API.

## 1. Pinned artifact

| Item | Value |
| --- | --- |
| Repo | `pingdotgg/t3code` (public) |
| Default branch | `main` |
| Audited commit | `2520821d575fb769875f67fca1b9c62784817452` |
| Commit date | 2026-10-16 |
| Commit subject | `perf(web): the device stream view compiles without manual memoization (#20645)` |
| License | MIT (`LICENSE`, "Copyright (c) 2026 T3 Tools Inc."; GitHub API license key `mit`) |
| Latest `main` during audit | `825450508452a60a0446378a67daa192be9d99f5` (moved during the audit; not re-cut) |

**Pin rule:** every reuse decision below is only valid against `2520821d…`. If we extract or pin a sidecar, we must pin this SHA (or a chosen successor) in the lockfile and record the license text verbatim. MIT permits vendoring and forking; it requires preserving the copyright notice and license text in redistributed copies. `@anthropic-ai/claude-agent-sdk` and `@cursor/sdk` are **not** MIT and are covered separately in §7 and §11.

## 2. Upstream architecture (what actually exists)

Upstream is a three-surface product (web, Electron desktop, React Native mobile) over one Node WebSocket server. The pieces that matter to Forgon:

- **Server** (`apps/server`): WebSocket/RPC transport, event-sourced orchestration, provider adapters, checkpointing, MCP toolkits, scheduling.
- **Contracts** (`packages/contracts`): Effect/Schema types for everything crossing the wire, including provider policy and the orchestration protocol.
- **Provider packages** (`packages/provider-*`): one package per provider runtime. `provider-core` holds the shared adapter/driver contracts.
- **Shared/client-runtime**: runtime utilities and client code shared by web + mobile.

Upstream's own description of the core loop (`AGENTS.md` "How it works"): clients send typed WS requests → server turns them into **commands** → the **orchestrator** (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides **events** without doing I/O → the **event sink** commits events + projections + command receipt + outbox effects in one transaction → the **effect worker** runs effects (start a provider turn, capture a checkpoint) and feeds results back as commands. Provider CLIs are subprocesses; per-provider **adapters** translate native protocols into orchestration events; each turn ends in a **checkpoint** (a hidden git ref).

That is the whole reuse surface in one paragraph. Everything else (relay, tunnel, device/preview automation, source-control providers, mobile nav) is product, not agent runtime, and is out of scope for Forgon's boundary.

## 3. Provider adapters (Codex / Claude / OpenCode)

### 3.1 The shared contract lives in a clean package

`packages/provider-core/src/server/` holds the adapter/driver boundary and does **not** import `apps/server`:

- `ProviderAdapter.ts` (~23 KB), `driver.ts`, `adapterDriver.ts` — the adapter contract and the driver registration shape.
- Supporting pieces: `failure.ts`, `notification.ts`, `auth.ts`, `providerAuthFlow.ts`, `usage.ts`/`usageLimits.ts`, `ModelCatalog.ts`, `maintenanceResolver.ts`, `subagentProjection.ts`, `textGeneration*.ts`, `snapshotProbe.ts`, `orchestrationInstructions.ts`, `attachmentPrompt.ts`.

Non-test LOC of `packages/provider-core`: **~6,400**. This is the genuinely extractable, app-independent part of the provider layer.

### 3.2 OpenCode is self-contained

`packages/provider-opencode/src/server/` is a self-contained package implementing the `provider-core` driver. It has both a legacy `adapter.ts` (~150 KB) and a v2 `v2/adapter.ts` (~154 KB), plus `OpenCodeRuntime.ts`, `OpenCodeServerOwner.ts`, `status.ts`, `usage.ts`, `versionProbe.ts`, `openCode2Catalog.ts`. Non-test LOC: **~12,000**. It imports `@t3tools/provider-core`, `@t3tools/contracts`, and `@opencode-ai/sdk` / `@opencode/*` (MIT) — not `apps/server`.

### 3.3 Codex and Claude are app-coupled, not packaged

The **real** Codex and Claude orchestrator adapters are **inside the app**, not in packages:

- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` (~7,100 LOC)
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (~8,900 LOC)
- plus app-side provider support in `apps/server/src/provider/`: `CodexProvider.ts`, `CodexChatGptAuth.ts` (~42 KB), `CodexInstallation.ts`, `CodexManagedRuntime.ts`, `CodexMcpElicitation.ts`, `CodexHomeLayout`-style files, `ClaudeProvider.ts`, `ClaudeModelCatalog.ts`, `ClaudeCapabilitiesProbe`, `claudeUsageLimits.ts`, `EventNdjsonLogger.ts`, etc. App-side provider code totals **~16,900 LOC**.

Each of these adapters imports roughly **20 app-internal modules** (attachment store, app config, Codex home layout, Claude executable discovery, skills, usage limits, MCP elicitation, NDJSON event loggers). They are registered through `apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts`, which mixes packaged drivers (`provider-cursor`, `provider-grok`, `provider-opencode`, `provider-pi`, `provider-acp-registry`) with the two app-local ones.

**Consequence:** "extract the Codex and Claude adapters" is not a package copy. It is a decoupling project against ~16,000 LOC of app-internal assumptions.

### 3.4 Provider vocabulary vs Forgon

Upstream `ProviderDriverKind` today: `codex`, `claudeAgent`, `opencode`, plus `cursor`, `grok`, `pi`, `muse` and `acpRegistry`/`antigravity`. Forgon's contract names `codex`, `opencode`, `claude-code`. Upstream's Claude kind is `claudeAgent`; Forgon says `claude-code`. This is a naming map, not a semantic gap, but the bridge must own the map explicitly (`claude-code → claudeAgent`).

## 4. Orchestration: scheduler, subagents, checkpoints, events

### 4.1 Orchestrator and durable effects

`apps/server/src/orchestration-v2/` is the heart and is large: **~78,000 non-test LOC**, with `Orchestrator.ts` alone at ~437 KB and `ProjectionStore.ts` at ~291 KB. Relevant modules:

- `Orchestrator.ts`, `ProjectionStore.ts`, `EventSink.ts` (~36 KB), `EffectWorker.ts` (~38 KB), `EffectOutbox.ts` (~27 KB) — the event-sourced command/event/effect pipeline.
- `RunExecutionService.ts`, `ProviderTurnStartService.ts`, `ProviderSessionManager.ts` (~106 KB), `ProviderEventIngestor.ts` (~33 KB), `ProviderRuntimeRecoveryService.ts` — turn/session lifecycle and crash recovery.
- `RuntimePolicy.ts` — runtime mode and cwd policy.
- `CheckpointCaptureService.ts`, `CheckpointRestoreSafety.ts`, `CheckpointRollbackService.ts`, `CheckpointService.ts` — turn-boundary checkpointing.
- `ThreadLaunchService.ts`, `ThreadManagementService.ts`, `ThreadForkService.ts`, `ThreadStop.ts`-adjacent services, `DelegatedTaskQuestionReactor.ts`, `SubagentProjection` tests — thread/subagent orchestration.
- `Scheduler.ts` (in `apps/server/src/scheduling/`) — a **5-second-tick** scheduler; `scheduledTasks` contracts add ~1,970 LOC.

The event pipeline is deliberately split (pure orchestrator, transactional event sink, outbox, effect worker) so side effects run after the command commits. Upstream's own testing guidance depends on this: tests must **drain** `OrchestrationEffectWorkerV2.drain` or await a specific persisted event — never sleep.

### 4.2 Checkpoints (this is the best-isolated valuable subsystem)

Checkpoint capture uses a **hidden git ref** under `refs/t3/**`. Mechanics read from source: a temporary `GIT_INDEX_FILE`, `read-tree`/`write-tree`/`commit-tree` with a synthetic author and `core.fsync=objects,reference`. It **does not touch the user's index or branch**. The VCS abstraction supports both `git` and `jj`. There is a real `apps/server/src/vcs/GitVcsDriver.ts`.

Safety detail that matters to Forgon's "rollback preserves other edits" requirement: `CheckpointRestoreSafety.ts` **refuses** file restore when the workspace is shared with another thread. `CheckpointService.ts` (~20 KB), `CheckpointStore.ts`, `CheckpointDiffQuery.ts`, and the `checkpointing/` helpers total a small, coherent ~**541 LOC** of extraction-friendly primitives on top of the VCS driver.

### 4.3 Subagents and delegated tasks

Subagent handling exists as projection + reactor code (`SubagentProjection.test.ts`, `DelegatedTaskQuestionReactor.ts`, `subagentProjection.ts` in `provider-core`) rather than a standalone "subagent engine". Upstream's delegated tasks are a first-class product concept exposed through MCP tools (§6) and the orchestrator. Forgon needs only the event surface (§9), not this machinery.

## 5. Frontend patterns

`apps/web/src` is **~236,000 LOC**; `packages/client-runtime` is **~36,600 LOC**. Upstream's stated client rules (from `AGENTS.md`):

- Client mutations go through `createEnvironmentRpcCommand`; protected methods are added to `CLIENT_GUARDED_RPC_SCOPES` in contracts, and the UI reads a `permissionAtom` for availability. **Grants are checked at execution against the destination environment; the server stays authoritative.**
- Server features are services; transports stay thin (a WS handler, HTTP route, or MCP tool decodes input, calls one service method, maps errors).
- UI primitives live in `apps/web/src/components/ui` and own their look via `variant`/`size`.

For Forgon, the transferable frontend idea is the **shape** (thin transport → service; permission-gated commands with a UI availability atom), not the code. Forgon's `apps/*` UI is not T3's UI and should not adopt T3's component library. Treat this section as "pattern worth copying," not "code worth extracting." Web/desktop/mobile internals were **not** inspected in depth this wave.

## 6. MCP toolkits (upstream features, reusable as a surface)

`apps/server/src/mcp/toolkits/` (~**9,800 LOC** total in `mcp/`) enumerates: `orchestrator`, `thread`, `project`, `worktree`, `pullRequests`, `preview`, `previewControls`, `device`, `environment`, `attachment`, `html`. Contract-side definitions in `packages/contracts/src/orchestratorMcp.ts` (~26 KB) and `threadMetadataMcp.ts`, `worktreeMcp.ts`.

This confirms every T3 orchestration tool exercised in *this* research session (`orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`, `create_threads`, `t3_thread_*`, `link_pull_request`, `watch_pull_request`, `schedule_task`, `request_secret`, `device_*`, `t3_preview_close`, `t3_workflow_stop`, `t3_attachment_discard`, `t3_pending_request_list`) is a **real upstream feature**, not a harness trick. If Forgon ever wants an agent to drive T3 features, this toolkit layer is the surface — again, a reuse-candidate surface, not a Forgon dependency.

## 7. Versioned transport and protocol

In `packages/contracts/src/environment.ts`:

- `ORCHESTRATION_PROTOCOL_VERSION = 2`, `ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2"`.
- Query param `orchestrationProtocol`, header `x-t3-orchestration-protocol`.
- `ExecutionEnvironmentDescriptor { environmentId, label, platform, serverVersion, orchestrationProtocolVersion?, capabilities }`, where `capabilities` is a broad set of granular flags a client must negotiate against.

`environmentHttp.ts` asserts the header literal on requests. This is a real, explicit, versioned protocol with capability negotiation — the single most important reason the **sidecar** option is credible (§11). A Forgon bridge can speak protocol version 2 and negotiate capabilities instead of importing server internals.

Note: the protocol is versioned, but it is **T3's** protocol. It is not a Forgon contract. Using it means Forgon depends on T3's wire format and its versioning cadence.

## 8. Dependency coupling (the real cost driver)

From the package manifests and catalogs:

- **Runtime**: Node `^24.13.1` at root; `apps/server` `^22.16 || ^23.11 || >=24.10`. Package manager pinned `pnpm@11.10.0`.
- **Effect**: `effect` **4.0.5** — the orchestrator, contracts, and provider packages are Effect-heavy. This is the deepest coupling: reuse of orchestration code means reusing Effect 4 semantics and services.
- **TypeScript**: **7.0.2** (native `tsc-rs` 0.7.0 compiler path). Forgon's toolchain is mainstream TS; TS 7 is a moving target.
- **Build**: `vite-plus@1.0.0` (`npm:@voidzero-dev/vite-plus-core`). Upstream's `vp` CLI drives install/test/dev. Not Forgon's toolchain.
- **UI**: React 19.3 catalog (web pins 19.2.6).
- **Provider SDKs** (the licensing-sensitive set):
  - `@anthropic-ai/claude-agent-sdk` `^0.3.276` — license field is `"SEE LICENSE IN README.md"` (**non-SPDX; needs manual review**). Latest was 0.3.302 during audit. **Unverified** terms.
  - `@cursor/sdk` `1.0.35` — license field `"SEE LICENSE IN LICENSE.md"` (**non-SPDX; needs manual review**). Not needed for Forgon's three-provider set.
  - `@opencode-ai/sdk` `^1.3.15` (MIT), `@opencode/{client,protocol,schema}` `2.0.28` (MIT) — clean.
  - `@muse-code/sdk` `1.4.6`.
  - `node-pty` `^1.2.0-beta.15`, `playwright-core` `1.60.0`, `@napi-rs/keyring`, `@ff-labs/fff-node`.
- `packages/effect-codex-app-server` is generated from `openai/codex` `codex-rs/app-server-protocol` pinned at `687a119f0fcaace47e1f1abcc77cec6c813fd6da`.

Every workspace package is `"private": true` **except `apps/server`**, which publishes to npm as **`t3`** (MIT, `bin` → `dist/bin.mjs`, Node SEA archives). I verified **no `packages/*` imports `apps/server` source** — the package boundary genuinely holds. Extraction of packages is mechanically possible; extraction of app-internal adapters is not.

## 9. Security analysis

**Permission enforcement.** Upstream `RuntimeMode` (`packages/contracts/src/providerPolicy.ts`) = `approval-required` | `auto-accept-edits` | `auto` | `full-access`, default **`full-access`**. Separately `ProviderApprovalPolicy` (`untrusted`/`on-failure`/`on-request`/`never`), `ProviderSandboxMode` (`read-only`/`workspace-write`/`danger-full-access`), and `ProviderRequestKind` (`command`/`file-read`/`file-change`/`mcp-elicitation`/`permission`). Upstream's own docs state T3's approval check is **weaker than the provider's own enforcement** — approval is a UX gate, not a sandbox.

Mapping to Forgon `PermissionMode` (`inspect`/`supervised`/`auto-edits`/`full-local`):

- `auto-edits` ≈ `auto-accept-edits`; `full-local` ≈ `full-access`; `supervised` ≈ `approval-required` (coarse).
- **`inspect` has no upstream equivalent.** It is a Forgon addition (read-only intent) and must be enforced by Forgon, not delegated to T3.
- Forgon's contract already states "permission labels alone confer no sandbox guarantee." This audit confirms upstream behaves the same way. **The bridge must refuse to simulate unsupported controls** (matching `AgentService`'s "unsupported controls must be reported unavailable rather than simulated").

**Auth.** Per-RPC scopes (`RpcAuthorization.ts`), DPoP-bound tokens, short-lived WebSocket tickets, and a separate `/mcp` OAuth audience with `orchestration:read` / `orchestration:operate` ceilings. This is a real, non-trivial auth system.

**Command cwd.** Project records are **not** filesystem sandboxes: `filesystem:read` permits absolute paths. Containment is enforced by `WorkspaceFileSystem.ts` (workspace-relative containment, rejects symlink escapes) and `workspaceLease.ts` (serializes per-cwd operations). Forgon's requirement that commands run in a confined cwd is **partially** satisfied upstream and must be re-asserted at the Forgon boundary.

**Rollback preserving other edits.** Checkpoint restore is scoped to hidden refs and refuses to restore files when a workspace is shared across threads (`CheckpointRestoreSafety.ts`). This is exactly the property Forgon wants ("rollback that preserves other edits"). It is the strongest reuse candidate.

## 10. Upstream reality vs this host's extensions

| Thing | Upstream T3 | This host / Forgon |
| --- | --- | --- |
| T3 orchestration MCP tools | Real, in `apps/server/src/mcp/toolkits/*` + contracts | Consumed as-is by the agent |
| Code Mode / tool catalog wrapper | Not upstream | OpenCode harness injection |
| Orchestration system prompt | Not a single upstream artifact | Harness-injected context |
| Provider names | `codex`/`claudeAgent`/`opencode`/… | `claude-code` for Claude |
| Permission modes | `full-access` default | `inspect`/`supervised`/`auto-edits`/`full-local`; `inspect` is new |
| Protocol | `x-t3-orchestration-protocol: 2` | Forgon `AgentEvent`/`AgentService` (version 1) |

Everything host-specific is in the harness, not in T3. A Forgon sidecar talks to **T3 as it ships**, plus a thin Forgon-owned mapping layer.

## 11. Recommendation: maintained sidecar + thin typed bridge (not extraction)

**Decision: do not fork/extract T3's orchestrator, and do not vendor the app-coupled Codex/Claude adapters. Maintain upstream `t3` as a pinned sidecar and build a thin, typed contract layer in `packages/agent-bridge` that speaks T3's versioned protocol and maps it to Forgon's `AgentEvent`/`AgentService`.**

Why not extraction:

- The valuable orchestration core is **~78,000 LOC of Effect 4.0.5** code entangled with `apps/server` services, plus ~16,900 LOC of app-coupled adapters. Extraction means maintaining a fork of a fast-moving codebase (upstream `main` advanced mid-audit) on TS 7 / `vite-plus` / Effect 4 — all outside Forgon's toolchain.
- Codex and Claude adapters import ~20 app-internal modules each; they are not extractable without a decoupling project comparable in size to reimplementation.
- Only `packages/provider-core` (~6,400 LOC) and `packages/provider-opencode` (~12,000 LOC) are cleanly extractable, and extracting them still drags in Effect 4 and the T3 contracts.

Why the sidecar is credible:

- There is a **real, versioned, capability-negotiated protocol** (`ORCHESTRATION_PROTOCOL_VERSION = 2`, header `x-t3-orchestration-protocol`). A bridge can negotiate instead of importing internals.
- Checkpoints (hidden `refs/t3/**`, restore-safety guard) already deliver Forgon's "rollback preserves other edits."
- `apps/server` publishes as **`t3`** with a `bin`, so running it as a managed sidecar process is supported by upstream packaging.

Trade-offs the parent must accept for the sidecar option:

- Forgon inherits T3's protocol version cadence and must **pin `2520821d…`** (or a chosen successor) and gate upgrades behind protocol compatibility.
- Forgon inherits T3's dependency/license surface. `@anthropic-ai/claude-agent-sdk` and `@cursor/sdk` are **non-SPDX licenses requiring manual legal review** before shipping a sidecar that includes them. `@cursor/sdk` is not needed for Forgon's three providers and should be excluded.
- Forgon inherits the fact that `full-access` is T3's default and its approval gate is weaker than provider enforcement — so Forgon must own `inspect` and enforce its own boundary.

**Fallback if a sidecar is rejected (e.g. no second process allowed):** extract only `packages/provider-core` + `packages/provider-opencode` as vendored packages pinned to `2520821d…`, and write Forgon-owned minimal adapters for Codex/Claude instead of extracting T3's app-coupled ones. This is materially more work and should be a separate, explicitly-scoped wave.

## 12. Implementation breakdown (for the parent to dispatch)

Two owners, per `docs/handoff/build-brief.md` and `contracts.md`:

### `packages/agent-bridge` (transport + mapping, no provider logic)

1. **Transport client.** Speak T3 protocol v2: negotiate `x-t3-orchestration-protocol: 2` and `capabilities` from `ExecutionEnvironmentDescriptor`. Pin the protocol constant; fail loudly on mismatch.
2. **Event mapping.** Translate T3 orchestration events → Forgon `AgentEvent` (`started`/`text`/`tool`/`diagnostic`/`approval`/`diff`/`completed`), assigning the `{runId,threadId,sequence,timestamp}` envelope. Sequence is monotonic per run; no secrets in events.
3. **Service facade.** Implement Forgon `AgentService` (`start`/`cancel`/`approve`/`subscribe`) over the transport.
4. **Provider map.** Own `claude-code → claudeAgent` and reject providers outside `{codex, opencode, claude-code}`.
5. **Permission map.** Own the `PermissionMode` map; **refuse `inspect`** to T3 and enforce it at the Forgon side; report unsupported controls as unavailable (never simulate).

### `apps/agent-service` (sidecar lifecycle + enforcement)

1. **Sidecar manager.** Launch/stop/pin the `t3` server as a managed child process at a pinned version/SHA; isolate its home/state from the developer's live `~/.t3`; capture the spawn PID for clean shutdown.
2. **Auth.** Obtain and refresh the short-lived WS ticket; keep tokens out of events and logs.
3. **cwd containment.** Re-assert workspace-relative containment for all command execution at the Forgon boundary; do not rely on T3's project records as a sandbox.
4. **Rollback.** Use T3 checkpoint capture/restore, honoring the shared-workspace restore guard so rollback cannot clobber other edits.
5. **Unsupported-control reporting.** Surface "unavailable, not simulated" for any control Forgon cannot guarantee.

## 13. Reuse decision summary

| Subsystem | Upstream path | Decision |
| --- | --- | --- |
| Orchestration core (~78k LOC, Effect 4) | `apps/server/src/orchestration-v2/` | **Do not extract.** Consume via sidecar + protocol. |
| Codex/Claude adapters (~16.9k LOC, app-coupled) | `apps/server/src/orchestration-v2/Adapters/`, `apps/server/src/provider/` | **Do not extract/vendor.** Use sidecar. |
| OpenCode provider | `packages/provider-opencode/` | **Extractable** (self-contained, MIT deps) but only needed under the fallback option. |
| Provider contract/driver core | `packages/provider-core/` | Reference for Forgon's adapter boundary shape; **do not adopt** Effect 4 wholesale. |
| Checkpointing (~541 LOC + VCS driver) | `apps/server/src/checkpointing/`, `apps/server/src/vcs/GitVcsDriver.ts`, `orchestration-v2/Checkpoint*` | **Highest-value, best-isolated.** Reuse via sidecar; candidate for focused extraction if sidecar is rejected. |
| Scheduler (5s tick) | `apps/server/src/scheduling/` | Out of Forgon scope; ignore. |
| Versioned transport | `packages/contracts/src/environment.ts`, `environmentHttp.ts` | **Adopt as the bridge's wire contract** (pin protocol 2). |
| Permission/runtime policy | `packages/contracts/src/providerPolicy.ts` | **Map, don't adopt defaults.** Enforce `inspect` in Forgon. |
| Frontend (~236k LOC) | `apps/web/`, `packages/client-runtime/` | Copy the *shape* (thin transport→service, permission-gated commands); **no code import.** |
| MCP toolkits (~9.8k LOC) | `apps/server/src/mcp/toolkits/` | Exists upstream; use only if Forgon wants agents to drive T3 features. |

## 14. Verification limits and open questions

- **Not verified at runtime.** No upstream server was started; the protocol was read, not exercised.
- **License gap.** `@anthropic-ai/claude-agent-sdk` (and `@cursor/sdk`) use non-SPDX license fields; manual review is required before shipping a sidecar that bundles them.
- **Not inspected in depth:** desktop, mobile, relay/tunnel, source-control providers, web internals.
- **Upstream drift.** `main` moved during the audit; the pin in §1 must be re-confirmed at implementation time.
- **Open for the parent:** (a) is a second managed process acceptable? (b) who owns cross-process cwd containment and auth? (c) sidecar lifecycle vs Forgon app shutdown? (d) which protocol version do we commit to as the bridge's floor?
