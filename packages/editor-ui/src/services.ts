import type {
  AgentService,
  AssetRecord,
  Diagnostic,
  PermissionMode,
  PrefabDocument,
  ProjectManifest,
  ProviderId,
  SceneDocument,
  ScriptCatalog,
  ScriptModules,
  SceneIO,
  Transform,
  ValidationContext,
} from '@forgon/project-schema';

// UI boundary types. Shared contracts live in @forgon/project-schema; anything below is
// what this UI needs from the host, supplied by the parent through StudioServices.

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: string;
  status: 'ready' | 'needs_attention' | 'unavailable';
}

export interface ProjectSession {
  root: string;
  manifest: ProjectManifest;
  assets: readonly AssetRecord[];
  prefabs: readonly PrefabDocument[];
  sceneIO: SceneIO;
  compileScripts?(): Promise<ScriptCatalog>;
  readCatalog?(): Promise<{ manifest: ProjectManifest; assets: { assets: AssetRecord[] }; prefabs: PrefabDocument[] }>;
  readAsset?(assetId: string): Promise<{ asset: AssetRecord; bytes: Uint8Array; revision: string }>;
  importAsset?(license: string): Promise<void>;
  close(): void;
}

export type ProjectOpenResult =
  | { status: 'opened'; session: ProjectSession }
  | {
      status: 'failed';
      reason: 'not-project' | 'invalid' | 'unreadable';
      message: string;
      diagnostics: readonly Diagnostic[];
    };

export interface CreatePlan {
  root: string;
  files: readonly string[];
  blockedReason?: string;
}

export interface ProjectHost {
  listRecent(): Promise<RecentProject[]>;
  // Removes a project from the recent list without touching its files.
  forgetRecent?(root: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  open(root: string): Promise<ProjectOpenResult>;
  planCreate(root: string): Promise<CreatePlan>;
  planCreateChild?(parent: string, name: string): Promise<CreatePlan>;
  // Called only after the user confirms the plan returned by planCreate.
  create(root: string): Promise<ProjectOpenResult>;
  openExample?(): Promise<ProjectOpenResult>;
}

export type ProviderReadiness = 'ready' | 'not-ready' | 'unknown';

export interface AgentProviderInfo {
  id: ProviderId;
  name: string;
  readiness: ProviderReadiness;
  message?: string;
  models: readonly string[];
  permissionModes: readonly PermissionMode[];
  // Limits the provider adapter reports, in plain words. Absent means the provider reported nothing.
  limits?: readonly string[];
}

export interface AgentConnection {
  service: AgentService;
  refreshProviders?(): Promise<readonly AgentProviderInfo[]>;
  /** Fires when the host's provider readiness changed (for example, the agent service finished starting). */
  onProvidersChanged?(listener: () => void): () => void;
  providers: readonly AgentProviderInfo[];
}

export interface ViewportView {
  scene: SceneDocument;
  selectedIds: readonly string[];
  assets?: readonly AssetRecord[];
  prefabs?: readonly PrefabDocument[];
  resolveAsset?(assetId: string): Promise<Uint8Array>;
}

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
}

export interface ViewportCallbacks {
  onPick(entityId: string | null): void;
  onFault(message: string): void;
  // Called when a gizmo gesture commits a new local transform. The workspace routes it through the store.
  onTransform(entityId: string, transform: Transform): void;
  // One gesture commits as one validated command batch and undo step.
  onTransforms?(changes: readonly { entityId: string; transform: Transform }[]): void;
}

export interface ViewportHandle {
  update(view: ViewportView): void;
  // Optional: present only when the runtime supports gizmos and camera framing.
  setTool?(tool: ViewportTool): void;
  setSpace?(space: 'local' | 'world'): void;
  setSnap?(snap: SnapSettings): void;
  surfaceAt?(clientX: number, clientY: number): SurfacePoint | null;
  frameSelection?(): void;
  play?(scene: SceneDocument, scripts?: ScriptModules): void;
  stop?(): void;
  dispose(): void;
}

export interface ViewportMountOptions {
  context?: ValidationContext;
  loadAssetBytes?: (assetId: string) => Promise<Uint8Array | null>;
}

export type ViewportMount = (container: HTMLElement, callbacks: ViewportCallbacks, options?: ViewportMountOptions) => ViewportHandle;

export interface StudioServices {
  project: ProjectHost | null;
  agent: AgentConnection | null;
  viewport: ViewportMount | null;
}
