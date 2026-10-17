# Standalone web export implementation
Author: Nitish

## Integration boundary and implementation plan

CLI owner changes only packages/cli and this document. Runtime/preview/desktop remain their workers' responsibility. Execute inline; no agents, install, root lock edits, commits or launches.

- [x] Add `forge build --target web <project-root> --out <nonexistent-output>` while retaining inspect/validate/create/bake/import parsing. Package with installed pinned Vite 8.3.4/esbuild 0.28.2, configFile:false; never load project config/plugins/scripts.
- [x] Validate complete catalogs through project-io; copy exact registered assets under an exporter-owned namespace and serialize validated scene/prefab/catalog snapshots. Record SHA-256 and provenance without timestamps/absolute machine paths.
- [x] Stage files in a private temporary directory. Claim destination with exclusive mkdir; publish files exclusively; cleanup only tracked unchanged files and empty directories. Never recursive-delete output or user paths. Reject lexical dot traversal and preexisting outputs.
- [x] Test create-only, traversal, unsupported script/components, failed publication cleanup, exact assets and manifest consistency; typecheck CLI including its Node imports and browser entry. Build hotel fixture against actual runtime and inspect bundled artifact independence. Parent owns browser and Windows shell tests.

Runtime coordination: export needs a browser-only public `@forgon/game-runtime/runtime` entry that mounts actual standalone play (no editor-viewport). Please expose `mountGame(container, {scene, assets, prefabs, loadAssetBytes, onRuntimeEvent})` and a shared Node-safe `validatePlayableScene(scene, {assets,prefabs})` that throws on unsupported required component types/properties (especially script and unimplemented physics). Existing arbitrary API/property validation belongs to runtime, not a duplicated CLI schema. CLI will call that validator before packaging and mountGame in generated browser entry. If final public API differs, adapt exporter to the actual implementation. Script assets may be copied inertly; script components always fail until safe script execution exists. No project source is imported during build.

Runtime integration is implemented: `/runtime` is Node-import-safe, validates required semantics synchronously, and mounts the standalone engine asynchronously. The browser entry awaits mount and disposes on pagehide.

## Implemented exporter contract

`@forgon/cli` exports Node-only `buildWeb(projectRoot, nonexistentOutput)` returning `{status:'built',target:'web',output,manifestHash}` only after successful publication. `forge build --target web <root> --out <output>` accepts options before/after the single project root. Missing/duplicate/unknown options and unsupported targets return usage status 2. Validation, unsupported runtime, bundling or publication failures return status 1 and no success payload. Existing inspect/validate/create/bake/import behavior is retained.

No separate game-export workspace is justified for this single CLI-owned exporter. Dependencies are the installed workspace runtime plus existing pinned Vite 8.3.4 and esbuild 0.28.2. Parent performed the only root installation; this worker did not edit root configuration or lockfiles.

Output layout:

- `index.html`: local module entry and keyboard-accessible Start game button; user gesture starts audio-capable runtime.
- `game.js`: bundled actual standalone runtime, PlayCanvas and schema dependency. No external module imports. The bundler graph rejects studio/editor-viewport/camera/gizmo/picking/IO/agent/Tauri modules.
- `game.json`: validated original project manifest, all registered scene/prefab snapshots, original registry and an ID-to-local-asset URL map. Source paths remain provenance; runtime loads snapshots and the explicit exported asset map.
- `assets/<asset-id>/<original-filename>`: byte-for-byte original registered assets, including inert script assets. No authored script import, compiler hook, Vite config, dotenv file or arbitrary generator runs. Script components always fail explicitly.
- `licenses/playcanvas.txt`, `licenses/zod.txt`, `licenses/ammo.txt`, `licenses/ammo-provenance.md`: installed dependency notices plus original tagged Ammo payload provenance.
- `build-manifest.json`: version/target/start scene/toolchain, generator identity when present, scene snapshot hashes, original asset paths/provenance and actual SHA-256/length for every payload file. Manifest excludes its own circular hash; successful CLI JSON supplies that hash. There are no timestamps or machine paths. Reproducibility means same source/toolchain yields same payload hashes, not a cross-platform engine determinism claim.

