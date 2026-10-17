# Forgon Engine UI implementation notes (UI lane, wave 3)

Owner: UI sub-agent (Haiku 5.5). Scope: `apps/studio` and `packages/editor-ui`. Contracts: `docs/handoff/contracts.md` v1, consumed as written. Direction: `design.md`, `docs/research/ui-direction.md`, `project.md` sections 7 and 8, and `docs/research/authoring-cli.md` for component conventions.

Status: wave 3 resumed and completed at the UI layer. Editable typed properties, hierarchy reparent and duplicate, scene switching with dirty-state protection, viewport tool and frame hooks, honest permissions, a shared right column below 1680 px, keyboard resizing, measured contrast, and lifecycle tests are implemented. Nothing is wired to a real host, agent, or runtime yet. `apps/studio/src/services.ts` still passes `null` for all three services, so the shipped app shows those capabilities as unavailable.

## 1. Files

`packages/editor-ui`:

- `src/services.ts`: the UI boundary types (below). Adds `ViewportTool`, `ViewportCallbacks.onTransform`, optional `ViewportHandle.setTool` and `frameSelection`, and `AgentProviderInfo.limits`.
- `src/session/sceneSession.ts`: `SceneSession` (one open scene: read, watch, edit, save, dispose) and `SceneHost` (the shown scene plus at most one candidate). Plain TypeScript, no React, so the lifecycle is testable under Node.
- `src/model/hierarchyOps.ts`: reparent, indent/outdent, and duplicate planning. Each returns a `SceneCommand` or a human-readable reason.
- `src/model/properties.ts`: property kind classification, finite JSON draft parsing, and `withProperty` (whole-component upsert).
- `src/model/sceneSwitch.ts`: `planSceneSwitch` (none, switch, confirm, blocked).
- `src/model/layout.ts`: adds `rightDockSharesInspector` (below 1680 px), `keyboardResize`, and step constants.
- `src/agent/permissions.ts`: rewritten. See section 5.
- `src/panels/inspector/Inspector.tsx`: typed editors per property kind.
- `src/panels/hierarchy/Hierarchy.tsx`: drag-and-drop reparent, Alt+Arrow indent and outdent, Ctrl+D duplicate.
- `src/shell/Workspace.tsx`: scene picker, dirty-switch confirmation, tool buttons and keys, Frame, shared right column, `onTransform` routed through the store.
- `src/shell/ViewportSlot.tsx`: forwards `onTransform`. The canvas container stays mounted.
- `src/shell/Dock.tsx`: `shared` prop for the narrow-window placement.
- `src/theme/studio.css`: new rules for viewport toolbar, banner stack, shared tabs, property editors, and drop targets.
- `test/editing.test.ts`, `test/session.test.ts`, `test/contrast.test.ts` (new); `test/agent.test.ts`, `test/render.test.tsx`, `test/model.test.ts` (updated).

`apps/studio`:

- `src/useSceneSession.ts`: a thin React binding over `SceneHost`. It subscribes with `useSyncExternalStore` and returns `loading`, `failed`, or `ready` (with the shown session, its store, and any notice).
- `src/App.tsx`: the scene path is state. Switching changes the path; agent and layout state stay mounted in the same workspace component.
- `src/services.ts`, `src/sample.ts`, `src/main.tsx`: unchanged in this wave.

## 2. Service interfaces (what the parent wires)

All in `packages/editor-ui/src/services.ts`, exported from `@forgon/editor-ui`. Changes since wave 1 are marked **new**.

```ts
export type ViewportTool = 'select' | 'translate' | 'rotate' | 'scale';   // new

export interface AgentProviderInfo {
  id: ProviderId; name: string; readiness: ProviderReadiness; message?: string;
  models: readonly string[]; permissionModes: readonly PermissionMode[];
  limits?: readonly string[];   // new: plain-language limits the adapter reports
}

export interface ViewportCallbacks {
  onPick(entityId: string | null): void;
  onFault(message: string): void;
  onTransform(entityId: string, transform: Transform): void;   // new
}
export interface ViewportHandle {
  update(view: ViewportView): void;
  setTool?(tool: ViewportTool): void;      // new, optional
  frameSelection?(): void;                 // new, optional
  play?(scene: SceneDocument): void;
  stop?(): void;
  dispose(): void;
}
```

Host obligations, unchanged from wave 1 and still required:

- `ProjectSession.manifest`, `assets`, and `prefabs` are already validated with catalogs.
- `sceneIO.saveScene` returns `{status:'conflict', current:null}` when the file is missing or unparseable. The UI reports it and never overwrites.
- `AgentConnection.providers[].permissionModes` lists only modes the adapter enforces. The composer offers exactly those.
- `AgentProviderInfo.limits` lists what the adapter cannot guarantee. Omitting it is shown as "did not report its limits", never as safe.

Viewport obligations (new):

- `onTransform` should fire once per gesture commit, not once per pointer move. Each call becomes one undo step in the store.
- `setTool` and `frameSelection` are optional. When absent, the toolbar buttons are disabled and say the runtime is not connected.

