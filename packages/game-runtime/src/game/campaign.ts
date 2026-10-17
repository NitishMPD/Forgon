// Campaign progression, medals and persistence. Engine-free and DOM-free: the shell and the
// mount adapter layer UI on top, so unlock rules and save migration stay headlessly testable.

import type { CampaignCourse, CampaignDocument } from '@forgon/project-schema';

export type Medal = 'gold' | 'silver' | 'bronze';
export const MEDAL_ORDER: readonly Medal[] = ['gold', 'silver', 'bronze'];

export interface CourseProgress {
  /** Fastest completed run in seconds, or null until the course is cleared. */
  bestSeconds: number | null;
  /** Most shards ever collected in one run. */
  bestShards: number;
  bestMedal: Medal | null;
  runs: number;
  completed: boolean;
}
export interface CampaignSettings {
  /** Master gain, 0..1. */
  volume: number;
  /** Look sensitivity multiplier, 0.25..3. */
  sensitivity: number;
  /** Suppress menu motion beyond the OS preference. */
  reducedMotion: boolean;
}
export interface CampaignProgress {
  version: 1;
  campaignId: string;
  courses: Record<string, CourseProgress>;
  settings: CampaignSettings;
  lastPlayedSceneId: string | null;
}
export interface RunOutcome {
  previousBest: number | null;
  bestSeconds: number | null;
  newBest: boolean;
  firstClear: boolean;
  medal: Medal | null;
  /** Scene that became playable because of this run, if any. */
  unlockedSceneId: string | null;
}

export const DEFAULT_SETTINGS: CampaignSettings = { volume: 0.8, sensitivity: 1, reducedMotion: false };

export function emptyCourse(): CourseProgress {
  return { bestSeconds: null, bestShards: 0, bestMedal: null, runs: 0, completed: false };
}
export function createProgress(campaign: CampaignDocument): CampaignProgress {
  const courses: Record<string, CourseProgress> = {};
  for (const course of campaign.courses) courses[course.sceneId] = emptyCourse();
  return { version: 1, campaignId: campaign.campaignId, courses, settings: { ...DEFAULT_SETTINGS }, lastPlayedSceneId: null };
}

