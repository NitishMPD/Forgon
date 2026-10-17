import type { AssetRecord, PrefabDocument, SceneDocument, Transform, ValidationContext } from '@forgon/project-schema';

// Boundary types for the editor viewport mount. These mirror the shapes the UI layer
// declares in @forgon/editor-ui/src/services.ts (ViewportMount/ViewportHandle) but are
// defined here so the standalone runtime never imports editor UI.

export type ViewportTool = 'select' | 'translate' | 'rotate' | 'scale';

export interface ViewportView {
  scene: SceneDocument;
  selectedIds: readonly string[];
}

export interface ViewportCallbacks {
  onPick(entityId: string | null): void;
  onFault(message: string): void;
  /** Called when a gizmo gesture commits a new local transform. Routed through the store by the host. */
  onTransform?(entityId: string, transform: Transform): void;
  /** Atomic multi-selection gesture; hosts execute these changes as one command batch. */
  onTransforms?(changes: readonly { entityId: string; transform: Transform }[]): void;
}

export type RuntimeEvent =
  | { type: 'play-started' }
  | { type: 'play-stopped' }
  | { type: 'arrival'; entityId: string; waypointEntityId: string }
  | { type: 'audio'; entityId: string; status: 'played' | 'unavailable' | 'error'; message?: string }
  | { type: 'vfx'; entityId: string; waypointEntityId: string }
  | { type: 'fault'; message: string };

export interface PlaySnapshot {
  readonly scene: SceneDocument;
  readonly prefabs: readonly PrefabDocument[];
  readonly assets: readonly AssetRecord[];
}

export type AssetBytesResolver = (assetId: string) => Promise<Uint8Array | null> | Uint8Array | null;

export interface ViewportMountOptions {
  /** Validation catalogs for reference checking; the host store validates too, so this is optional. */
  context?: ValidationContext;
  /** Resolve asset bytes for play-mode audio. Absent/null means audio reports unavailable. */
  loadAssetBytes?: AssetBytesResolver;
  /** Stream of play-mode runtime events (arrivals, audio, vfx). */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}

export interface ViewportHandle {
  update(view: ViewportView): void;
  setTool?(tool: ViewportTool): void;
  frameSelection?(): void;
  play?(scene: SceneDocument): void;
  stop?(): void;
  dispose(): void;
}

export type ViewportMount = (
  container: HTMLElement,
  callbacks: ViewportCallbacks,
  options?: ViewportMountOptions,
) => ViewportHandle;