Asset reads go through shared project-io catalog/canonical-containment checks and a bounded regular-file reader (256 MiB per asset, 512 MiB total). JSON/catalog quotas remain IO-owned. This is a captured snapshot, not a cross-process transaction locking external source editors.

Publication first validates a nonexistent destination with an existing canonical parent and rejects lexical dot traversal. It stages under a private random sibling directory, then claims the output with exclusive mkdir and atomically hard-links complete files create-only on the same volume. Manifest is published last. Any failed build removes only tracked unchanged published files and empty owned directories; changed/user files survive. No recursive remove exists in production export code. Filesystems must support hard links (NTFS supported); unsupported filesystems fail honestly. Like project IO, portable Node operations cannot sandbox a hostile process continuously replacing directory ancestors; canonical parent checks narrow that race but do not claim OS sandboxing or power-loss durability.

Static hosting of the complete artifact directory is required (HTTP/HTTPS or a native shell's local asset protocol); a development server, repo/node_modules, studio installation, agent, Tauri or CDN is not required. Double-click `file://` browser fetch restrictions are not bypassed. Browser/GPU/audio and Windows wrapper verification belong to parent/desktop owners.

## Connected checks and artifact

All **22 CLI tests pass**, with no skips. Runtime's **five tests pass**, including actual Ammo WASM raycasts against scaled hotel boxes, kinematic queue movement and detached play-state restoration. Runtime, preview, CLI and connected Studio typechecks pass; Studio and preview production builds pass. These checks use the actual pinned PlayCanvas engine rather than a stub. Parent owns browser/GPU/audio and native-shell QA.

The browser-only runtime entry is `@forgon/game-runtime/runtime`. `mountGame(container,{scene,assets,prefabs,loadAssetBytes,onRuntimeEvent})` returns a **Promise<GameHandle>** and rejects failed initialization; the generated player awaits it. Audio context activation begins in the Start gesture before asynchronous physics loading. `validatePlayableScene` is synchronous and Node-import-safe, rejects unsupported types/properties and invalid runtime references, and requires one active camera. Real static/kinematic box colliders use AmmoPhysicsWorld; reflected/sheared colliders, authored rigidbody components and scripts are gated explicitly. See runtime-implementation.md for the supported semantics and editor batch callback.

The exporter packages the exact tagged engine's Ammo JS/WASM payloads through Vite's local URL handling; library output inlines them, preserving standalone operation. `licenses/ammo.txt` and `licenses/ammo-provenance.md` retain upstream notices, source URLs and SHA-256 values; both are covered by the build manifest. `rolldownOptions.output.codeSplitting:false` replaces the deprecated inlineDynamicImports option. Existing bundle-graph rejection and all publication/asset safety tests remain enabled.

Review artifact: `packages/cli/.artifacts/hotel-web`. It contains the original hotel data/asset snapshots, local bundled runtime/physics and all dependency notices. The output was created through the real create-only exporter, with no project scripts or configs loaded. Its manifest's payload lengths/hashes and original asset bytes are covered by the exporter regression; identical-source second builds produce byte-identical manifests. Serve the whole directory over HTTP/HTTPS for the parent's playback QA.

Exact checks/commands (repository root):

```powershell
pnpm --filter @forgon/game-runtime --filter @forgon/game-preview --filter @forgon/cli --filter @forgon/studio typecheck
pnpm --filter @forgon/game-runtime test
pnpm --filter @forgon/cli test
pnpm --filter @forgon/studio build
pnpm --filter @forgon/game-preview build
pnpm --filter @forgon/cli forge build --target web ../../examples/hotel-vertical-slice --out .artifacts/hotel-web
```

The last command runs from packages/cli and refuses to overwrite the now-existing artifact; choose a fresh nonexistent output to repeat it. No browser automation, app launch, commit, branch, push or deployment was performed in this lane. Build/test success does not establish rendered pixels, audible playback or native-shell CSP compatibility.

Final artifact verification: build-manifest SHA-256 91595b35233293d2375e8a3d50dc99701f1ffa8131411aa16fa9aa5031f11401; ten payload hashes/lengths verified, three original asset files byte-identical, and the exact 750,028-byte vendored Ammo WASM is embedded in game.js. The three focused build-web tests also pass after asserting embedded physics bytes and retained Ammo notices.
