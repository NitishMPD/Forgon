# Forgon Engine UI direction (wave 1)

Owner: design sub-agent (Haiku 5.5, UI lane for `apps/studio` and `packages/editor-ui`).
Status: plan only. No app code, no root docs, no design docs edited. Shared contracts are
requested in section 11 and are not frozen here. Values below are proposals until the parent
freezes them in `docs/handoff/contracts.md`.

---

## 0. Sources, method, assumptions

**Read:** `project.md` (sections 0, 1.2, 2, 7, 8, 9, 13.2), `docs/handoff/build-brief.md`.

**T3 Code upstream** (`pingdotgg/t3code`, `main` as read on 17 Oct 2026; no commit pinned yet, the
parent must pin one before any extraction):

- Docs: `docs/user/keybindings.md` (when-context keys, `mod+shift+*` composer shortcuts, send-shortcut
  setting), `docs/user/appearance.md` (theme tokens, panel animation default is immediate),
  `docs/user/thread-sidebar.md` (pinned/active/settled sections, Undo notices, thread states),
  `docs/user/permission-modes.md` (Supervised / Auto-accept edits / Auto / Full access),
  `docs/internals/architecture.md` (client vs environment ownership; checkpoints via hidden refs;
  a provider that cannot roll back must reject revert before touching files).
- Tokens: `apps/web/src/index.css`. Tailwind v4, zinc neutrals, dark canvas `neutral-950`,
  borders at 6% white, `--control-radius: 0.5rem`, `--chat-content-max-width: 46rem`,
  workspace topbar 52px, `--text-2xs` 11px / `--text-3xs` 10px, drawer easing
  `cubic-bezier(0.32, 0.72, 0, 1)`.
- Components (names only, reuse decisions in section 7): `Sidebar.tsx`, `ChatView.tsx`,
  `ComposerPromptEditorTiptap.tsx`, `ContextChip.tsx`, `DiffPanel.tsx`, `RightPanelTabs.tsx`,
  `RightPanelSheet.tsx`, `ThreadTerminalDrawer.tsx`, `CommandPalette.tsx`, `keybindings.ts`,
  `ThreadStatusIndicators.tsx`, `PermissionUpdateNotice.tsx`, `AnimatedHeight.tsx`,
  `appearanceContrast.ts`, `panelAnimations.ts`.

**Impeccable:** context loaded once. Result: no `PRODUCT.md`, no `DESIGN.md`, no UI code yet.
Per the skill, a new surface normally goes through `init` first. This wave may not write root or
design docs, so product context is inferred from `project.md` and the brief, and every inference is
labelled as an assumption here. **Parent decision needed:** run `init` to create `PRODUCT.md` before
wave 2 UI work. Mode for this surface: **Operate** (an editor tool; scanability and task speed beat
expression). Brand expression lives in precise details, not in hero moments.

**Assumptions (labelled):**

- A1. Windows-first Tauri 2 on WebView2. Minimum window 1280x800 CSS px; design reference
  1440x900 and 1920x1080 at 100% and 125% scale.
- A2. One main window in V1. Multi-window and detached preview are later.
- A3. English only in V1. Layouts tolerate 30% longer strings; no fixed-width labels.
- A4. Dark theme only in V1. Tokens are semantic so a light theme can be added without touching panels.
- A5. Brand accent is ours (Forgon ember), not T3's blue-violet. T3 supplies structure and density.
- A6. Initial providers: Codex, Claude Code, OpenCode (brief). Others appear only when their
  capability record is registered. No provider-specific UI branches outside the adapter-driven capability list.

---

## 1. Product truths the UI must show

1. **Files are the source of truth.** Every object and file shows one of five states, always as text
   plus an icon, never color alone: `saved`, `unsaved` (editor edit not yet written), `external`
   (changed on disk since load), `draft` (agent change not yet accepted), `invalid` (last-good shown).
2. **Agents are contributors, not a chatbot on top.** Agent changes arrive as reviewable drafts with
   a semantic diff (entities by stable ID), a file diff, and checks. They never silently overwrite human work.
3. **Stable IDs are visible.** Every entity row, inspector header and context chip shows its `entity_*`
   ID (mono, copyable). Names are not identity.
4. **No Play needed to inspect.** Edit mode renders the scene from files. Play uses a snapshot and is labelled as such.
5. **Scripts do not run on open.** The launcher and the workspace say so once, in the right place.

---

## 2. Design thesis

**A forge workbench.** Dense, quiet graphite surfaces with 1px rules. One hot ember accent, used only
for what is selected, focused, or the primary action. The viewport is the hero; chrome recedes. Agent
work sits beside the scene and never draws over it.

**Explicitly avoid:**

- Chat-first layout (the agent is a dock, not the center).
- Gradient glows, glassmorphism on the viewport, decorative blobs, emoji icons.
- Stacked modals for review; review is a dock tab.
- Big cards in dense panels; panels use rows, tables and sections.
- A purple/blue default accent (too close to generic AI tooling).
- Color-only status dots. Every dot has a word beside it or in its tooltip.

