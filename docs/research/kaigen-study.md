# Kaigen Studio / HZ engine study
Author: Nitish

Read-only static study (17 October 2026) of the installed Kaigen Studio (`D:\Nitish\Kaigen`) and a generated project (`projects\test`, engine `hz` 0.6.2.002-beta), using the leanrea method. Nothing was executed, so runtime behavior, performance and quality are unverified. Claims are from shipped files, docs and strings.

## What it is
- **Studio:** a native C hub on the HZ engine (D3D12, Clay UI). Project/template browser, engine versions and modules, target selection, run/release/publish through `hzbuild.exe`, build logs, terminal, external editor, AI-tool picker. Self-updates with SHA-512 checks and rollback. No in-hub scene editing; model generation, rigging and animation are "coming soon".
- **Engine:** HZ, a no-libc C11 engine with lock-step SPMD threads and an archetype ECS. Documented coverage: deferred renderer (TAA, shadows, IBL, GTAO, bloom, terrain, grass, particles, decals, water, sky), physics (static/kinematic/dynamic, joints, vehicles), skinned animation with blending and IK, a spatial audio mixer, Clay UI/HUD, and input actions with record/replay. Shipped as headers plus prebuilt libraries.
- **Editor:** built into the running game. F1 opens it and pauses simulation; F5 saves. It has GPU picking, W/E/R gizmos with local/world space, hierarchy, a reflection-generated inspector with ranges, create/duplicate/reparent/delete, asset-browser drops placed at pick depth or by terrain raycast, a prefab stage, gesture undo, and a command prompt. No grid snapping, surface-normal alignment, placement brushes or terrain sculpting were found.

## Ideas worth adopting in Forgon
1. **One authoring contract.** Scene files, inspector-edited parameters, visual tools and agent commands all act on the same stable-ID entities. Forgon already has the stable IDs and command/undo model; keep Edit and Play on the same Three.js materials and lights.
2. **Typed properties drive Inspector and persistence.** HZ reflects component fields (with ranges) into the inspector and the scene file. Forgon's equivalent is script/component property schemas.
3. **Text scenes that diff cleanly.** Sorted by stable ID, byte-identical output when nothing changed, runtime-only fields excluded. Forgon's JSON scenes should keep the same guarantee.
4. **Real prefabs:** nested instances, stable part IDs, field overrides, apply/revert, and propagation that keeps instance overrides. HZ's prefab apply is not undoable and closing the prefab stage discards edits; Forgon should make both safe.
5. **Agent verification is a product feature.** A scripted command vocabulary (screenshot, input, find/frame/dump entity, UI dump, `help`), a fixed-step capture clock, and guidance that compiling is not proof of behavior. Unknown commands must fail.
6. **Gameplay blocks:** editable, project-owned mechanics (character controller, camera rig, scatter) that separate tuning, input intent, runtime state and outputs. For Forgon these are TypeScript recipes with inspector-visible tuning.
7. **Agent knowledge ships with the engine version:** skills, hooks and agent definitions per engine version, a small indexed wiki (index, then subsystem page, then source), and source-intent sidecars separate from generated runtime assets.

## Avoid
- No-libc C and SPMD complexity; Forgon is Three.js/TypeScript.
- Copying the renderer feature list before level authoring works.
- Editing a paused live game as a substitute for a safe Edit mode. Forgon must open projects without running gameplay.
- Requiring Windows Developer Mode for symlinks (Kaigen links engine skills into projects).
- Treating coding-rule hooks as a security boundary; keep permissions separate.
