export type DockMode = 'bottom' | 'right' | 'fullscreen';

export interface LayoutState {
  hierarchyWidth: number;
  hierarchyCollapsed: boolean;
  inspectorWidth: number;
  dockMode: DockMode;
  dockHeight: number;
  dockWidth: number;
}

export const layoutLimits = {
  hierarchyWidth: [200, 360],
  inspectorWidth: [288, 400],
  dockHeight: [160, 480],
  dockWidth: [280, 520],
} as const;

export const defaultLayout: LayoutState = {
  hierarchyWidth: 264,
  hierarchyCollapsed: false,
  inspectorWidth: 320,
  dockMode: 'bottom',
  dockHeight: 240,
  dockWidth: 360,
};

export interface LayoutRead {
  layout: LayoutState;
  recovered: boolean;
}

const dockModes: readonly DockMode[] = ['bottom', 'right', 'fullscreen'];

function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Corrupt or unknown layouts fall back to defaults. Numeric values are clamped to limits.
export function parseLayout(input: unknown): LayoutRead {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { layout: defaultLayout, recovered: true };
  }
  const record = input as Record<string, unknown>;
  const dockMode = dockModes.find(mode => mode === record['dockMode']);
  const layout: LayoutState = {
    hierarchyWidth: clamp(record['hierarchyWidth'], layoutLimits.hierarchyWidth, defaultLayout.hierarchyWidth),
    hierarchyCollapsed: record['hierarchyCollapsed'] === true,
    inspectorWidth: clamp(record['inspectorWidth'], layoutLimits.inspectorWidth, defaultLayout.inspectorWidth),
    dockMode: dockMode ?? defaultLayout.dockMode,
    dockHeight: clamp(record['dockHeight'], layoutLimits.dockHeight, defaultLayout.dockHeight),
    dockWidth: clamp(record['dockWidth'], layoutLimits.dockWidth, defaultLayout.dockWidth),
  };
  return { layout, recovered: dockMode === undefined };
}

// Below this window width the right dock shares the inspector column as tabs (design.md layout rules).
export const sharedRightDockBelow = 1680;

export function rightDockSharesInspector(windowWidth: number): boolean {
  return windowWidth < sharedRightDockBelow;
}

export const resizeStep = 8;
export const resizeLargeStep = 32;

// Keyboard resizing for a separator. `direction` matches the pointer rule: +1 when moving the
// edge in the positive direction grows the panel. Returns null for keys the separator ignores.
export function keyboardResize(
  current: number,
  key: string,
  modifiers: { shiftKey: boolean },
  direction: 1 | -1,
  [min, max]: readonly [number, number],
): number | null {
  const step = modifiers.shiftKey ? resizeLargeStep : resizeStep;
  const clamp = (value: number): number => Math.min(max, Math.max(min, Math.round(value)));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return clamp(current + step * direction);
    case 'ArrowLeft':
    case 'ArrowUp':
      return clamp(current - step * direction);
    case 'Home':
      return min;
    case 'End':
      return max;
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