## 3. Contract consumption

- Editing goes through `EditorStore.execute` only. Inspector property edits send a whole-component `component` upsert built by `withProperty`. Duplicate sends one `batch` of `create` commands. Reparent sends `reparent` (or a `batch`). Store exceptions are caught and written to the Console, and nothing is applied.
- Save: `prepareSave` → `sceneIO.saveScene` → `acknowledgeSave` on `saved`. A watcher event that matches a pending save is accepted once, and the acknowledgement is still honored (tested in `session.test.ts`).
- Watch: `changed` → `reconcile`. `invalid` → banner, last valid scene kept. `deleted` → banner, save blocked with a reason.
- Watch before read: the session subscribes before the first read and replays any event that arrives during the load, so a change between the read and the subscription is not lost.
- Scene switch: `SceneHost.open(path)` loads a candidate. The shown scene is replaced only after the candidate is ready. A failed or superseded candidate never replaces the shown scene, and its watcher is released. A failure is shown as a notice and can be dismissed.
- Scene switch with unsaved edits: `planSceneSwitch` returns `confirm`. The banner offers Save and switch (switches only if the save resolves `true`), Discard and switch, or Keep editing. A file conflict returns `blocked` with a reason.
- Conflicts: `ConflictCard` shows `diffScenes(ours, theirs)`. Keep mine → `resolveConflict('ours')`. Use file version → `resolveConflict('theirs')`. Neither writes disk.
- Agent: events are folded per run with duplicate and out-of-order sequences ignored. Approval buttons call `approve` once per request; a second click while the first is in flight is ignored. Approvals are never sent without a click.

## 4. Interaction decisions

- Ctrl+Enter sends; Enter inserts a newline; IME composition never sends. Unchanged.
- Shortcuts are scoped to the workspace root. Nothing is intercepted while typing in an input, textarea, select, or contenteditable.
  - Ctrl+S save, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z undo and redo, Ctrl+L focus composer, Ctrl+Shift+L add selection to the message, Ctrl+\ hierarchy.
  - Q / W / E / R select, move, rotate, scale (when the runtime supports gizmos). F frames the selection.
  - Ctrl+D duplicates the selection when the hierarchy has focus.
  - Hierarchy: arrows, Shift/Ctrl selection, Home/End, Enter or F2 rename, Delete, Ctrl+A, Escape, Alt+Left/Right outdent or indent.
- Reparent rules (`hierarchyOps.ts`): no cycles, no self-parenting, no unknown parent. Prefab instance members cannot be moved or duplicated. A move over a selection moves only the topmost objects, so children travel with a selected parent. After a move, the new parent is expanded and the moved object keeps focus.
- Duplicate: each topmost selected object is copied with its subtree. Copies get fresh stable IDs and a " copy" name. References inside the copied subtree (entityRefs, and entity or component IDs in properties) are remapped. References outside it are kept. Copies are appended to the scene.
- Layout: below 1680 px the right dock becomes a "Panels" tab in the inspector column. At 1680 px and above it keeps its own column. The layout persists per project in `localStorage`.
- Keyboard resizing on separators: arrows move 8 px, Shift+arrows 32 px, Home sets the minimum, End sets the maximum.
- Play is enabled only when `ViewportHandle.play` exists. Edits are disabled while playing. Viewport updates pause so a disk change does not reset the simulation.

## 5. Permissions (corrected claim)

Wave 1 said "Enforced by Forgon host and adapter." for every mode except full-local. That was an overclaim. Forgon has no adapter, and nothing yet enforces these modes. The current copy is:

- Inspect: asks for read-only access; Forgon refuses writes it can intercept; not an operating-system sandbox.
- Supervised: asks for approval before each request Forgon receives; cannot see provider actions that are not reported to it.
- Auto edits: lets the provider edit project files without asking; cannot limit edits beyond what the provider reports.
- Full local: no approval prompts; once a provider CLI runs, Forgon cannot limit what it does.

The provider table and the composer footer also show the provider's own `limits`. When none are reported, the UI says so and treats every mode as unverified.

Defaults never select full-local. `defaultPermissionMode` picks supervised, then inspect, then auto-edits. If only full-local is supported, the default is `null`. The thread then reads "Choose a mode" and sending is blocked until the user picks one. Thread permission modes are nullable for this reason.

## 6. Verification (run in the repo, this wave)

Commands run from the repository root:

```text
pnpm --filter @forgon/editor-ui --filter @forgon/studio typecheck   exit 0, no TS errors
pnpm --filter @forgon/editor-ui --filter @forgon/studio test        exit 0
pnpm --filter @forgon/studio build                                  exit 0 (61 modules; JS 366 kB, gzip 107 kB)
```

Test counts: 67 passing in `@forgon/editor-ui` (agent 13, contrast 6, editing 14, model 9, render 10, session 15) and 2 passing in `@forgon/studio`. Zero failures or skips.

What the new tests cover:

