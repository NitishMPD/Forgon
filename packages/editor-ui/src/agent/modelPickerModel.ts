import type { ProviderId } from '@forgon/project-schema';
import type { AgentProviderInfo } from '../services.js';
import type { RecentModel } from '../model/preferences.js';

export interface ModelOption { key: string; provider: ProviderId; model: string | null; label: string; vendor: string; group: string }
export const modelRenderCap = 100;

export function modelLabel(model: string | null, provider: ProviderId): { label: string; vendor: string } {
  if (model === null) return { label: 'Default model', vendor: '' };
  const slash = provider === 'opencode' ? model.indexOf('/') : -1;
  return { label: (slash < 0 ? model : model.slice(slash + 1)).replace(/[-_]/g, ' ').replace(/\b(gpt|claude|opus|sonnet|haiku|sol)\b/gi, word => word.toLowerCase() === 'gpt' ? 'GPT' : word[0]!.toUpperCase() + word.slice(1)), vendor: slash < 0 ? '' : model.slice(0, slash) };
}

export function matchesModel(model: string, query: string): boolean {
  const normalized = model.toLocaleLowerCase().replace(/[-_/]/g, ' ');
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => model.toLocaleLowerCase().includes(word) || normalized.includes(word));
}

export function modelOptions(providers: readonly AgentProviderInfo[], recent: readonly RecentModel[], query: string): { options: ModelOption[]; remaining: number } {
  const all: ModelOption[] = [];
  const used = new Set<string>();
  const add = (provider: AgentProviderInfo, model: string | null, group: string): void => {
    const key = JSON.stringify([provider.id, model]);
    const display = modelLabel(model, provider.id);
    if (used.has(key) || !matchesModel(`${provider.name} ${model ?? 'Default model'} ${display.label}`, query)) return;
    used.add(key);
    all.push({ key, provider: provider.id, model, ...display, group });
  };
  for (const item of recent) {
    const provider = providers.find(provider => provider.id === item.provider && provider.models.includes(item.model));
    if (provider) add(provider, item.model, 'Recent');
  }
  for (const provider of providers) {
    add(provider, null, provider.name);
    const groups = new Map<string, string[]>();
    for (const model of provider.models) {
      const vendor = modelLabel(model, provider.id).vendor;
      const group = vendor ? `${provider.name} / ${vendor}` : provider.name;
      const models = groups.get(group) ?? [];
      models.push(model);
      groups.set(group, models);
    }
    for (const [group, models] of groups) for (const model of models) add(provider, model, group);
  }
  // shortcut: cap the rendered matches; add windowing only if browsing without search becomes necessary.
  return { options: all.slice(0, modelRenderCap), remaining: Math.max(0, all.length - modelRenderCap) };
}
