import type { AssetRecord, AssetRegistry, PrefabDocument, ProjectManifest, SceneDocument, SceneIO } from '@forgon/project-schema';
import type { AuthoringArtifact } from '@forgon/procedural-authoring';

export type ProjectIOErrorCode = 'INVALID_PATH' | 'INVALID_DOCUMENT' | 'LIMIT_EXCEEDED' | 'NOT_FOUND' | 'IO_ERROR' | 'ALREADY_EXISTS' | 'CLOSED' | 'UNRECORDED_CHANGES' | 'AUTHORING_CONFLICT' | 'RECOVERY_CONFLICT';
export interface ReadProject {
  manifest: ProjectManifest; scenes: SceneDocument[]; prefabs: PrefabDocument[]; assets: AssetRegistry;
  authoring?: AuthoringArtifact;
}
export interface AuthoringRead { document: AuthoringArtifact; revision: string }
export interface SaveAuthoringRequest {
  path: string; scene: SceneDocument; authoring: AuthoringArtifact;
  expectedRevision: string; expectedAuthoringRevision: string;
}
export type SaveAuthoringResult = { status: 'saved'; revision: string; authoringRevision: string } | { status: 'conflict' };
export interface AssetRead { asset: AssetRecord; bytes: Uint8Array; revision: string }
export interface NodeProjectSession {
  readonly root: string; readonly manifest: ProjectManifest; readonly assets: readonly AssetRecord[]; readonly prefabs: readonly PrefabDocument[];
  readonly sceneIO: SceneIO;
  readCatalog(): Promise<ReadProject>;
  readAuthoring(): Promise<AuthoringRead | null>;
  saveAuthoring(request: SaveAuthoringRequest): Promise<SaveAuthoringResult>;
  readAsset(assetId: string): Promise<AssetRead>;
  close(): void;
}
export interface CreatePlan { root: string; files: readonly string[]; blockedReason?: string }
export interface RecentProject {
  path: string; name: string; lastOpened: string; status: 'ready' | 'needs_attention' | 'unavailable';
}
export type ProjectOpenResult = { status: 'opened'; session: NodeProjectSession } | {
  status: 'failed'; reason: 'not-project' | 'invalid' | 'unreadable'; message: string;
  diagnostics: readonly { path: string; message: string }[];
};
export interface NodeProjectHost {
  listRecent(): Promise<RecentProject[]>;
  pickFolder(): Promise<string | null>;
  open(root: string): Promise<ProjectOpenResult>;
  planCreate(root: string): Promise<CreatePlan>;
  create(root: string): Promise<ProjectOpenResult>;
}