- Hierarchy: cycle, self-parent, and unknown-parent refusal; prefab refusal; topmost-only moves; indent and outdent targets; duplicate with remapped references, checked by applying the batch through `applyCommand` and `parseScene`; duplicate as a single undo step.
- Properties: kind classification, finite JSON parsing (1e400 is rejected), whole-component upsert that changes one key, and a store-level check that a NaN property is rejected with the state unchanged.
- Layout and switching: keyboard resize steps and clamps, the 1680 px threshold, and the scene switch plan.
- Session lifecycle (fake `SceneIO` with held reads and saves): clean open and watch subscription; superseded load not replacing the shown scene and its watcher released; failed open keeping the shown scene with a dismissable notice; events arriving during the first read replayed; detached save with expected revision; stale save returning a conflict and blocking further saves; missing file never overwritten; watcher-before-acknowledgement race; edits made during a save remaining dirty; invalid and deleted events; external clean reload and dirty conflict; dispose releasing the watcher and ignoring late reads and events; in-memory sample never saved; host notifications.
- Contrast: computed from the shipped `studio.css` tokens with OKLCH-to-sRGB conversion (checked: white/black gives 21:1). Results: primary text 13.0 to 17.0:1, secondary 7.5 to 9.8:1, muted 5.2 to 6.8:1, status colours 5.7 to 10.2:1 on panel, primary button label 7.8:1, focus ring 8.2:1 on canvas. The lowest pair is muted text on the hover surface (5.23:1). All text pairs pass WCAG AA. No token needed to change.
- Render: SSR of the workspace with scene picker, disabled viewport tools with reasons, shared right column default, typed property editors, and provider limits.

Not run: a browser, a desktop launch, or WebView2 focus and IME checks. The parent owns browser QA as instructed.

## 7. Integration needs (next wave, parent or other lanes)

1. Parent: `pnpm install` is already reflected in the lockfile from earlier waves. No new dependencies were added in this wave.
2. Desktop (MiMo): implement `ProjectHost` and produce `ProjectSession.sceneIO` with byte revisions and watch events, then replace `services.project` in `apps/studio/src/services.ts`.
3. Agent (DeepSeek): implement `AgentService`, report per-provider readiness, enforced permission modes, and `limits`, then replace `services.agent`.
4. Engine (GLM): implement `ViewportMount` with a stable canvas container, `onPick`, `onTransform` (once per gesture commit), and optional `setTool`, `frameSelection`, `play`, `stop`.
5. Layout persistence: a `KeyValueStorage` adapter can be passed from `App.tsx` if desktop IPC is preferred. Currently `globalThis.localStorage`.

## 8. Gaps and contract requests (not claimed as done)

Editing:

- Entity `enabled` is still read-only. Contract v1 has no command for it.
- Component properties can be edited, but not added or removed. Contract v1 has no property-patch command beyond whole-component upsert. The inspector offers only existing keys.
- Conflicts block all edits, not only the conflicting property. The store has no per-property merge, so "Edit merged" is omitted.
- Hierarchy is a plain DOM list. Virtualization above 200 rows is not implemented.
- Drag-and-drop uses HTML5 drag events. Its drop rules are tested through the pure planner, but the gesture itself has not been exercised in a browser or WebView2.
- Duplicate and reparent refuse prefab instance members. Prefab-aware editing belongs to the generator lane.
- The scene picker shows scene paths, not names. The manifest has no display name for scenes.

Viewport:

- Gizmos, framing, and the Play snapshot are wired to the boundary only. Nothing is connected, so Move, Rotate, Scale, and Frame are disabled in the shipped app.
- Undo granularity for drag gestures depends on the viewport calling `onTransform` on commit, not on every move.

Agent:

- Contract v1 has no provider probe. "Check again" is disabled with that reason. Sign-in commands, plan mode, resume, and usage are not shown.
- Thread state is in memory only and is lost on reload. Persistence belongs to the agent service.
- Review shows only changed paths from `diff` events. There is no semantic diff, check status, checkpoint, accept, discard, or restore. Those controls are disabled with reasons.
- Context chips cover entity, scene, and asset only (the AgentContext v1 fields). Screenshots, console errors, and file chips are not offered.

Testing:

- No DOM test environment is installed (no jsdom or testing library). The React binding `useSceneSession` and the interactive paths (drag, key shortcuts, banners) are therefore covered by the Node-level lifecycle and planner tests plus SSR, not by component interaction tests. This is a real gap for the browser QA pass.

Contract requests for the parent:

- A provider readiness probe.
- An entity `enabled` command.
- A component property add and remove command, or an explicit decision that whole-component upsert is the only path.
- Per-property conflict records, so a conflict can block only the affected property.
- Checkpoint and draft types for Review.

The shared types `SelectionState`, `ProjectHealth`, `ProviderStatus`, `DraftChange`, `CheckpointRef`, and `ContextChip` from `ui-direction.md` are still not in contract v1. The UI uses local types at the service boundary. Promote any of them only through `contracts.md`.
