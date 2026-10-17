// Modular dock: four tab groups in two columns. Every panel is a tab that can move between groups,
// close and reopen. Split positions are fractions of the dock area (design.md layout rules).

export const panelIds = ['viewport', 'game', 'hierarchy', 'inspector', 'composer', 'agents', 'project', 'console', 'review'] as const;
export type PanelId = (typeof panelIds)[number];

export const groupIds = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
export type GroupId = (typeof groupIds)[number];

export interface PanelGroup {
  tabs: PanelId[];
  active: PanelId | null;
}

export interface LayoutState {
  version: 2;
  // Left column width, and the top group height in each column, as fractions.
  columns: number;
  leftRows: number;
  rightRows: number;
  groups: Record<GroupId, PanelGroup>;
}

export const splitLimits = [0.15, 0.85] as const;

export const defaultLayout: LayoutState = {
  version: 2,
  columns: 0.65,
  leftRows: 0.64,
  rightRows: 0.6,
  groups: {
    topLeft: { tabs: ['viewport', 'game'], active: 'viewport' },
    topRight: { tabs: ['hierarchy', 'inspector'], active: 'hierarchy' },
    bottomLeft: { tabs: ['composer', 'agents'], active: 'composer' },
    bottomRight: { tabs: ['project', 'console', 'review'], active: 'project' },
  },
};

// Where a closed panel reopens when it is shown by a shortcut or command.
export const homeGroup: Record<PanelId, GroupId> = {
  viewport: 'topLeft',
  game: 'topLeft',
  hierarchy: 'topRight',
  inspector: 'topRight',
  composer: 'bottomLeft',
  agents: 'bottomLeft',
  project: 'bottomRight',
  console: 'bottomRight',
  review: 'bottomRight',
};

export interface LayoutRead {
  layout: LayoutState;
  recovered: boolean;
}

function isPanel(value: unknown): value is PanelId {
  return typeof value === 'string' && (panelIds as readonly string[]).includes(value);
}

function fraction(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(splitLimits[1], Math.max(splitLimits[0], value));
}

// Corrupt, older or unknown layouts fall back to defaults. Fractions are clamped, unknown and
// duplicate panels are dropped, and an active tab must be one of the group's tabs.
export function parseLayout(input: unknown): LayoutRead {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { layout: defaultLayout, recovered: true };
  const record = input as Record<string, unknown>;
  const groups = record['groups'];
  if (record['version'] !== 2 || typeof groups !== 'object' || groups === null || Array.isArray(groups)) {
    return { layout: defaultLayout, recovered: true };
  }
  const seen = new Set<PanelId>();
  const parsed = {} as Record<GroupId, PanelGroup>;
  for (const id of groupIds) {
    const raw = (groups as Record<string, unknown>)[id];
    const rawTabs = typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['tabs'])
      ? (raw as Record<string, unknown>)['tabs'] as unknown[]
      : [];
    const tabs = rawTabs.filter(isPanel).filter(panel => !seen.has(panel) && seen.add(panel) !== undefined);
    const active = (raw as Record<string, unknown> | null)?.['active'];
    parsed[id] = { tabs, active: isPanel(active) && tabs.includes(active) ? active : tabs[0] ?? null };
  }
  return {
    layout: {
      version: 2,
      columns: fraction(record['columns'], defaultLayout.columns),
      leftRows: fraction(record['leftRows'], defaultLayout.leftRows),
      rightRows: fraction(record['rightRows'], defaultLayout.rightRows),
      groups: parsed,
    },
    recovered: false,
  };
}

export function groupOf(layout: LayoutState, panel: PanelId): GroupId | null {
  return groupIds.find(id => layout.groups[id].tabs.includes(panel)) ?? null;
}

export function isPanelVisible(layout: LayoutState, panel: PanelId): boolean {
  const group = groupOf(layout, panel);
  return group !== null && layout.groups[group].active === panel;
}

function withoutPanel(group: PanelGroup, panel: PanelId): PanelGroup {
  const index = group.tabs.indexOf(panel);
  if (index < 0) return group;
  const tabs = group.tabs.filter(item => item !== panel);
  // Closing the active tab activates its neighbour, like a browser tab strip.
  const active = group.active === panel ? tabs[Math.min(index, tabs.length - 1)] ?? null : group.active;
  return { tabs, active };
}

// Moves a panel (open or closed) into `to`, before `before` when given, and makes it active there.
export function movePanel(layout: LayoutState, panel: PanelId, to: GroupId, before: PanelId | null = null): LayoutState {
  const groups = { ...layout.groups };
  for (const id of groupIds) groups[id] = withoutPanel(groups[id], panel);
  const tabs = [...groups[to].tabs];
  const index = before === null || before === panel ? -1 : tabs.indexOf(before);
  tabs.splice(index < 0 ? tabs.length : index, 0, panel);
  groups[to] = { tabs, active: panel };
  return { ...layout, groups };
}

export function closePanel(layout: LayoutState, panel: PanelId): LayoutState {
  const group = groupOf(layout, panel);
  if (group === null) return layout;
  return { ...layout, groups: { ...layout.groups, [group]: withoutPanel(layout.groups[group], panel) } };
}

export function activatePanel(layout: LayoutState, panel: PanelId): LayoutState {
  const group = groupOf(layout, panel);
  if (group === null || layout.groups[group].active === panel) return layout;
  return { ...layout, groups: { ...layout.groups, [group]: { ...layout.groups[group], active: panel } } };
}

// Brings a panel to the front, reopening a closed panel in its home group.
export function showPanel(layout: LayoutState, panel: PanelId): LayoutState {
  return groupOf(layout, panel) === null ? movePanel(layout, panel, homeGroup[panel]) : activatePanel(layout, panel);
}

const neighbours: Record<GroupId, Partial<Record<string, GroupId>>> = {
  topLeft: { ArrowRight: 'topRight', ArrowDown: 'bottomLeft' },
  topRight: { ArrowLeft: 'topLeft', ArrowDown: 'bottomRight' },
  bottomLeft: { ArrowRight: 'bottomRight', ArrowUp: 'topLeft' },
  bottomRight: { ArrowLeft: 'bottomLeft', ArrowUp: 'topRight' },
};

export function neighbourGroup(group: GroupId, key: string): GroupId | null {
  return neighbours[group][key] ?? null;
}

// Group under a point, given as fractions of the dock area.
export function groupAt(layout: LayoutState, x: number, y: number): GroupId {
  if (x < layout.columns) return y < layout.leftRows ? 'topLeft' : 'bottomLeft';
  return y < layout.rightRows ? 'topRight' : 'bottomRight';
}

export const splitStep = 0.02;
export const splitLargeStep = 0.08;

// Keyboard resizing for a split separator. Arrow keys move the split; Shift moves further.
// Returns null for keys the separator ignores.
export function keyboardSplit(current: number, key: string, modifiers: { shiftKey: boolean }): number | null {
  const step = modifiers.shiftKey ? splitLargeStep : splitStep;
  const clamp = (value: number): number => Math.round(Math.min(splitLimits[1], Math.max(splitLimits[0], value)) * 1000) / 1000;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return clamp(current + step);
    case 'ArrowLeft':
    case 'ArrowUp':
      return clamp(current - step);
    case 'Home':
      return splitLimits[0];
    case 'End':
      return splitLimits[1];
    default:
      return null;
  }
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
