# CLI and asset import integration
Author: Nitish

## Scope and implementation sequence

This change owns `packages/cli`, `packages/asset-pipeline`, and the concrete registration additions in `packages/project-io`. Parent owns root installation/lockfile, project/design/task docs, desktop transport, runtime and export. No nested agents, branches or commits. No UI/runtime/agent files changed.

1. Replace the CLI's duplicated bounded reader with exports from `@forgon/project-io/node`; retain the CLI reader export for callers/tests.
2. Implement create using existing fixture-backed create-only IO and explicit bake persistence using session `saveAuthoring` with both byte revisions.
3. Validate bounded local source bytes in asset-pipeline; register original bytes through IO's existing containment, serialization and atomic-write primitives. Exercise real filesystem failures, then publish this integration contract.

## CLI

Run `pnpm --filter @forgon/cli forge <command> ...`. Filter scripts run from `packages/cli`, so project/source paths are relative to that directory unless absolute.

```text
forge inspect <root>
forge validate <root>
forge create <new-root> [--template empty-3d|hotel]
forge bake <root> [--seed <seed>] [--write]
forge import <root> <source-file> --license <license> [--id <id>]
  [--destination assets/<filename>] [--source <provenance>] [--name <name>]
```

Create defaults to empty-3d and refuses every existing destination, including an empty folder. Bake defaults to the original stdout `{scene,authoring}` bundle without filesystem changes. Only `--write` saves that pair, using the shared journal transaction. Success stdout remains the same bundle. Unrecorded manual edits, authoring conflicts and either stale revision produce exit 1 with stderr and no success payload. The source scene file receives only the scene document, never the whole bundle. Only bundled hotel/empty-3d generators run; project scripts are never evaluated.

Import requires an explicit license declaration; it does not infer ownership or licensing. Its success JSON is the registration result below. Defaults: UUID asset ID, original basename as name/provenance source, `assets/<id><extension>` destination. A supplied ID creates a new record only; it never authorizes replacement. Duplicate IDs, existing destinations and stale registries fail without overwriting originals. Reimport of an existing stable ID is explicitly deferred; authored scene references are preserved because this operation never edits existing IDs or scenes.

Exit 0: successful supported command/help. Exit 1: file/validation/conflict/IO failure. Exit 2: bad usage/duplicate or unknown options, unsupported template, missing import license, or unavailable capability. Snapshot/build/test/preview/open remain explicitly unavailable; no fake runtime output was added.

## Public Node API

Existing `NodeProjectSession`, `NodeProjectHost`, scene/authoring APIs and browser-safe `@forgon/project-io` default entry point are unchanged. Runtime additions are named exports from `@forgon/project-io/node`:

```ts
interface AssetRegistryRead { registry: AssetRegistry; revision: string }
interface RegisterAssetRequest {
  asset: AssetRecord;
  bytes: Uint8Array;
  expectedRegistryRevision: string;
}
type RegisterAssetResult =
  | { status: 'saved'; asset: AssetRecord; registryRevision: string }
  | { status: 'conflict' };
readAssetRegistry(root: string): Promise<AssetRegistryRead>;
registerAsset(root: string, request: RegisterAssetRequest): Promise<RegisterAssetResult>;
```

`registerAsset` is the concrete IO operation for already validated bytes. Untrusted local source ingestion belongs to the new Node-only `@forgon/asset-pipeline` package:

```ts
interface ImportAssetRequest {
  sourcePath: string;
  license: string;
  source?: string;
  name?: string;
  id?: string;
  destination?: string;
  expectedRegistryRevision: string;
}
importAsset(root: string, request: ImportAssetRequest): Promise<RegisterAssetResult>;
validateAsset(bytes: Uint8Array, extension: string): 'model'|'texture'|'audio';
// extension is lower-case and includes its dot; validation throws on unsupported/invalid bytes.
// readAssetRegistry is also re-exported by asset-pipeline.
```

The future desktop UI should authorize the source path through native file selection, obtain a registry revision, and invoke import on the host. Do not import this Node package into the webview or expose unrestricted source-path reads to web content. After success, call the existing session `readCatalog()` to refresh its detached metadata snapshots. No new session methods were required, so active desktop callers remain compatible.

## Source validation and bounded behavior

Original bytes are preserved, with SHA-256 in existing `provenance.hash`, declared license/source and stable registry ID/name/kind/path. No schema version change, generated optimized derivative or sidecar metadata format was introduced.

