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

// Ctrl+Enter sends. Plain Enter inserts a newline. IME composition never sends.
export function isSendKey(event: KeyLike): boolean {
  return event.key === 'Enter'
    && event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.isComposing
    && event.keyCode !== 229;
}

export type ContextChipKind = 'entity' | 'scene' | 'asset';

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
  return assets.some(asset => asset.id === chip.ref) ? 'ok' : 'missing';
}

// Only chips that map onto AgentContext v1 fields. Other kinds are not offered.
export function buildContext(chips: readonly ContextChip[]): AgentContext {
  const entityIds = chips.filter(chip => chip.kind === 'entity').map(chip => chip.ref);
  const assetIds = chips.filter(chip => chip.kind === 'asset').map(chip => chip.ref);
  const scene = chips.find(chip => chip.kind === 'scene');
  const context: AgentContext = { files: [], entityIds: [...new Set(entityIds)], assetIds: [...new Set(assetIds)] };
  if (scene) context.sceneId = scene.ref;
  return context;
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
