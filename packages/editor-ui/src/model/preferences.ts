import type { ProviderId } from '@forgon/project-schema';
import type { KeyValueStorage } from './layout.js';

export const preferencesKey = 'forgon.preferences.v1';
export const appearanceChoices = {
  theme: ['dark', 'oled', 'light'],
  accent: ['ember', 'blue', 'violet', 'green', 'rose', 'amber'],
  density: ['comfortable', 'compact'],
  fontSize: ['small', 'default', 'large'],
} as const;
export interface Appearance {
  theme: (typeof appearanceChoices.theme)[number];
  accent: (typeof appearanceChoices.accent)[number];
  density: (typeof appearanceChoices.density)[number];
  fontSize: (typeof appearanceChoices.fontSize)[number];
}
export interface RecentModel { provider: ProviderId; model: string }
export interface Preferences { appearance: Appearance; recentModels: RecentModel[] }
export const defaultAppearance: Appearance = { theme: 'dark', accent: 'ember', density: 'comfortable', fontSize: 'default' };

export function browserPreferencesStorage(): KeyValueStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readPreferences(storage: KeyValueStorage | null = browserPreferencesStorage()): Preferences {
  const preferences: Preferences = { appearance: { ...defaultAppearance }, recentModels: [] };
  try {
    const raw: unknown = JSON.parse(storage?.getItem(preferencesKey) ?? 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return preferences;
    const value = raw as Record<string, unknown>;
    if (value['version'] !== 1) return preferences;
    const appearance = value['appearance'];
    if (appearance && typeof appearance === 'object') {
      for (const key of Object.keys(appearanceChoices) as (keyof Appearance)[]) {
        const choice = (appearance as Record<string, unknown>)[key];
        if ((appearanceChoices[key] as readonly unknown[]).includes(choice)) {
          Object.assign(preferences.appearance, { [key]: choice });
        }
      }
    }
    if (Array.isArray(value['recentModels'])) {
      for (const item of value['recentModels'] as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const recent = item as Record<string, unknown>;
        if (!['codex', 'claude-code', 'opencode'].includes(String(recent['provider'])) || typeof recent['model'] !== 'string' || !recent['model'].trim()) continue;
        const model = { provider: recent['provider'] as ProviderId, model: recent['model'] };
        if (!preferences.recentModels.some(previous => previous.provider === model.provider && previous.model === model.model)) preferences.recentModels.push(model);
        if (preferences.recentModels.length === 5) break;
      }
    }
  } catch { /* Preferences are best-effort, like the per-project layout. */ }
  return preferences;
}

function writePreferences(storage: KeyValueStorage | null, preferences: Preferences): void {
  try { storage?.setItem(preferencesKey, JSON.stringify({ version: 1, ...preferences })); } catch { /* Keep the current UI usable without storage. */ }
}

export function saveAppearance(appearance: Appearance, storage: KeyValueStorage | null = browserPreferencesStorage()): void {
  writePreferences(storage, { ...readPreferences(storage), appearance });
}

export function rememberModel(model: RecentModel, storage: KeyValueStorage | null = browserPreferencesStorage()): RecentModel[] {
  const preferences = readPreferences(storage);
  const recentModels = [model, ...preferences.recentModels.filter(item => item.provider !== model.provider || item.model !== model.model)].slice(0, 5);
  writePreferences(storage, { ...preferences, recentModels });
  return recentModels;
}

export function applyAppearance(appearance: Appearance, root: Pick<HTMLElement, 'setAttribute'>): void {
  root.setAttribute('data-theme', appearance.theme);
  root.setAttribute('data-accent', appearance.accent);
  root.setAttribute('data-density', appearance.density);
  root.setAttribute('data-font-size', appearance.fontSize);
}
