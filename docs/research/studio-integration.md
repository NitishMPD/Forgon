# Studio integration
Author: Nitish

## Ownership and implementation

This lane owns apps/studio, packages/editor-ui, the narrow editor-core enabled command, and this note. Parent owns root docs/tasks/install/lock and browser QA; runtime, desktop and agent lanes retain their packages.

Work sequence: extend existing scene commands and inspector; fix save completion/error and lifecycle guards; correct create destination UX and expose optional asset capabilities; connect actual browser-safe exported adapters once present; run focused tests/typechecks/build.

## Additive interfaces for active lanes

Existing required ProjectHost/ProjectSession APIs remain unchanged. UI ProjectSession optionally accepts Node-compatible `readCatalog(): Promise<{manifest: ProjectManifest; assets: {assets: AssetRecord[]}; prefabs: PrefabDocument[]}>` and `readAsset(assetId): Promise<{asset: AssetRecord; bytes: Uint8Array; revision: string}>`. Native sessions already have these shapes. UI refresh updates metadata without reopening/discarding a dirty scene.

ProjectHost optional `planCreateChild(parent: string, name: string): Promise<CreatePlan>` must validate a single Windows-safe folder name, join in the host, and return the exact nonexistent child root/files for confirmation. Existing `planCreate(root)` remains for explicit destinations; no renderer Node paths. New project UI chooses parent then name. Existing-folder failures guide users toward a new child rather than claiming IO can merge into an existing directory.

ProjectSession optional `importAsset(license: string): Promise<void>` owns native file selection/cancellation, registry revision capture and real asset-pipeline import. UI collects the required license declaration, awaits completion, then invokes readCatalog. No source path is typed or read by renderer.

ViewportView gains optional `assets`, `prefabs`, and `resolveAsset(assetId): Promise<Uint8Array>`; these belong to the current project session, absent for memory sample. Runtime should use the supplied catalogs and resolver rather than global stale state. Existing scene/selectedIds and onTransform/setTool/frameSelection/play/stop contract remains unchanged.

AgentConnection may expose optional `refreshProviders(): Promise<readonly AgentProviderInfo[]>`; renderer publishes a new connection snapshot after refresh, preserving the same service.

Core adds `{type: 'enabled', entityId: string, enabled: boolean}` through the existing atomic validation/undo path. No document schema change.

## Pending integration

At initial inspection runtime editor-viewport export source, agent-bridge source and desktop package are not yet present. Services remain unconnected until actual exports can be read; no mocked adapters are substituted.

## Integration findings after implementation

Viewport mount accepts an optional third `ViewportMountOptions` argument matching runtime core/types.ts: context and loadAssetBytes. ViewportSlot supplies a live context getter and resolver tied to its latest project view; mount need not be replaced to refresh catalogs. GLM's current runtime types use these mount options rather than ViewportView catalog fields.

Catalog refresh requires the additive `EditorStore.updateContext(context)` method: it validates the current, baseline, undo/redo and conflict snapshots before replacing catalogs. It changes neither history nor dirty state. SceneSession/SceneHost propagate catalogs to the responsible store. This is the sole non-command core addition required by real refresh; stale catalogs otherwise reject newly imported references indefinitely. Scene switching obtains the session's latest detached catalogs before opening.

New-project destination has a browser-safe fallback for existing NodeProjectHost: validate a single Windows-safe child name, form the path using the parent's slash style, then call existing planCreate. Native planCreateChild, when supplied, owns the join. In both paths host containment/create-only validation remains authoritative.

Runtime editor-viewport source arrived during final checks. Studio now imports the actual `mountEditorViewport` browser-safe package export; apps/studio adds @forgon/game-runtime workspace dependency (parent retains install/lock ownership). ViewportSlot passes an object with live assets/prefabs getters because runtime currently caches options.context at mount. Audio resolver similarly reads the current session ref.

