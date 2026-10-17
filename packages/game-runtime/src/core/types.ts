import type { AssetRecord, PrefabDocument, SceneDocument, Transform, ValidationContext } from '@forgon/project-schema';

// Boundary types for the editor viewport mount. These mirror the shapes the UI layer
// declares in @forgon/editor-ui/src/services.ts (ViewportMount/ViewportHandle) but are
// defined here so the standalone runtime never imports editor UI.

export type ViewportTool = 'select' | 'translate' | 'rotate' | 'scale';

export interface SnapSettings {
  enabled: boolean;
  translate: number;
  rotateDeg: number;
  scale: number;
}

export interface SurfacePoint {
  position: [number, number, number];
  normal: [number, number, number];
  /** Local-space lower bound of an already loaded GLB; null means use its origin. */
  modelMinY?(assetId: string): number | null;
}

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

export interface HudNumbers {
  time: number; deaths: number; collected: number; total: number;
  checkpointIndex: number; checkpointTotal: number; speed: number; grounded: boolean;
  finished: boolean; finishTime: number | null;
}

export type RuntimeEvent =
  | { type: 'play-started' }
  | { type: 'play-stopped' }
  | { type: 'arrival'; entityId: string; waypointEntityId: string }
  | { type: 'audio'; entityId: string; status: 'played' | 'unavailable' | 'error'; message?: string }
  | { type: 'vfx'; entityId: string; waypointEntityId: string }
  | { type: 'checkpoint'; entityId: string; index: number; total: number }
  | { type: 'collect'; entityId: string; value: number; collected: number; total: number }
  | { type: 'goal'; time: number; deaths: number; collected: number; total: number }
  | { type: 'death'; reason: 'fall' | 'hazard'; deaths: number }
  | { type: 'respawn'; checkpointEntityId: string; index: number }
  | { type: 'jump'; double: boolean }
  | { type: 'wall-run'; side: -1 | 1 }
  | { type: 'slide' }
  | { type: 'hud'; hud: HudNumbers }
  | { type: 'fault'; message: string };

export interface PlaySnapshot {
  readonly scene: SceneDocument;
  readonly prefabs: readonly PrefabDocument[];
  readonly assets: readonly AssetRecord[];
}

export type AssetBytesResolver = (assetId: string) => Promise<Uint8Array | null> | Uint8Array | null;

export interface ViewportMountOptions {
  scripts?: import('../scripting/index.js').ScriptModules;
  /** Validation catalogs for reference checking; the host store validates too, so this is optional. */
  context?: ValidationContext;
  /** Resolve asset bytes for GLB models and play-mode audio. Absent/null reports a fault. */
  loadAssetBytes?: AssetBytesResolver;
  /** Stream of play-mode runtime events (arrivals, audio, vfx). */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
}

export interface ViewportHandle {
  update(view: ViewportView): void;
  setTool?(tool: ViewportTool): void;
  setSpace?(space: 'local' | 'world'): void;
  setSnap?(snap: SnapSettings): void;
  surfaceAt?(clientX: number, clientY: number): SurfacePoint | null;
  frameSelection?(): void;
  play?(scene: SceneDocument, scripts?: import('../scripting/index.js').ScriptModules): void;
  stop?(): void;
  dispose(): void;
}

export type ViewportMount = (
  container: HTMLElement,
  callbacks: ViewportCallbacks,
  options?: ViewportMountOptions,
) => ViewportHandle;
