# Forgon Engine design
Author: Nitish

## Direction
Modern, minimal, dark Windows desktop workspace. Near-black app background with floating rounded panel groups separated by small gaps; the game viewport stays the hero and agent work stays visible beside it. Icon + short label everywhere, minimal prose; detail lives in tooltips, popovers and the inspector. Soft translucent floating toolbars and overlay cards on the viewport; pill tabs, pill tags and activity-feed timelines instead of boxed tables. Avoid promotional dashboard cards and decorative gradients beyond the subtle viewport glow.

## Layout and interaction
Fully modular dock: every panel is a tab that can be moved between tab groups, reordered, closed and re-added, and every group is resizable. Default arrangement is four groups: Viewport | Game (top left, largest), Hierarchy | Inspector (top right), AI Composer | Agents (bottom left), Project | Console (bottom right). Audio, Animation, Timeline, Profiler, Assets and Review are slottable tabs added to any group. Preserve editor camera and selection across valid external changes. Separate edit and play state visibly. Surface validation diagnostics and conflicting edits without replacing the last valid scene or silently overwriting work.

## Accessibility and feedback
Native window and installer branding use Forgon Engine. Native service connection failure shows an accessible startup error; an unavailable T3 artifact shows explicit provider prerequisites without disabling independent project editing. Closing the native window with dirty work or an active save is guarded; native behavior still needs verification.

Keyboard-accessible hierarchy, controls and panel navigation; visible focus; accessible labels and contrast. Respect reduced motion. Disabled/unavailable provider capabilities must explain their actual prerequisite. Show real loading, cancellation, error, empty and recovery states. Do not represent mock output as a working provider or export.

## User flows
Support discoverable new/open project entry, provider setup, selected-object context, file/semantic diff review and safe revert. Existing projects must be inspected without silently running scripts. Importing other-engine assets is distinct from converting arbitrary game projects.

## Source specification
Detailed initial panel and edit-mode requirements remain in project.md section 7; this document records the approved visual direction. Worker design findings will refine these patterns after upstream inspection.

Approved UI details: restrained ember accent; Segoe UI Variable/system font; Ctrl+Enter sends while Enter inserts a newline and IME composition never sends. Keep the viewport mounted across panel layout changes. Shared contracts in docs/handoff/contracts.md override exploratory shapes in the UI research note.

## UI plan (V1)
Full rationale, copy and acceptance criteria (IA-01 to IA-24): docs/research/ui-direction.md. This section is the approved summary.