- Sources must be regular files, not final-component symlinks. Reads use an opened handle, pre/post-open file identity check and a 32 MiB plus one-byte bound, including growing files.
- GLB: exact version-2 header/file length, aligned bounded chunks, first JSON <=2 MiB/depth 64, optional single BIN, asset version 2.0, embedded buffer and bufferView ranges, embedded image bufferView/MIME declarations. Every `uri` key is refused, including remote, traversal and data URIs. Required extensions are refused. Container validation is deliberately not a complete glTF semantic/accessor/animation/mesh validator, a decoder, or a game-ready certification. Embedded image payloads are not independently decoded here.
- PNG: signature, chunk boundaries and CRC, first IHDR, contiguous IDAT, terminal IEND, dimensions, bounded zlib decompression to exact scanline size, valid filter bytes. Supports noninterlaced 8-bit gray, gray-alpha, RGB and RGBA; indexed/interlaced/16-bit formats are refused explicitly.
- JPEG: SOI, bounded marker segments, baseline/progressive 8-bit frame/component table, dimensions, scan framing/byte stuffing/restart markers and terminal EOI. This is structural validation, not entropy/pixel decoding.
- Images: dimensions <=16384 each and <=16,777,216 total pixels. PNG decoded bytes are bounded by that dimension/channel budget.
- WAV: exact RIFF/WAVE length, bounded padded chunks, one fmt/data chunk, PCM8/16/24/32 or float32, 1–8 channels, 8–192 kHz, consistent rate/block alignment and nonempty aligned sample bytes. Compressed/extensible WAV is refused.
- SVG, WebP, GIF, external-resource glTF and other formats are explicitly unsupported. SVG is never parsed, rendered or copied by import, avoiding script injection. Existing registered fixture SVGs remain readable unchanged.

No compression/transcoding dependencies, source execution, preview or runtime asset readiness claims.

## IO invariants and failure limits

Registration uses the same canonical-root queue, path confinement, bounded catalog reader, schema/project validator, create-only temp+link publication and revision-checked atomic registry replacement as other IO operations. Destinations must be direct `assets/<filename>` children of an existing contained assets directory. Reserved Windows names, unsafe path forms, aliases to registered files, existing files and symlink/junction escapes are refused. All current project IDs/references and the complete prospective catalog's byte/document/asset quotas are validated before publishing the new registry. Existing records and authored references retain their order and contents.

The payload is created first; publication checks its bytes and the expected registry revision. Failure rolls back only the created payload if its bytes are still identical; an external payload edit is preserved. A failed registry rename leaves original registry/source bytes intact. A stale registry returns conflict. Source files are never modified or deleted.

This single-registry commit intentionally has no second custom transaction journal. Process death between payload creation and registry publication can leave an unregistered original payload; the registry never points to a deliberately uncreated file. Restart does not delete or adopt orphan files. A subsequent import into that exact existing path fails create-only. External edits/deletion during rollback can make cleanup fail explicitly; the operation does not guess or delete unknown bytes.

As documented for existing IO, portable Node canonical checks and final revision checks are not a hostile cross-process sandbox or atomic OS compare-and-swap. A noncooperating process can race an ancestor rename, payload replacement, registry/catalog mutation or final check-to-rename interval. All cooperating sessions in this process share serialization. Source parent symlinks are resolved by the OS; only the final source symlink is refused. Native directory handles and an enforced writer broker would be required for stronger adversarial guarantees. Power-loss durability remains unverified.

## Verification and parent integration

No new third-party dependencies or additional lockfiles. Asset-pipeline depends on existing schema/IO; CLI adds workspace dependencies on IO and asset-pipeline. Parent retains root installation/lockfile ownership. pnpm 12 may refresh workspace resolution automatically while running scripts; no explicit install or manual root configuration/lockfile edits were performed here.

Verification uses actual temporary files, not mocked projects. Tests cover exact imported bytes/provenance/reopen, valid WAV/PNG/JPEG/GLB, malformed/truncated/mismatched/oversized sources, SVG/URI refusal, bounds, stale registry and stable-ID collisions, unregistered file preservation, traversal, actual source/destination symlinks and junctions, injected registry revision/rename failure, rollback and external payload preservation. CLI tests cover both templates, create-only refusal, default dry bake versus written pair, stale scene/artifact revisions and actual process exit statuses. Existing 13 IO tests remain part of the check.

Verified on Windows, 17 October 2026:

```powershell
pnpm --filter @forgon/project-io --filter @forgon/asset-pipeline --filter @forgon/cli typecheck
pnpm --filter @forgon/project-io --filter @forgon/asset-pipeline --filter @forgon/cli test
```

All three type-checks passed. Tests: **13 IO + 10 asset-pipeline + 14 CLI = 37 passed, zero failures/skips**. Fault injection wraps real filesystem link/rename operations and restores the built-in exports; actual project/source files and all parsing/commit/rollback operations remain real. The JPEG fixture is an original one-pixel image encoded once with Pillow; Pillow is not a runtime or test dependency. The repository lockfile scan found only root `pnpm-lock.yaml`.

Runtime/export/browser/Tauri and root-wide checks are outside this worker's ownership. No build/server/app launch, browser verification, commit, branch, push or deployment was performed. Parent should record this completed unit in the parent-owned daily task and project docs and retain ownership of root workspace resolution.