---

## 3. Workspace layout

Default at 1440x900 CSS px:

```
+--------------------------------------------------------------------------------------+
| TOPBAR 36   Forgon  | project name | scene tab(s) | [Edit|Play|Pause|Stop] | Target v | ⌘K | ● Codex |
+------------------+-------------------------------------------+-----------------------+
| HIERARCHY 264    | VIEWPORT TOOLBAR 32                       | INSPECTOR 320         |
| search           |  Q W E R | snap | grid | camera ▾ | frame | (sel)               |
| tree (24px rows) |-------------------------------------------|  header: name, ID, file|
|                  |                                           |  Transform            |
|                  |     PlayCanvas canvas (flex, never       |  Render / Material     |
|                  |     unmounted when dock changes)          |  Components           |
|                  |                                           |  Prefab overrides     |
|                  |  overlay top-left: validation banner      |  Conflicts (if any)   |
|                  |  overlay bottom-left: cam · sel · fps     |                       |
+------------------+-------------------------------------------+-----------------------+
| DOCK 240 (drag 160-480)  Agent | Assets | Console | Review (badge 3) | Timeline (P1) |
+--------------------------------------------------------------------------------------+
| STATUS 24   saved · watcher ok · 0 errors 2 warnings · main · Codex ready · 60 fps    |
+--------------------------------------------------------------------------------------+
```

**Proportions and rules**