### Screens
1. **Launcher** (no project open): recent projects with status `ready` / `needs attention` / `unavailable`; New project (templates `empty-3d`, `hotel-vertical-slice`; later templates shown disabled as "Planned for P1"), Open folder, Open example (opens a copy). Opening a folder that isn't a Forgon project offers "Create Forgon project here", which lists the files to add, needs confirmation and never overwrites.
2. **Workspace** (default 1440x900): topbar 34 px (project / scene, save state, Edit/Play/Pause/Stop, Ctrl+K, layout menu with reset, provider chip) · four-group dock: left column 64% width split 68/32 into Viewport | Game over AI Composer | Agents; right column split 68/32 into Hierarchy | Inspector over Project | Console · status bar 22 px (file state, watcher, diagnostics, drafts, branch, fps). Tab strips are 30 px with an ember top bar on the active tab, a close button, and a + menu that adds any panel or moves an open one into that group.
3. **Provider setup sheet**: one row per provider (Codex, Claude Code, OpenCode) with a single state word, version, only reported capabilities, `Show sign-in command` and `Check again`. Never reads or shows tokens. Editing never depends on it.
4. **Agent dock**: thread list with state words, transcript with collapsed tool events and inline approval cards, composer (textarea, context chips, "What will be sent" popover, provider/model and permission selects, Send/Stop).
5. **Review tab**: Semantic / Files / Checks views; Accept draft only when checks pass; Request changes, Discard (confirm), Restore checkpoint (disabled with a reason when the provider can't roll back).
6. **Inline states**: conflict card at the top of the inspector (Keep mine / Use file version / Edit merged), invalid-file banner over the last valid scene, hatched missing-asset placeholder, Play snapshot badge with edits disabled.

### Layout rules
Panels move by reparenting, never remounting, so the Viewport keeps its GL context and every panel keeps its state when moved, hidden behind another tab or resized. Tabs move by drag and drop (insert marker on the target strip, group highlight on hover) or with Alt+Arrow to the neighbouring group; Arrow keys switch tabs. Splitters are 6 px hit areas, highlight in ember, resize with pointer or Arrow keys, and clamp each side to 15–85%. An empty group shows "Drop a tab here or press + to add a panel". Each panel opens at most once. Because Hierarchy and Inspector share a group by default, selecting in the viewport or hierarchy must keep the inspector reachable in one action (Ctrl+I focuses it); users can split them into separate groups. Panels scroll independently, there's no page scroll, and layout persists per project with a silent fallback to defaults.

Implemented in `@forgon/editor-ui` (17 Oct 2026): layout v2 is stored per project under `forgon.layout.v2:<project>` (older layouts reset to default). Default groups are Viewport | Game, Hierarchy | Inspector, Composer | Agents and Project | Console | Review. The Agents tab holds the thread list and provider table. The Game tab is honest about its limits: Play still runs a snapshot inside the Viewport, and a separate device-size game view is not built yet. Audio, Animation, Timeline and Profiler appear in the + menu as disabled "Planned" items. Shortcuts: Ctrl+L composer, Ctrl+Shift+L add selection, Ctrl+I inspector, Delete closes the focused tab.

### Visual tokens
- Surfaces: app background `oklch(.115 .003 270)`; panel group `oklch(.165 .004 270)`; raised/section `oklch(.19 .004 270)`; hover white 5%, active/selected white 8%; borders white 6% / 10%. Floating viewport toolbars and overlay cards use the raised surface at 85% with 10 px backdrop blur and a soft shadow.
- Accent: ember `oklch(.74 .16 55)` (text on accent `oklch(.17 .02 55)`) for the active tool, active tab icon, primary buttons, focus ring and selection. A blue accent `oklch(.62 .2 262)` was previewed as an alternative and is not adopted unless chosen. Accent never marks errors.
- State colors, always with an icon or word: success `oklch(.74 .16 155)`, warning/draft `oklch(.78 .15 70)`, error `oklch(.66 .2 15)`, info/running `oklch(.70 .14 250)`. Axis colors X red, Y green, Z blue on transform fields and gizmos.
- Shape: panel groups 14 px radius, inner sections 10 px, controls and pills 7–10 px, tags 6 px; 8 px gaps between groups.
- Icons: Lucide only (`lucide-react` 1.58.0 in `@forgon/editor-ui`, ISC licence; add it to third-party notices). No other icon sets, hand-drawn SVG icons or emoji. strokeWidth 1.75; size 14 px in tabs/rows, 16 px in toolbars, 20 px for tiles. Icons are decorative (`aria-hidden`) next to a label; every icon-only button has an accessible name and tooltip.
- Type: Segoe UI Variable 11/12/13 px; Cascadia Code for IDs, paths and numbers. Text is short labels; secondary text muted `oklch(.62 .006 270)` or brighter.
- Patterns: top bar = icon rail at left, breadcrumb, centered search pill with Ctrl K, Play pill with accent icon and options chevron, agent avatar stack with ready count, notifications, layout reset. Tabs are 30 px pills (active = white 8% fill + accent icon). Composer is an activity feed (colored circle icons on a vertical line) above a rounded input with context chips, provider and permission tags and an accent send button. Status bar is icon + value only.
- Motion is 0–120 ms and drops to 0 under reduced motion.

### Keyboard
Ctrl+K palette, Ctrl+S save, Q/W/E/R tools, F frame, F5 play (instead of WebView reload), Ctrl+J dock, Ctrl+L composer, Ctrl+Enter send, Ctrl+. stop, Ctrl+Shift+L add selection to the message, Ctrl+Shift+R review. Bindings are remappable data with `when` contexts.

Component properties must be editable through validated whole-component updates; a dedicated property-patch command is not required. Permission descriptions must reflect actual provider guarantees and must not equate approval modes or cwd with OS confinement. Full-local mode requires deliberate selection when no safer supported mode exists.
