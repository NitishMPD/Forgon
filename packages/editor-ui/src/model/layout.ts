// Floating cards share one expanded secondary surface; the viewport and composer stay mounted.
import type { SnapSettings } from '../services.js';

export const defaultSnap: SnapSettings = { enabled: false, translate: 0.5, rotateDeg: 15, scale: 0.1 };
export const snapSteps = { translate: [0.25, 0.5, 1, 2], rotateDeg: [15, 45, 90], scale: [0.1, 0.25] } as const;
export const cardIds = ['project', 'console', 'review', 'agents', 'stats', 'composer'] as const;
export type CardId = (typeof cardIds)[number];
export interface LayoutState {
  version: 3;
  hierarchy: boolean;
  inspector: boolean;
  expandedCard: CardId | null;
  snap?: SnapSettings;
  alignToSurface?: boolean;
}
export const defaultLayout: LayoutState = { version: 3, hierarchy: true, inspector: true, expandedCard: null };
export interface LayoutRead { layout: LayoutState; recovered: boolean }
export function parseLayout(input: unknown): LayoutRead {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { layout: defaultLayout, recovered: true };
  const value = input as Record<string, unknown>;
  if (value['version'] !== 3 || typeof value['hierarchy'] !== 'boolean' || typeof value['inspector'] !== 'boolean'
    || (value['expandedCard'] !== null && !(cardIds as readonly unknown[]).includes(value['expandedCard']))) {
    return { layout: defaultLayout, recovered: true };
  }
  const layout: LayoutState = { version: 3, hierarchy: value['hierarchy'], inspector: value['inspector'], expandedCard: value['expandedCard'] as CardId | null };
  let recovered = false;
  if (value['alignToSurface'] !== undefined) {
    if (typeof value['alignToSurface'] === 'boolean') layout.alignToSurface = value['alignToSurface'];
    else recovered = true;
  }
  const snap = value['snap'];
  if (snap === undefined) return { layout, recovered };
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return { layout, recovered: true };
  const settings = snap as Record<string, unknown>;
  if (typeof settings['enabled'] !== 'boolean' || !Object.entries(snapSteps).every(([key, steps]) => (steps as readonly unknown[]).includes(settings[key]))) {
    return { layout, recovered: true };
  }
  layout.snap = { enabled: settings['enabled'], translate: settings['translate'] as number, rotateDeg: settings['rotateDeg'] as number, scale: settings['scale'] as number };
  return { layout, recovered };
}
export function toggleCard(layout: LayoutState, card: CardId): LayoutState {
  return { ...layout, expandedCard: layout.expandedCard === card ? null : card };
}
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readLayout(storage: KeyValueStorage | null, key: string): LayoutRead {
  if (!storage) return { layout: defaultLayout, recovered: false };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { layout: defaultLayout, recovered: true };
  }
  if (raw === null) return { layout: defaultLayout, recovered: false };
  try {
    return parseLayout(JSON.parse(raw));
  } catch {
    return { layout: defaultLayout, recovered: true };
  }
}

export function writeLayout(storage: KeyValueStorage | null, key: string, layout: LayoutState): void {
  try {
    storage?.setItem(key, JSON.stringify(layout));
  } catch {
    // Layout persistence is best-effort; the workspace keeps working without it.
  }
}