Runtime integration issues observed in the newly arriving source (GLM-owned): object-literal methods spelled `setTool?`, `frameSelection?`, `play?`, `stop?` are invalid optional member declarations in implementations; trailing `void _Unused` refers to a type as a value. Runtime play catches startup errors and only calls onFault, so UI cannot reliably know whether play began; play should throw on failed startup or report actual play state. Studio does not modify this lane's files.

## Handoff status (17 October 2026)

Implemented in this lane:
- New project chooses parent plus safe child name and displays exact planned destination/files before calling create. IO still owns create-only safety. Existing-folder failure offers the child-folder flow.
- Inspector entity Enabled is an undoable validated command. Advanced Properties JSON edits use whole-component upsert for key additions/removals; no patch framework. Unsupported generated structural/property-key edits fail visibly and retain dirty state.
- Asset Refresh and native Import UI are capability driven, collect a required license declaration and refresh detached catalogs after import. Optional refreshProviders drives Check again and asynchronously updates provider snapshots.
- Viewport uses the actual browser-safe mountEditorViewport export and current session catalogs/asset-byte resolver. Mount failure is surfaced; changed mount receives its initial view; dock changes retain the canvas.
- Save-and-switch refuses when newer edits remain dirty; candidate scene loads refuse to replace a scene edited during loading; failed/rejected scene switches can be retried. Dirty close/discard guard remains and browser unload warns; close/switch during saves is blocked. Save failures show their cause and preserve work.

Checks before the runtime export landed: all three package typechecks passed; Studio Vite build passed (63 modules); 17 core + 70 UI + 3 Studio tests passed, including actual temporary-filesystem generated override save/close/reopen and structural rejection with unchanged disk bytes. Impeccable mechanical detector returned zero findings. No browser/server/app launch was performed.

Current connected check after wiring the arriving runtime: `pnpm --filter @forgon/studio typecheck` fails **inside game-runtime**, not Studio/UI. Exact classes observed: BoundingBox getCenter/getHalfExtents APIs; missing EVENT_TRANSFORM* exports; nullable addComponent results and primitive union narrowing; undefined definition in projection.ts; getLocal* methods called with unsupported output arguments; optional object implementation methods TS1162 and `_Unused` type-as-value; guestQueueDefinition narrowing causes never properties in play-session.ts. Studio tsconfig now includes the runtime's shipped declaration for playcanvas/scripts/esm/grid.mjs. GLM must complete/fix its package, then parent reruns connected typecheck/build/browser QA. Earlier passing build is not a claim that the newly connected runtime builds.

Still missing, precisely:
1. apps/studio-desktop does not exist in this checkout at handoff. Need its actual browser-safe project factory/transport export implementing ProjectHost, optional readCatalog/readAsset/importAsset and openExample-copy behavior. No renderer filesystem/Node import was substituted.
2. apps/agent-service/src/service.ts now exposes createAgentService but imports node:path and persistence: renderer must not consume it. Need desktop/browser-safe AgentConnection facade/IPC export with provider metadata and actually enforced permission modes. Agent bridge currently exposes protocol/connectT3, not a complete browser-safe AgentService factory, so no speculative credentials or raw connection UI was added.
3. services.ts currently connects viewport only; project and agent remain explicitly null until those real exports arrive. Asset import/example capabilities are therefore not exercised end to end.

Launch/check commands for parent (repository root):

```powershell
pnpm --filter @forgon/editor-core --filter @forgon/editor-ui --filter @forgon/studio typecheck
pnpm --filter @forgon/editor-core --filter @forgon/editor-ui --filter @forgon/studio test
pnpm --filter @forgon/studio build
pnpm --filter @forgon/studio dev --host 127.0.0.1
```

Vite default URL is http://127.0.0.1:5173 (or the next available port). Desktop launch command cannot be specified until its package exists. Parent owns one integrated browser QA once runtime/native host land, root install/lock reconciliation, project/design/task documentation and ownership handback. pnpm auto-prepared workspace resolution when adding the runtime dependency during typecheck; no explicit install, manual lockfile change, branches, commits, push or deployment occurred here.
