import type { AgentContext, AssetRecord, PermissionMode, SceneDocument } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}

// Enter sends. Modified Enter inserts a newline. IME composition never sends.
export function isSendKey(event: KeyLike): boolean {
  return event.key === 'Enter'
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.isComposing
    && event.keyCode !== 229;
}

export type ContextChipKind = 'entity' | 'scene' | 'asset' | 'file';

export interface ContextChip {
  id: string;
  kind: ContextChipKind;
  ref: string;
  label: string;
}

export type ChipStatus = 'ok' | 'missing';

export function chipStatus(chip: ContextChip, scene: SceneDocument | null, assets: readonly AssetRecord[]): ChipStatus {
  if (chip.kind === 'entity') return scene?.entities.some(entity => entity.id === chip.ref) ? 'ok' : 'missing';
  if (chip.kind === 'scene') return scene?.sceneId === chip.ref ? 'ok' : 'missing';
  if (chip.kind === 'file') return assets.some(asset => asset.path === chip.ref) ? 'ok' : 'missing';
  return assets.some(asset => asset.id === chip.ref) ? 'ok' : 'missing';
}

// Only chips that map onto AgentContext v1 fields. Other kinds are not offered.
export function buildContext(chips: readonly ContextChip[]): AgentContext {
  const entityIds = chips.filter(chip => chip.kind === 'entity').map(chip => chip.ref);
  const assetIds = chips.filter(chip => chip.kind === 'asset').map(chip => chip.ref);
  const scene = chips.find(chip => chip.kind === 'scene');
  const files = chips.filter(chip => chip.kind === 'file').map(chip => chip.ref);
  const context: AgentContext = { files: [...new Set(files)], entityIds: [...new Set(entityIds)], assetIds: [...new Set(assetIds)] };
  if (scene) context.sceneId = scene.ref;
  return context;
}

function fileChip(path: string): ContextChip {
  return { id: `file:${path}`, kind: 'file', ref: path, label: path };
}

export function clipboardFiles(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
  if (data.files.length) return Array.from(data.files);
  return Array.from(data.items).flatMap(item => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

// The bridge accepts paths, not attachment bytes. Resolve only unambiguous registered files.
export function attachmentReferences(files: readonly Pick<File, 'name' | 'webkitRelativePath'>[], assets: readonly AssetRecord[]): { chips: ContextChip[]; rejected: string[] } {
  const paths = [...new Set(assets.map(asset => asset.path))];
  const chips: ContextChip[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const matches = paths.filter(path => file.webkitRelativePath ? path === file.webkitRelativePath : path.split('/').at(-1) === file.name);
    if (matches.length === 1) {
      const path = matches[0]!;
      if (!chips.some(chip => chip.ref === path)) chips.push(fileChip(path));
    } else rejected.push(file.name);
  }
  return { chips, rejected };
}

export interface MentionQuery { start: number; end: number; query: string }

export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! } : null;
}

export function mentionOptions(scene: SceneDocument | null, assets: readonly AssetRecord[], query: string): ContextChip[] {
  const options: ContextChip[] = [
    ...(scene ? [{ id: `scene:${scene.sceneId}`, kind: 'scene' as const, ref: scene.sceneId, label: scene.name },
      ...scene.entities.map(entity => ({ id: `entity:${entity.id}`, kind: 'entity' as const, ref: entity.id, label: entity.name }))] : []),
    ...assets.map(asset => ({ id: `asset:${asset.id}`, kind: 'asset' as const, ref: asset.id, label: asset.name })),
    ...[...new Set(assets.map(asset => asset.path))].map(fileChip),
  ];
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  return options.filter(chip => words.every(word => `${chip.kind} ${chip.label} ${chip.ref}`.toLocaleLowerCase().includes(word)));
}

export function insertMention(text: string, query: MentionQuery): { text: string; caret: number } {
  // The visible chip owns the reference; remove only the active query, preserving surrounding text.
  return { text: text.slice(0, query.start) + text.slice(query.end), caret: query.start };
}

export interface HistoryRecall { index: number; text: string }


export function recallPrompt(prompts: readonly string[], draft: string, previous: HistoryRecall | null, direction: 'ArrowUp' | 'ArrowDown'): HistoryRecall | null {
  if (!prompts.length || (draft !== '' && (!previous || draft !== previous.text))) return null;
  const index = previous && draft === previous.text ? previous.index : prompts.length;
  if (direction === 'ArrowDown' && index === prompts.length) return null;
  const next = Math.max(0, Math.min(prompts.length, index + (direction === 'ArrowUp' ? -1 : 1)));
  return { index: next, text: prompts[next] ?? '' };
}

export interface SendInput {
  projectOpen: boolean;
  provider: AgentProviderInfo | null;
  permissionMode: PermissionMode | null;
  chips: readonly ContextChip[];
  scene: SceneDocument | null;
  assets: readonly AssetRecord[];
}

// Reasons shown next to the composer. An empty draft is not a blocker; Send simply does nothing.
export function sendBlockers(input: SendInput): string[] {
  const reasons: string[] = [];
  if (!input.projectOpen) reasons.push('Open a project to use agents. The in-memory sample has no project folder.');
  if (!input.provider) {
    reasons.push('No provider is available.');
  } else {
    if (input.provider.readiness === 'not-ready') {
      reasons.push(`${input.provider.name} is not ready.${input.provider.message ? ` ${input.provider.message}` : ''}`);
    }
    if (input.permissionMode === null || !input.provider.permissionModes.includes(input.permissionMode)) {
      reasons.push(`Choose a permission mode that ${input.provider.name} supports.`);
    }
  }
  const missing = input.chips.filter(chip => chipStatus(chip, input.scene, input.assets) === 'missing').length;
  if (missing > 0) reasons.push(`${missing} context ${missing === 1 ? 'reference is' : 'references are'} no longer in the scene. Remove them to send.`);
  return reasons;
}

/** Keep the visible user message intact; only the provider receives the generation guidance. */
export function progressiveDesignPrompt(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${text}\n\n[Forgon Progressive design is enabled. While building or editing the scene, save complete, valid intermediate scene snapshots in small meaningful batches so the open editor can show progress. Publish the first visible batch early and continue saving as you add things; do not wait until the end. Keep every published snapshot schema-valid with its dependencies available, and replace scene files atomically. Preserve existing content and authoring/generator workflows. Do not run game scripts merely to preview edits. This instruction does not grant additional permissions.]`;
}
