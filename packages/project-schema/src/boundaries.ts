import type { SceneDocument } from './documents.js';

export type Revision = string;
export interface Diagnostic { path: string; message: string }
export interface SceneRead { document: SceneDocument; revision: Revision }
export interface SaveSnapshot { document: SceneDocument; expectedRevision: Revision | null }
export interface SaveSceneRequest extends SaveSnapshot { path: string }
export type SaveSceneResult = { status: 'saved'; revision: Revision } | { status: 'conflict'; current: SceneRead | null };
export type SceneWatchEvent = { type: 'changed'; value: SceneRead } | { type: 'invalid'; diagnostics: Diagnostic[] } | { type: 'deleted' };
export interface SceneIO {
  readScene(path: string): Promise<SceneRead>;
  saveScene(request: SaveSceneRequest): Promise<SaveSceneResult>;
  watchScene(path: string, listener: (event: SceneWatchEvent) => void): () => void;
}
export type ProviderId = 'codex' | 'opencode' | 'claude-code';
export type PermissionMode = 'inspect' | 'supervised' | 'auto-edits' | 'full-local';
export interface AgentContext { files: string[]; sceneId?: string; entityIds: string[]; assetIds: string[] }
export interface AgentRunRequest {
  threadId: string; provider: ProviderId; model?: string; prompt: string; projectRoot: string;
  permissionMode: PermissionMode; context: AgentContext;
}
export type AgentEvent = { runId: string; threadId: string; sequence: number; timestamp: string } & (
  | { type: 'started'; provider: ProviderId }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: 'started' | 'completed' | 'failed'; text?: string }
  | { type: 'diagnostic'; diagnostic: Diagnostic }
  | { type: 'approval'; requestId: string; description: string }
  | { type: 'diff'; paths: string[]; diff?: string }
  | { type: 'completed'; outcome: 'succeeded' | 'failed' | 'cancelled'; message?: string }
);
export interface AgentService {
  start(request: AgentRunRequest): Promise<{ runId: string }>;
  cancel(runId: string): Promise<void>;
  approve(runId: string, requestId: string, allow: boolean): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
