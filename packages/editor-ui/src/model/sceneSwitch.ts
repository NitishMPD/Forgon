// Decides what a scene switch needs. Unsaved work is never dropped without asking, and an open
// file conflict blocks switching until the user chooses which version to keep.
export type SceneSwitchPlan =
  | { action: 'none' }
  | { action: 'switch' }
  | { action: 'confirm' }
  | { action: 'blocked'; reason: string };

export interface SceneSwitchInput {
  current: string | null;
  target: string;
  dirty: boolean;
  conflict: boolean;
}

export function planSceneSwitch(input: SceneSwitchInput): SceneSwitchPlan {
  if (input.target === input.current) return { action: 'none' };
  if (input.conflict) return { action: 'blocked', reason: 'Resolve the file conflict before switching scenes.' };
  if (input.dirty) return { action: 'confirm' };
  return { action: 'switch' };
}
