# Forgon Engine design
Author: Nitish

## Direction
Modern, minimal, dark Windows desktop workspace. Near-black app background with floating rounded panel groups separated by small gaps; the game viewport stays the hero and agent work stays visible beside it. Icon + short label everywhere, minimal prose; detail lives in tooltips, popovers and the inspector. Soft translucent floating toolbars and overlay cards on the viewport; pill tabs, pill tags and activity-feed timelines instead of boxed tables. Avoid promotional dashboard cards and decorative gradients beyond the subtle viewport glow.

## Brand identity
Forgon uses an angular, forward-cut black F (`#111113`) on a rounded square with a diagonal orange gradient from golden orange `#ffbd59` to burnt orange `#f46b18`, as requested by the owner. The solid letter stays legible at small sizes, without decorative animation. The canonical vector is `packages/editor-ui/src/brand/forgon.svg`; it is a brand asset, exempt from the Lucide-only rule for interface icons and the general restraint on decorative gradients. The launcher pairs a 56 px mark with a Segoe wordmark: Forgon at weight 650, Engine at 400 in secondary text, and the descriptor “Local-first game studio”. The workspace rail uses the same mark at 32 px with an accessible product name. Beside the launcher heading the image is decorative. The browser favicon and native Windows icon share this mark; the latter includes 16–256 px sizes. The existing ember UI accent remains unchanged.

## Layout and interaction
The viewport fills the workspace edge to edge and stays mounted for the life of the workspace. Hierarchy floats top-left and Inspector top-right in translucent rounded cards, each independently hideable, with search and internal scrolling. Hierarchy shows the object count and retains tree navigation, multi-selection, rename, duplicate, drag-reparenting and undo. Inspector has collapsible transform/component sections, compact vector fields, component removal and a quiet + component disclosure. Preserve editor camera and selection across valid external changes. Separate Edit and Play visibly; validation and conflict recovery keep the last valid scene.

A compact top-centre viewport pill holds Select, Move, Rotate, Scale, Local/World space and Frame selection. Space is disabled when the runtime does not expose it. The top strip keeps project/scene, Edit/Play, undo, redo, save and Hierarchy/Inspector visibility controls. Settings and Close project remain in the existing rail.

The top strip centres its visibility, Edit/Play and history/save controls as one group over the viewport, aligned with the tool pill. Equal-width side regions keep the controls centred regardless of project/scene name length: breadcrumbs stay left and close-confirmation actions stay right, scrolling within their region if space is limited.

The bottom command bar is the single home for Assets, Console, Review, Agents, Stats and Chat (MessageSquare icon). Only one secondary card expands above it; choosing the active item again or Escape collapses it and closing returns focus to its command. The prompt is always below the bar, with removable selection/asset/scene context, a single-line textarea that grows to five lines, compact provider/model/permission disclosure and round Send/Stop. Ctrl+Enter sends; Enter adds a line and IME composition never sends. Queue, approvals, permission explanations, provider readiness and thread selection retain their existing behavior. A newly running turn opens Chat; users may collapse it during a run. Tool details are collapsed; user/assistant messages and inline approvals stay readable.

Floating cards have bounded heights and scroll internally; no page scrolling. Visibility and the expanded-card choice persist per project as a version 3 payload under the existing `forgon.layout.v2:<project>` key. Old dock formats and invalid storage reset safely to the floating defaults and Studio persists that recovery. The viewport and hidden panels remain mounted. Stats reports actual entity count, selection count and logged errors/warnings only.

## Level design first
Designers must be able to see and handcraft a level without code; this was the main pain building games on Zibpo. The viewport renders what will play: the same materials, lights and shadows as Play, not a placeholder look. Placing is direct: drag prefabs and assets from the Project panel into the viewport, duplicate (Ctrl+D) at the cursor, snap translate/rotate/scale to a visible grid step that can be toggled and changed from the viewport toolbar, and align to surfaces. Script properties are tuned in the Inspector with immediate visual feedback. Every one of these actions is keyboard reachable and undoable as one step.

Shipped level-design controls: the viewport pill has a Snap toggle and translation steps of 0.25/0.5/1/2 m, rotation steps of 15/45/90 degrees, and scale steps of 0.1/0.25. The visible ground grid uses the translation step even when snapping is off. Hold Ctrl during a gizmo drag to invert snapping temporarily; releasing Ctrl or losing window focus restores the saved setting. Snap defaults to off with 0.5 m, 15 degrees and 0.1 scale steps. Snap settings and the Align to surface toggle persist in the existing per-project layout preferences; older version 3 preferences remain valid.