export function courseIndex(campaign: CampaignDocument, sceneId: string): number {
  return campaign.courses.findIndex(course => course.sceneId === sceneId);
}
export function courseFor(campaign: CampaignDocument, sceneId: string): CampaignCourse | undefined {
  return campaign.courses.find(course => course.sceneId === sceneId);
}
/** Course 1 is always open; later courses need the previous clear unless the campaign unlocks all. */
export function isCourseUnlocked(campaign: CampaignDocument, progress: CampaignProgress, index: number): boolean {
  if (index <= 0) return true;
  if (campaign.unlock === 'all') return true;
  const previous = campaign.courses[index - 1];
  if (!previous) return false;
  return progress.courses[previous.sceneId]?.completed === true;
}
export function unlockedCount(campaign: CampaignDocument, progress: CampaignProgress): number {
  let count = 0;
  for (let index = 0; index < campaign.courses.length; index++) if (isCourseUnlocked(campaign, progress, index)) count++;
  return count;
}
/** Best completed medal; a faster run always earns the better medal. */
export function medalFor(course: Pick<CampaignCourse, 'goldSeconds' | 'silverSeconds' | 'bronzeSeconds'>, seconds: number): Medal | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds <= course.goldSeconds) return 'gold';
  if (seconds <= course.silverSeconds) return 'silver';
  if (seconds <= course.bronzeSeconds) return 'bronze';
  return null;
}
export function bestMedal(first: Medal | null, second: Medal | null): Medal | null {
  if (!first) return second;
  if (!second) return first;
  return MEDAL_ORDER.indexOf(first) <= MEDAL_ORDER.indexOf(second) ? first : second;
}
/** Award a finished run. Incomplete runs (quit mid-course) record a run but no time or medal. */
export function recordRun(campaign: CampaignDocument, progress: CampaignProgress, sceneId: string, run: { seconds: number; shards: number; completed: boolean }): { progress: CampaignProgress; outcome: RunOutcome } {
  const course = courseFor(campaign, sceneId);
  const previous = progress.courses[sceneId] ?? emptyCourse();
  const outcome: RunOutcome = {
    previousBest: previous.bestSeconds, bestSeconds: previous.bestSeconds, newBest: false,
    firstClear: false, medal: previous.bestMedal, unlockedSceneId: null,
  };
  if (!course) return { progress, outcome };
  const shards = Number.isFinite(run.shards) ? Math.max(0, Math.floor(run.shards)) : 0;
  const seconds = Number.isFinite(run.seconds) && run.seconds > 0 ? run.seconds : Infinity;
  const completed = run.completed && Number.isFinite(seconds);
  const medal = completed ? medalFor(course, seconds) : null;
  const newBest = completed && (previous.bestSeconds === null || seconds < previous.bestSeconds);
  outcome.firstClear = completed && !previous.completed;
  outcome.newBest = newBest;
  outcome.medal = bestMedal(previous.bestMedal, medal);
  outcome.bestSeconds = newBest ? seconds : previous.bestSeconds;
  if (completed) {
    const index = courseIndex(campaign, sceneId);
    const next = campaign.courses[index + 1];
    if (next && outcome.firstClear && campaign.unlock !== 'all' && !isCourseUnlocked(campaign, progress, index + 1)) outcome.unlockedSceneId = next.sceneId;
  }
  const updated: CourseProgress = {
    bestSeconds: outcome.bestSeconds,
    bestShards: Math.max(previous.bestShards, shards),
    bestMedal: outcome.medal,
    runs: previous.runs + 1,
    completed: previous.completed || completed,
  };
  return {
    outcome,
    progress: { ...progress, courses: { ...progress.courses, [sceneId]: updated }, lastPlayedSceneId: sceneId },
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
function finite(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** Tolerant load: unknown versions or corpus damage reset to a fresh save instead of throwing. */
export function migrateProgress(raw: unknown, campaign: CampaignDocument): CampaignProgress {
  const fresh = createProgress(campaign);
  const source = record(raw);
  if (!source || source.version !== 1 || source.campaignId !== campaign.campaignId) return fresh;
  const settings = record(source.settings);
  if (settings) {
    fresh.settings = {
      volume: clamp(finite(settings.volume, DEFAULT_SETTINGS.volume), 0, 1),
      sensitivity: clamp(finite(settings.sensitivity, DEFAULT_SETTINGS.sensitivity), 0.25, 3),
      reducedMotion: settings.reducedMotion === true,
    };
  }
  const courses = record(source.courses);
  if (courses) {
    for (const course of campaign.courses) {
      const saved = record(courses[course.sceneId]);
      if (!saved) continue;
      const bestSeconds = typeof saved.bestSeconds === 'number' && Number.isFinite(saved.bestSeconds) && saved.bestSeconds > 0 ? saved.bestSeconds : null;
      fresh.courses[course.sceneId] = {
        bestSeconds,
        bestShards: Math.max(0, Math.floor(finite(saved.bestShards, 0))),
        bestMedal: bestSeconds === null ? null : medalFor(course, bestSeconds),
        runs: Math.max(0, Math.floor(finite(saved.runs, 0))),
        completed: bestSeconds !== null,
      };
    }
  }
  const last = source.lastPlayedSceneId;
  fresh.lastPlayedSceneId = typeof last === 'string' && campaign.courses.some(course => course.sceneId === last) ? last : null;
  return fresh;
}

export interface CampaignStorage {
  read(key: string): string | null;
  /** False when the host refused the write (quota, private mode); the game keeps playing in memory. */
  write(key: string, value: string): boolean;
  remove(key: string): void;
}
export function createMemoryStorage(initial: Record<string, string> = {}): CampaignStorage {
  const values = new Map(Object.entries(initial));
  return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); return true; }, remove: key => { values.delete(key); } };
}
export function createBrowserStorage(): CampaignStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = 'forgon.campaign.probe';
    localStorage.setItem(probe, '1'); localStorage.removeItem(probe);
    return {
      read: key => { try { return localStorage.getItem(key); } catch { return null; } },
      write: (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } },
      remove: key => { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
    };
  } catch { return null; }
}
export function saveKey(campaign: CampaignDocument): string { return `forgon.campaign.${campaign.campaignId}.v1`; }
export function loadProgress(campaign: CampaignDocument, storage: CampaignStorage | null): CampaignProgress {
  if (!storage) return createProgress(campaign);
  try {
    const raw = storage.read(saveKey(campaign));
    return raw === null ? createProgress(campaign) : migrateProgress(JSON.parse(raw), campaign);
  } catch { return createProgress(campaign); }
}
export function persistProgress(campaign: CampaignDocument, progress: CampaignProgress, storage: CampaignStorage | null): boolean {
  if (!storage) return false;
  try { return storage.write(saveKey(campaign), JSON.stringify(progress)); } catch { return false; }
}

/** UI formatting: 0:07.42 style times. */
export function formatSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}
export function totalMedals(campaign: CampaignDocument, progress: CampaignProgress): number {
  let count = 0;
  for (const course of campaign.courses) if (progress.courses[course.sceneId]?.bestMedal) count++;
  return count;
}