- Hierarchy 264 px fixed (collapsible to 0 with `Ctrl+\`; min 200, max 360). Inspector 320 px (min 288, max 400).
  Viewport takes the rest. At 1280 px the viewport must still be at least 560 px wide; below that the
  hierarchy collapses to a tab in the left column.
- Dock: bottom by default, height 240 (drag 160-480). Dock modes: `bottom`, `right`, `fullscreen`
  (fullscreen covers the center column only; topbar and status bar stay).
- **Right dock shares the right column with the inspector as tabs** below 1680 px. At 1680 px and above
  the right dock is its own 360 px column next to the inspector.
- Fullscreen dock keeps the viewport mounted but hidden (`display: none` is not allowed for the canvas;
  use `visibility` and zero-size parent). The GL context must survive dock changes (acceptance IA-16).
- Each panel scrolls on its own. There is no page scroll anywhere.
- Panel sizes and dock mode persist per project and fall back to defaults if the saved layout is invalid (IA-20).

---

## 4. Screens, flows and states

### 4.1 Project launcher (no project open)

Shown at app start with no project, and from **File → Open project**.

- **Left:** Recent projects list. Row: name, path (middle-ellipsized), last opened (relative), status
  word: `ready`, `needs attention` (validation errors last opened), `unavailable` (folder missing).
- **Right:** Actions as text buttons with one-line descriptions:
  - **New project**: template picker: `empty-3d` (V1), `hotel-vertical-slice` (example, V1 fixture).
    Other templates from `project.md` 5 are shown disabled with "Planned for P1".
  - **Open folder…**: system folder picker.
  - **Open example**: opens the bundled hotel fixture in a copy, never in place.
- **Recent empty state:** "No recent projects. Create one or open a folder." with the two buttons above.

**Open-folder outcomes (each must be a distinct, tested state):**

| Folder content | Outcome |
|---|---|
| Valid `game.project.json` | Open. Progress line "Validating 42 files…" in status bar. Scripts not run. |
| `game.project.json` with schema errors, no prior good state | Do not open the scene. Show diagnostic list (file, JSON pointer or line, message) and "Open the file" action. "Retry" re-reads. |
| Valid project but a scene file is invalid | Open with last good state if one exists in `.forge/`. Otherwise show empty viewport with the same diagnostic banner. |
| No `game.project.json` | "This folder is not a Forgon project. Forgon does not import Unity, Godot, or PlayCanvas Editor projects in V1." Actions: **Create Forgon project here** (lists files to add, never overwrites existing files; requires confirmation) and **Cancel**. |
| Folder unreadable or not on disk | "Can't read this folder: <reason>." Retry, Choose another. |

**Trust line:** shown once on first open of any project, dismissible, and repeated in the console
header: "Project scripts run only when you press Play. Opening a project does not run code from it."

### 4.2 Provider setup

Opens as a sheet from the launcher, from the topbar provider chip (`● Codex ready`), and from the
agent dock empty state. It is never a blocking modal for editing.

Table, one row per provider:

| Column | Content |
|---|---|
| Provider | Name and short description (Codex, Claude Code, OpenCode) |
| State | Exactly one of: `Not installed` · `Installed, not signed in` · `Ready` · `Probe failed` · `Limited (resets at 14:20)` |
| Version | Detected CLI version, or "not detected" |
| Capabilities | Chips only for capabilities the adapter reports: `Plan mode`, `Resume`, `Permission: Supervised`, … Absent means "not reported", not "unsupported" |
| Action | `Show sign-in command` (copies e.g. `codex login`, `claude auth login`, `opencode auth login`), `Check again` |

Rules:

- The sheet never reads, displays, or copies tokens. It only shows the command to run in a terminal.
- `Check again` shows a spinner on that row; after 3 s with no answer it becomes `Probe failed` with
  "No response from <CLI>. Check again or open the log." and a log link.
- **Empty state (none ready):** "No agent is ready. Forgon works with local agent CLIs. Install one,
  sign in, then check again. The editor works without an agent." The agent dock composer stays visible
  but disabled, with the same reason text and a link to this sheet.

### 4.3 Selected-object context

- **Selection sources:** hierarchy click, viewport click, agent-created selection. `SelectionState`
  holds `entityIds[]` and `primaryId`. Multi-select: `Shift` (range) and `Ctrl` (toggle) in the hierarchy.
- **Inspector header** (always present when something is selected): display name, entity ID (mono,
  copy button), prefab badge when instanced, and the source file line (`scenes/lobby.scene.json`).
  Empty state: "Select an object in the hierarchy or viewport. Properties and agent context appear here."
- **Add to agent message:** `Ctrl+Shift+L` or the inspector header menu item **Add to agent message**.
  Adds an `@entity` chip (label: `Reception · entity_reception_01`). Multi-select: one chip per entity,
  or one `@selected` chip with a count. Pick one at wave 2 (recommended: one chip per entity, capped at 20).
- **Chips are references resolved at send time.** If the entity was deleted, the chip turns `missing`
  ("Not in scene. Remove or relink."). Send is blocked until missing chips are removed (IA-07).
- **No hidden context.** The chip row has a "What will be sent" popover that lists the exact
  references and file paths.
- **Quick action:** inspector header menu → **Ask agent to change this** pre-fills the composer with a
  chip and a template line. It never sends automatically.

### 4.4 Agent dock (thread view)

Dock tab **Agent** contains a thread list and a thread view.

- **Thread list** (200 px inside the dock, collapsible): title, provider name, state word:
  `Idle` · `Running` · `Waiting for approval` · `Waiting for answer` · `Limited` · `Failed` · `Stopped` · `Draft ready`.
  States are text plus an icon; `Running` uses a single subtle pulse, reduced-motion safe.
- **Transcript:** streamed assistant text. Tool events collapse to one line each (for example
  `Edited 3 files`, `Ran forge scene validate · exit 0`). Expand shows command, output and exit code.
  Approval requests are inline cards: `Approve once`, `Deny`, plus the active permission mode label.
  No approval buttons inside the composer.
- **Composer:** multi-line textarea (V1 decision, section 12). `Ctrl+Enter` sends. `Enter` inserts a
  newline. Sending does nothing during IME composition. Queued prompts show as a small list above the
  composer with a count; `Stop` replaces `Send` while running.
- **Composer footer:** provider and model select, permission mode select, context chips, stop button.
- **Permission modes** (section 12 D2): `Inspect`, `Supervised`, `Auto edits`, `Full local`. The select
  shows an "enforced by" note only where it is true:
  - `Inspect`, `Supervised`, `Auto edits`: "Enforced by Forgon host and adapter."
  - `Full local`: "Commands and edits run without prompts. Once a provider CLI is running, Forgon cannot
    limit what it does. Use only on projects you trust." No faux toggles and no overclaiming (project.md 8.6).
- **Thread without a provider:** the thread view shows the setup state from 4.2, not a blank transcript.
- **Limited provider:** banner "Provider limit reached. Resets at 14:20. Queued prompts are kept." with
  "Retry" and "Resume at reset" (only when the adapter reports a reset time).

### 4.5 Draft and diff review

Opens as dock tab **Review**. The tab shows a badge with the open draft count. It also opens from the
thread's "Draft ready" state and from status bar counts.

- **Header:** draft title (from thread), 3 files, checks state: `Checks passed` · `2 errors` · `Not run`.
- **Views** (segmented control): `Semantic` (default when scene or prefab files changed), `Files`
  (JSON-aware text diff with stable key order), `Checks` (validation, tests, build output with exit codes).
  Visual before/after (P1) appears as a fourth view later; not in V1.
- **Semantic view:** rows for added, removed and changed entities by stable ID, then per-property rows
  (`transform.position: [2, 0, 4] → [2, 0, 5]`). Each row links to the entity in the hierarchy.
- **Actions:**
  - `Accept draft`: enabled only when checks passed. Writes through the normal save path and creates a checkpoint.
  - `Request changes`: adds the draft as a chip to the composer.
  - `Discard draft`: confirm dialog lists the files that revert. Requires explicit confirm.
  - `Restore checkpoint`: confirm dialog. Disabled with reason "This provider cannot roll back its conversation" when unsupported (rejected before any file changes, per architecture doc).
- **Checkpoints list** below the draft: time, thread, label, changed file count.
- **Empty:** "No draft. Agent changes appear here for review before they are saved." Second line: "No changes since the last checkpoint."

### 4.6 Conflict (human vs agent or external writer on the same property)

- **Trigger:** the same `entityId` and property path changed both in the editor (unsaved or saved) and on disk.
- **Surface:** inline conflict card at the top of the inspector for that entity, and a status bar item
  `Conflict (1)` that opens it. Does not block other entities.
- **Card content:**
  - Property name and path.
  - Two columns labelled by source: `Your edit (unsaved)` and `File on disk (changed 14:02 by thread "Guest queue")`.
  - Three buttons: `Keep mine`, `Use file version`, `Edit merged`.
  - Note: "Nothing was overwritten. Choose which value to keep."
- **Rules:** never auto-resolve. Unrelated properties on the same entity stay editable. Saving other
  entities proceeds normally.

### 4.7 Invalid external edit

- **Viewport:** keeps the last valid scene rendered. Banner top-left: "Showing last valid scene.
  `scenes/lobby.scene.json` line 42: `transform.position` must be three numbers." Actions: `Open file`,
  `Retry validation`. Banner is dismissible but returns on the next invalid change.
- **Inspector:** edits for that file are disabled with "Editing paused until the file is valid." Values stay readable.
- **Hierarchy:** the last valid tree stays. A small `invalid` glyph on the scene tab, not on each row.
- **Recovery:** fixing the file clears the banner and re-enables editing without losing selection or camera (IA-09).

### 4.8 Missing asset

- Viewport: placeholder box at the entity's collider or bounds, gray, with a diagonal hatch. Label on hover: "Missing asset".
- Inspector asset field: danger border, text "Missing: `assets/models/guest.glb`", actions `Relink…`, `Remove reference`.
- Console: one entry per missing asset with file:line.
- Never a crash and never a blank viewport (IA-19).

### 4.9 Play mode

- Topbar switches to `Play` with a visible running clock. Viewport badge: "Playing snapshot from 14:02".
- Edits in hierarchy and inspector are disabled with tooltip "Stop to edit."
- Agent or external file changes while playing show a non-modal toast: "Scene changed on disk. Stop to reload." The simulation is not reset (acceptance from brief).
- `Pause`, `Step frame` (F10), and time scale (later) are in the topbar group.

### 4.10 Console

- Rows: time, source (`script`, `schema`, `asset`, `agent`, `build`), severity (`error`, `warning`, `info`),
  message, `file:line` link. Clicking the link opens the file in the Review or external editor.
- Filters: severity and source segmented controls, search field.
- Empty: "No messages. Errors from scripts, validation and asset import appear here."
- Large logs: virtualized, keep last 10,000 lines per session, show "older lines dropped" once.

### 4.11 Assets (dock tab)

- Folder tree left (200 px), thumbnail grid right. List view toggle.
- States: `Empty folder` ("Drop files here or import from disk"), `Importing` (progress per file),
  `Import failed` (red row with reason and `Retry`), `Missing reference` (count in status bar).

---

## 5. Visual system

Dark theme only in V1. Values are proposals in OKLCH. Wave 2 must confirm every text pair against
WCAG AA (body 4.5:1, controls and icons 3:1).

### 5.1 Surfaces and text

| Token | Value | Use |
|---|---|---|
| `--surface-canvas` | `oklch(0.150 0.005 260)` | Viewport background behind the canvas |
| `--surface-app` | `oklch(0.185 0.006 260)` | Topbar, status bar, chrome |
| `--surface-panel` | `oklch(0.205 0.006 260)` | Hierarchy, inspector, dock |
| `--surface-raised` | `oklch(0.240 0.007 260)` | Inputs, popovers, cards inside panels |
| `--surface-hover` | `oklch(0.270 0.008 260)` | Row and control hover |
| `--surface-selected` | `color-mix(in oklch, var(--accent) 16%, var(--surface-panel))` | Selected row |
| `--border-subtle` | `oklch(1 0 0 / 0.07)` | Panel dividers |
| `--border-strong` | `oklch(1 0 0 / 0.13)` | Inputs, popovers |
| `--text-primary` | `oklch(0.950 0.005 260)` | Labels, values |
| `--text-secondary` | `oklch(0.780 0.008 260)` | Descriptions |
| `--text-muted` | `oklch(0.680 0.010 260)` | Metadata; must still pass 4.5:1 on `--surface-panel` |

Note: `--text-muted` at 0.62 lightness fails 4.5:1 on the panel surface. Keep it at 0.68 or higher.

### 5.2 Accent and semantic

| Token | Value | Use |
|---|---|---|
| `--accent` | `oklch(0.740 0.150 55)` | Selection bar, focus ring, primary button fill |
| `--accent-hover` | `oklch(0.800 0.140 60)` | Primary hover |
| `--accent-fg` | `oklch(0.180 0.010 55)` | Text on accent |
| `--focus-ring` | `var(--accent)`, 2px, `outline-offset: -2px` | All focusable elements (T3 precedent) |
| `--state-info` | `oklch(0.720 0.120 240)` | Running, streaming, provider ready |
| `--state-success` | `oklch(0.760 0.140 150)` | Saved, validated, accepted |
| `--state-warning` | `oklch(0.820 0.150 85)` | External change, stale, limited, missing optional |
| `--state-danger` | `oklch(0.680 0.190 25)` | Error, conflict, missing asset, failed |
| `--diff-add` / `--diff-del` | `oklch(0.760 0.140 150)` / `oklch(0.680 0.190 25)` | Text; backgrounds at 14% mix |

Rules: accent is never used for errors. Warning and accent are close in hue; warning is always paired
with an icon and a word. Danger is always paired with a word.

### 5.3 Type

- UI: `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`. No web-font download in V1.
- Mono (IDs, paths, numbers, console): `"Cascadia Code", Consolas, ui-monospace, monospace`, tabular figures.
- Scale: 11 (metadata, status bar, console), 12 (default UI body), 13 (section titles, dialog body),
  15 (sheet and dialog titles), 18 (launcher title only).
- Line height: 1.4 for 11-12 px, 1.5 for 13 px and above.
- Weights: 400 body, 500 labels, 600 section titles. No uppercase tracking blocks.

### 5.4 Space, density, shape, motion

- Spacing: 4 px grid. Common: 4, 8, 12, 16, 24.
- Density: hierarchy row 24 px; inspector field row 28 px; toolbar control 28 px; topbar 36 px; status bar 24 px; dock tab 28 px.
- Minimum hit target 24 px (WCAG 2.2 target size). Preferred 28 px.
- Radius: 4 px controls and rows, 6 px popovers and cards, 8 px dialogs. T3's 8 px control radius is
  too soft for this density.
- Elevation: borders first. Popovers and dialogs: `0 8px 24px oklch(0 0 0 / 0.40)`.
- Motion: selection and hover 0 ms or 80 ms. Dock and panel toggles 120 ms with `cubic-bezier(0.32, 0.72, 0, 1)` (T3 drawer curve).
  Viewport overlays never animate. All motion is 0 ms under OS reduced-motion.
- Icons: one set, 14 px, 1.5 stroke, labelled by tooltip. Candidate: Lucide (ISC license; verify in wave 2).
  No emoji anywhere in UI.

---

## 6. Keyboard and command map

Command IDs follow T3's `namespace.action` style (for example `scene.select.all`). Bindings are data
(a JSON rule list like T3's `keybindings.json`) with `when` conditions, so users can remap them.

Context keys (proposed): `viewportFocus`, `hierarchyFocus`, `composerFocus`, `editableFocus`,
`playing`, `dirty`, `draftOpen`, `dockOpen`, `isDesktop`.

| Key | Command ID | When | Notes |
|---|---|---|---|
| `Ctrl+K` | `palette.open` | always | Commands, entities, files, threads |
| `Ctrl+S` | `project.save` | `dirty` | Atomic save |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | `edit.undo` / `edit.redo` | not `editableFocus` | Native text undo inside fields |
| `Q` `W` `E` `R` | `viewport.tool.select/move/rotate/scale` | `viewportFocus` | Same as Godot-style order |
| `F` | `viewport.frame.selection` | `viewportFocus` | |
| `Delete` / `Ctrl+D` / `F2` | `scene.delete` / `scene.duplicate` / `scene.rename` | `hierarchyFocus` or `viewportFocus` | Delete is undoable |
| `Ctrl+A` | `scene.select.all` | `hierarchyFocus` | |
| `Arrow keys`, `Enter`, `Left/Right` | tree navigation | `hierarchyFocus` | ARIA treeview pattern |
| `Escape` | `selection.clear` or cancel drag | context | Cancels gizmo drag first |
| `F5` | `play.toggle` | always | Intercept WebView2 reload |
| `Shift+F5` | `play.stop` | always | |
| `F6` | `play.pause` | `playing` | |
| `F10` | `play.step` | `playing` | |
| `Ctrl+\` | `layout.hierarchy.toggle` | always | |
| `Ctrl+J` | `layout.dock.toggle` | always | |
| `Ctrl+`` ` | `dock.console.focus` | always | |
| `Ctrl+L` | `agent.composer.focus` | always | Opens Agent tab |
| `Ctrl+Enter` | `agent.send` | `composerFocus` | `Enter` is newline |
| `Ctrl+.` | `agent.stop` | `turnRunning` | Not Escape; avoids accidental interrupts |
| `Ctrl+Shift+L` | `agent.context.addSelection` | `hierarchyFocus` or `viewportFocus` | |
| `Ctrl+Shift+R` | `review.open` | `draftOpen` | |
| `Ctrl+Shift+M` | `agent.model.pick` | `composerFocus` | Matches T3 `mod+shift+m` |
| `Ctrl+Shift+A` | `agent.permission.pick` | `composerFocus` | Matches T3 `mod+shift+a` |

**WebView2 conflicts (must handle in wave 2):**

- `F5` and `Ctrl+R` reload the page. Prevent default in release builds; `F5` becomes Play.
- `Ctrl+P` (print), `Ctrl+F` (find), `Ctrl+Shift+I` (devtools in dev only), `Ctrl+U`, `Ctrl+O`: prevent in release.
  `Ctrl+F` opens hierarchy search, scoped to the hierarchy.
- Browser context menu is replaced with the app's menu in release builds (IA-23).
- `Ctrl+Shift+T` (reopen closed tab) is not used; there are no closeable tabs in V1 docks.

---

## 7. Component ownership and reuse

### 7.1 Ownership map

Rule (from `project.md` 5): `packages/editor-ui` is presentational. Components take props and
callbacks. They never import Tauri, the agent sidecar, or `editor-core` directly. `apps/studio` wires data.

| Area | Path | Owner | Notes |
|---|---|---|---|
| Tokens (CSS variables, Tailwind theme) | `packages/editor-ui/src/theme/` | Haiku (editor-ui) | Semantic names only; no raw colors in panels |
| Primitives: Button, IconButton, Segmented, Select, Menu, Tabs, Tooltip, Kbd, StatusDot, Chip, Field, Toggle, Banner, EmptyState, ErrorState, SplitPane, Dock | `packages/editor-ui/src/primitives/` | Haiku | Radix or Base UI headless behavior allowed; verify license |
| Command palette and keymap UI | `packages/editor-ui/src/commands/` | Haiku | Keymap rule parser and `when` evaluator are pure functions with tests |
| Workspace shell, layout persistence, topbar, status bar | `apps/studio/src/shell/` | Haiku | Persists layout through the desktop host IPC (MiMo) |
| Viewport chrome: toolbar, overlays, banners, placeholders | `apps/studio/src/viewport/` | Haiku | Canvas mount and render loop owned by runtime lane (GLM) |
| Hierarchy tree (virtualized) | `packages/editor-ui/src/panels/hierarchy/` | Haiku | Reads `SelectionState` and scene tree props |
| Inspector (schema-driven fields, conflict card) | `packages/editor-ui/src/panels/inspector/` | Haiku | Field schema from `project-schema` (GPT Sol) |
| Assets browser | `packages/editor-ui/src/panels/assets/` | Haiku | Import progress from `project-io` events (MiMo) |
| Console | `packages/editor-ui/src/panels/console/` | Haiku | Diagnostic and log types from contracts |
| Agent dock: thread list, transcript, composer, chips, permission select, provider setup sheet | `packages/editor-ui/src/agent/` (presentational) | Haiku | Types from `agent-bridge` (DeepSeek) |
| Agent data hooks and sidecar client | `apps/studio/src/agent/` | Haiku wiring; DeepSeek contract | No raw sidecar calls in components |
| Review: draft, semantic diff, file diff, checks, checkpoints | `packages/editor-ui/src/review/` | Haiku | Semantic data from `editor-core` (GPT Sol) |
| Launcher and project open flow | `apps/studio/src/launcher/` plus presentational parts in `packages/editor-ui/src/launcher/` | Haiku | Filesystem access only through MiMo IPC |
| Conflict card | `packages/editor-ui/src/conflict/` | Haiku | Model from `editor-core` conflict record |

Not in V1 for UI: timeline, profiler, level editor, economy editors (P1/P2).

### 7.2 Reuse from T3 Code (decisions for wave 2; DeepSeek records per-file verdicts in `docs/research/t3-reuse.md`)

| T3 source | Reuse decision | Reason |
|---|---|---|
| `keybindings.ts`, `keybindings.test.ts` | Adapt pattern (rule list, `when` evaluation) | Most reusable; check its command registry coupling |
| `CommandPalette.logic.ts`, `CommandPalette.tsx` | Adapt pattern | Logic likely portable; UI tied to T3 router and stores |
| `Sidebar.logic.ts`, `Sidebar.drag.ts`, `Sidebar.pointer.ts` | Pattern only | Pinned/active ordering idea; drag rules are thread-specific |
| `RightPanelTabs.tsx` and its keyboard test | Adapt pattern | Dock tab keyboard behavior is directly useful |
| `ThreadTerminalDrawer.tsx` | Pattern only | Bottom drawer; console differs from terminal |
| `ContextChip.tsx`, `composerContextPresentation.tsx` | Adapt pattern | Chip states (missing, stale) are our addition |
| `ComposerPromptEditorTiptap.tsx` | Do not reuse in V1 | Heavy editor for a chip-only need; see D3 |
| `DiffPanel.tsx`, `DiffPanelShell.tsx`, `pierre-*` | Check then adapt | Depends on diff library and worker pool; check license and coupling |
| `ThreadStatusIndicators.tsx` | Adapt pattern | Status wording and subscription model |
| `appearanceContrast.ts` and test | Reuse idea | Build contrast tests for our token pairs |
| `panelAnimations.ts`, `AnimatedHeight.tsx` | Adapt pattern | Motion toggle and collapse behavior |
| `PermissionUpdateNotice.tsx` | Pattern only | Permission copy patterns |

No file is copied without MIT attribution and a note in `THIRD_PARTY_NOTICES.md` (parent).

---

## 8. Accessibility and performance

- **Contrast:** body text 4.5:1, controls and icons 3:1, verified by a token test in wave 2 (IA-22).
- **Focus:** visible 2 px accent ring on every focusable element. Never removed.
- **Icon-only buttons:** tooltip with the shortcut, and `aria-label`.
- **Status:** always text plus icon. Dots carry tooltips and screen-reader text.
- **Semantics:** hierarchy uses ARIA `tree` roles; inspector fields are labelled; banners use `role="status"`
  for info and `role="alert"` for errors and conflicts.
- **Motion:** reduced-motion respected (IA-21).
- **Target size:** 24 px minimum on every interactive element.
- **Text:** file paths middle-ellipsized with the full path in a tooltip. Never truncated without a tooltip.
- **Performance:**
  - Virtualize hierarchy above 200 rows, console above 500 rows, assets grid above 200 items, and transcript.
  - Panels subscribe to narrow selectors. Selection changes must not re-render the viewport chrome.
  - Dock changes must not re-create the canvas or its GL context.
  - Status bar updates at most every 250 ms.

---

## 9. State matrix (summary)

| State | Where it appears | Primary action | What is blocked |
|---|---|---|---|
| No project open | Launcher | New or Open | Workspace routes |
| Folder not a Forgon project | Launcher dialog | Create Forgon project here (confirm) | Any write without confirm |
| Schema-invalid project, no good state | Launcher and empty viewport | Open the file | Scene edits; Play |
| Invalid external edit | Viewport banner, inspector | Open file, Retry | Edits to that file |
| Missing asset | Viewport placeholder, inspector, console | Relink, Remove | Nothing else |
| External change while dirty | Status bar, Conflict card | Keep mine / Use file version | Save over that property |
| Conflict (same property) | Inspector card | Keep mine, Use file, Edit merged | That property only |
| Play snapshot | Viewport badge, topbar | Stop to edit | Scene edits |
| No provider ready | Agent dock, topbar chip | Show sign-in command, Check again | Send |
| Provider limited | Thread banner | Retry, Resume at reset | Send until reset (queue kept) |
| Agent draft unchecked or failing | Review tab, status bar | Fix, Request changes, Discard | Accept draft |
| Rollback unsupported | Review checkpoint row | Explain | Restore checkpoint |
| Agent service crashed | Agent dock banner | Restart service | Send |

Agent service crash copy: "Agent service stopped (exit code N). Thread history is saved. Restart service."

---

## 10. Interaction acceptance criteria (for wave 2 QA)

- **IA-01** No project: launcher shown; empty recent list reads "No recent projects" with New and Open.
- **IA-02** Opening a folder without `game.project.json` writes nothing until the user confirms Create. The confirm lists files to add and refuses to overwrite.
- **IA-03** Opening a project never executes a file from `scripts/` or `authoring/`. Test with a canary script.
- **IA-04** Provider rows show exactly one state word. Check again resolves within 3 s or shows Probe failed with a retry.
- **IA-05** With zero ready providers, send is disabled with reason text. Editing still works.
- **IA-06** Hierarchy selection and viewport click select the same ID. 100% of registered entities are selectable (`project.md` metric).
- **IA-07** `Ctrl+Shift+L` adds a chip. A chip is removable by keyboard. A missing-entity chip blocks send until removed.
- **IA-08** The "What will be sent" popover lists the exact references and paths.
- **IA-09** Invalid external edit keeps the last valid scene visible and shows the file and line. Fixing the file clears the banner within 1 s p95, keeping selection and camera.
- **IA-10** A conflict never overwrites either value automatically. Both sources are visible. All three resolutions work. Other properties stay editable.
- **IA-11** Accept draft is disabled while checks fail, enabled once they pass, and creates a checkpoint on accept.
- **IA-12** Discard and Restore require confirmation. Restore is disabled with a reason for providers without rollback.
- **IA-13** During Play, scene edits are disabled. Stop returns to edit. A disk change during Play does not reset the simulation.
- **IA-14** All primary actions are keyboard reachable. Tab order: topbar → hierarchy → viewport toolbar → inspector → dock → status bar.
- **IA-15** `Ctrl+Enter` sends; `Enter` inserts a newline; no send during IME composition.
- **IA-16** Switching dock bottom/right/fullscreen keeps the canvas mounted and updates its size without losing the GL context.
- **IA-17** Inspector edits are undoable with `Ctrl+Z` (100-step test in editor-core) and do not steal native undo in text fields.
- **IA-18** Console `file:line` links open the file in Review or the external editor.
- **IA-19** Missing asset shows a placeholder, a clear inspector message, and a console entry. No crash.
- **IA-20** Panel sizes and dock mode persist across restart. A corrupt saved layout falls back to defaults silently with one console info line.
- **IA-21** Reduced motion on: every transition is 0 ms.
- **IA-22** Token contrast test passes for every text and control pair in section 5.
- **IA-23** Release build shows the app context menu, not the browser menu.
- **IA-24** `F5` triggers Play, not reload. `Ctrl+R` does nothing in release. `Ctrl+F` searches the hierarchy only.

---

## 11. Shared contracts requested from parent (before wave 2)

Shapes are sketches to freeze in `docs/handoff/contracts.md`.

- `SelectionState { sceneId; entityIds: EntityId[]; primaryId: EntityId | null; source: 'hierarchy' | 'viewport' | 'agent' }`
- `FileState = 'saved' | 'unsaved' | 'external' | 'draft' | 'invalid'` per file.
- `Diagnostic { severity: 'error' | 'warning' | 'info'; source: 'schema' | 'asset' | 'script' | 'agent' | 'build'; file: string; pointer?: string; entityId?: EntityId; line?: number; message: string; hint?: string }`
- `ProjectHealth { status: 'reading' | 'ok' | 'invalid' | 'missing' | 'conflict'; diagnostics: Diagnostic[] }`
- `Conflict { entityId; path: string; ours: { value; source: 'editor' }; theirs: { value; source: 'file'; threadId?: string; changedAt: string } }`
- `ProviderStatus { providerId; name; state: 'not_installed' | 'not_signed_in' | 'ready' | 'probe_failed' | 'limited'; version?: string; resetsAt?: string; message?: string; capabilities: { planMode: boolean; resume: boolean; rollbackConversation: boolean; permissionModes: PermissionMode[] } }`
- `PermissionMode = 'inspect' | 'supervised' | 'auto_edits' | 'full_local'` with `enforcedBy: 'host' | 'adapter' | 'provider'` in metadata.
- `ThreadRun { threadId; status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_answer' | 'limited' | 'failed' | 'stopped' | 'draft_ready'; queued: number }`
- `ContextChip = { kind: 'file' | 'scene' | 'entity' | 'component' | 'prefab' | 'asset' | 'level' | 'selected' | 'errors' | 'build' | 'runtimeLog' | 'screenshot'; ref: string; label: string; status: 'ok' | 'missing' | 'stale' }`
- `DraftChange { draftId; threadId; files: { path; change: 'added' | 'modified' | 'deleted' }[]; semantic: SemanticEntityChange[]; checks: CheckResult[]; checkpointId: string }`
- `CheckpointRef { id; createdAt; threadId?; label; fileCount; restorable: boolean; restoreBlockedReason?: string }`
- `RecentProject { path; name; lastOpened: string; status: 'ready' | 'needs_attention' | 'unavailable' }`
- Command IDs and context keys from section 6.

---

## 12. Open decisions for the parent

- **D1 Accent.** Recommend ember `oklch(0.74 0.15 55)`. Alternative: neutral white accent with ember only for errors/warnings, which is more austere.
- **D2 Permission names.** `project.md` 8.6 uses Inspect / Supervised / Auto edits / Full local. T3 uses Supervised / Auto-accept edits / Auto / Full access. Recommend `project.md` names with a T3-style mapping note in the adapter layer.
- **D3 Composer.** Recommend a plain textarea with a chip layer for V1. Tiptap (T3) gives inline chips but adds a large dependency and a reconciliation layer. Revisit in P1.
- **D4 Icons.** Recommend Lucide, after license check.
- **D5 Font.** Recommend system Segoe UI Variable. No font download in V1.
- **D6 Right dock.** Recommend shared column below 1680 px, own column above.
- **D7 Send shortcut.** Recommend `Ctrl+Enter` to send. Enter-to-send is a setting later.
- **D8 PRODUCT.md.** Recommend running Impeccable `init` (or the parent writing it from this doc's section 0 assumptions) before wave 2 UI, so the product context is recorded rather than inferred.

---

## 13. Verification plan for wave 2 (UI lane)

- Keep the Impeccable mechanical detector for the finished web UI: run it once after the changed UI is
  complete, on the changed targets only.
- Screenshots of the default workspace, launcher, provider sheet, invalid-edit state, conflict state,
  draft review, and Play snapshot at 1280x800 and 1920x1080. One batched review round, one fix batch,
  one confirmation round.
- Automated: keymap `when` tests, contrast tests (IA-22), layout persistence tests (IA-20), selection
  parity tests (IA-06), draft accept gating tests (IA-11).
- Manual keyboard-only pass for IA-14 and IA-15 before the wave closes.
- Limitations to report honestly in wave 2: WebView2 focus behavior, IME behavior, and real GPU context
  retention need a Windows run, not a headless browser.