Ctrl+D works throughout the workspace outside text fields. It duplicates the topmost selected subtrees with fresh entity/component IDs, remaps their internal references, retains their parent and selects the copied roots. Copy names use the next free numbered suffix, such as Rock (1). Each copied root is offset one translation step along its parent's local X axis; children keep their local transforms. A complete prefab instance gets a fresh instance ID; selecting only part of an instance asks the designer to select the whole instance. Duplication is one undo step.

Assets includes Primitives (box, sphere, cylinder, plane, cone, capsule and torus) and Prefabs groups. Drag a tile onto the viewport or select it and activate Add to scene to place it at the viewport centre's surface. Placement uses visible scene geometry with a y=0 ground-plane fallback and shows the candidate coordinates during dragging. The object's origin is placed at the hit point. A prefab retains its authored subtree and source metadata with fresh instance/object IDs; nested prefab instantiation is unavailable. Align to surface sets the placed root's +Y axis onto the world-space surface normal, replacing its authored root rotation; leaving it off preserves the prefab rotation. Placement and optional alignment commit as one undo step and select the new root. Play, invalid-file and conflict guards also apply to duplication and placement.

## Reference: Kaigen editor feel
The owner likes how Kaigen's in-game editor (HZ engine, Clay UI) feels: super clean, the game always in view. Borrow these patterns (screenshots reviewed 17 October 2026; study in docs/research/kaigen-study.md):
- **Full-bleed viewport.** The scene fills the whole window edge to edge; Hierarchy (left) and Inspector (right) float above it as rounded, slightly translucent cards with a small margin, not docked columns.
- **One compact tool pill, top centre:** move, rotate, scale, then a divider, then space (local/world) and pivot dropdowns. Icon-only with tooltips.
- **Bottom command bar** as the single home for secondary surfaces: a slim pill with Assets, Console, Stats and a Command prompt. Choosing one expands it into a card above the bar; the prompt carries the selected entity as a removable context chip and a send button. This is also where the agent composer belongs.
- **Hierarchy:** header with object count, search field, one quiet icon per entity type, flat dense rows.
- **Inspector:** search field, collapsible component sections with a remove button each, label column plus compact numeric fields (three per vector), and a quiet "+ component" link at the end.
- **Assets:** folder tree with counts on the left, a thumbnail grid with type captions on the right, and All/Prefab/Material/Texture filter pills plus search.
- **Console:** level filter pills with counts (All, Info, Warn, Error), category chips, a filter field, and monospaced rows (time, level, thread, category, message, source:line).
- **Stats:** a large frame-time number, fps and p99, a bar history against the 16.6 ms line, then a grid of tiles: CPU, GPU, draw calls, triangles, memory, streaming, shaders and entities.
- **Selection:** a warm outline on the selected object plus coloured axis arrows; nothing else changes.
- Restraint everywhere: one neutral dark surface tone, small type, thin dividers, no decorative chrome.

Forgon keeps its own rules where they differ: the ember accent (Kaigen uses a purple-to-orange gradient in its launcher), and opening a project never runs gameplay (Kaigen edits a paused live game). The shipped floating workspace replaces the four docked tab groups; the reference above describes inspiration, including capabilities beyond the current implementation.

## Accessibility and feedback
Native window and installer branding use Forgon Engine. Desktop connection shows an accessible loading status before the launcher renders. Agent startup runs independently of project editing; provider refresh reports readiness once startup completes. Native service connection failure shows an accessible startup error; an unavailable T3 artifact shows explicit provider prerequisites without disabling independent project editing. Closing the native window with dirty work or an active save is guarded; native behavior still needs verification.

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
2. **Workspace**: 40 px top strip and 24 px status bar around a full-bleed scene. Independent floating Hierarchy/Inspector cards, one top-centre tool pill and a centred bottom command bar with a persistent AI prompt. Secondary cards open above the bar, one at a time. The status bar shows save/watch state, logged errors/warnings, selection and actual agent state; no fabricated performance numbers.
3. **Provider setup sheet**: one row per provider (Codex, Claude Code, OpenCode) with a single state word, version, only reported capabilities, `Show sign-in command` and `Check again`. Never reads or shows tokens. Editing never depends on it.
4. **Agent composer**: prompt in the command bar; provider/model/permissions in one compact disclosure; removable context chips and context JSON disclosure; Send/Stop and Queue during a run. Chat opens above the bar with state words including Running, Done and Failed, collapsed tool details and inline approvals. The Agents card retains the thread list and provider settings entry.
5. **Review card**: Semantic / Files / Checks views; Accept draft only when checks pass; Request changes, Discard (confirm), Restore checkpoint (disabled with a reason when the provider can't roll back).
6. **Inline states**: conflict card at the top of the inspector (Keep mine / Use file version / Edit merged), invalid-file banner over the last valid scene, hatched missing-asset placeholder, Play snapshot badge with edits disabled.

### Layout rules
The viewport keeps a stable React tree position and runtime mount. Hierarchy, Inspector, composer, transcript and secondary panels stay mounted when hidden; hidden cards are inert and removed from keyboard navigation. Every command and icon has an accessible label and tooltip, visible focus and native keyboard activation. Closing a secondary card restores focus to its command. Hierarchy and Inspector can be toggled from the top strip or shortcuts. Their contents and secondary cards scroll independently within bounded heights. There are no dock tab strips, splitters, add-panel menus or separate Game tab; Play runs a detached snapshot in the viewport.

The Assets card reuses the folder tree, icon grid, search, detail strip and license-declared import. Review retains the existing diff display and its explicit capability limits. Agents retains threads and the provider settings entry. Launcher and Settings retain their existing flows. Layout version 3 replaces the dock version 2 payload in the existing per-project key; unreadable or old payloads recover to defaults without affecting project files. Motion remains 0?120 ms and respects reduced motion.

### Visual tokens
- Surfaces: app background `oklch(.115 .003 270)`; panel group `oklch(.165 .004 270)`; raised/section `oklch(.19 .004 270)`; hover white 5%, active/selected white 8%; borders white 6% / 10%. Floating viewport toolbars and overlay cards use the raised surface at 85% with 10 px backdrop blur and a soft shadow.
- Accent: ember `oklch(.74 .16 55)` (text on accent `oklch(.17 .02 55)`) for the active tool, active tab icon, primary buttons, focus ring and selection. A blue accent `oklch(.62 .2 262)` was previewed as an alternative and is not adopted unless chosen. Accent never marks errors.
- State colors, always with an icon or word: success `oklch(.74 .16 155)`, warning/draft `oklch(.78 .15 70)`, error `oklch(.66 .2 15)`, info/running `oklch(.70 .14 250)`. Axis colors X red, Y green, Z blue on transform fields and gizmos.
- Shape: panel groups 14 px radius, inner sections 10 px, controls and pills 7–10 px, tags 6 px; 8 px gaps between groups.
- Icons: Lucide only (`lucide-react` 1.58.0 in `@forgon/editor-ui`, ISC licence; add it to third-party notices). No other icon sets, hand-drawn SVG icons or emoji. strokeWidth 1.75; size 14 px in tabs/rows, 16 px in toolbars, 20 px for tiles. Icons are decorative (`aria-hidden`) next to a label; every icon-only button has an accessible name and tooltip.
- Type: Segoe UI Variable 11/12/13 px; Cascadia Code for IDs, paths and numbers. Text is short labels; secondary text muted `oklch(.62 .006 270)` or brighter.
- Patterns: minimal top strip with breadcrumb, Play and history/save controls; compact floating tool pill; dense rounded Hierarchy/Inspector cards; bottom command pill and prompt. Active tools and open commands use ember. Chat keeps messages above the prompt, with quiet activity and inline approvals. Status bar uses short words and real values.
- Motion is 0–120 ms and drops to 0 under reduced motion.

### Keyboard
Ctrl+K, Ctrl+L or `/` focuses the prompt (`/` only outside text inputs). Ctrl+1 toggles Hierarchy; Ctrl+2 toggles Inspector; Ctrl+I shows and focuses Inspector. Ctrl+` toggles Console; Ctrl+Shift+R opens Review. Escape collapses the expanded secondary card, including while editing the prompt; Escape inside the provider disclosure closes that disclosure first. Ctrl+S saves; Ctrl+Z and Ctrl+Shift+Z/Ctrl+Y undo/redo outside text inputs. Q/W/E/R choose Select/Move/Rotate/Scale; F frames selection; F5 toggles Play/Stop. Ctrl+Enter sends, Enter inserts a newline, Ctrl+. stops the agent and Ctrl+Shift+L adds selection to the message. Shortcuts are listed in Settings and relevant tooltips. Existing hierarchy keyboard operations remain available. Shortcuts are currently fixed, not user-remappable.

Ctrl+D duplicates the selection outside text fields. Hold Ctrl while dragging a gizmo to invert Snap temporarily. Snap and Align to surface are labelled buttons activated with Enter/Space; their step selectors use native keyboard selection. Assets groups and tiles are reachable with Tab; activate a tile, then Tab to Add to scene and press Enter/Space for centre-surface placement.

Component properties must be editable through validated whole-component updates; a dedicated property-patch command is not required. Permission descriptions must reflect actual provider guarantees and must not equate approval modes or cwd with OS confinement. Full-local mode requires deliberate selection when no safer supported mode exists.
