/**
 * Isolated state directory for the Forgon-owned T3 sidecar.
 *
 * T3 keeps its database, provider auth and session state under a base directory. The developer's
 * live install is `~/.t3` (upstream: "T3 home"), and both upstream's own agent rules and Forgon's
 * build brief forbid starting a server against it or copying its credentials. This module makes
 * that a hard refusal: a candidate home that is the live home, contains it, or is contained by it
 * is rejected before any process is spawned.
 *
 * Forgon never copies `~/.t3` contents into the isolated home. A fresh directory means the sidecar
 * starts with no provider credentials of its own, which is the intended posture: provider auth is
 * the sidecar's own concern and Forgon reports a missing login as unavailable rather than
 * transplanting the user's private credentials.
 */
import os from 'node:os';
import path from 'node:path';
import { AgentBridgeError } from '@forgon/agent-bridge';

/** The developer's live T3 home; matches upstream's `~/.t3` default. */
export const defaultLiveHomeDir = (): string => path.join(os.homedir(), '.t3');

const normalize = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** True when `child` is a strict descendant of `parent` (not equal). */
export const isStrictlyInside = (parent: string, child: string): boolean => {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const containmentFailure = (detail: string): AgentBridgeError =>
  new AgentBridgeError(
    'containment_violation',
    'The T3 sidecar state directory must be isolated from the developer\'s live T3 install.',
    { detail },
  );

export interface IsolatedHome {
  /** Absolute, resolved isolated home directory. */
  readonly homeDir: string;
  /** The live T3 home this was checked against. */
  readonly liveHomeDir: string;
}

/**
 * Validate that `homeDir` is an isolated directory, safe to hand to a spawned sidecar.
 *
 * Rejects: a relative path, the live home itself, a directory inside the live home, and a
 * directory that contains the live home (writing there could still reach it). Callers that need
 * a specific layout pass the parent directory, not the live one.
 */
export const assertIsolatedHome = (input: {
  readonly homeDir: string;
  readonly liveHomeDir?: string;
}): IsolatedHome => {
  if (!path.isAbsolute(input.homeDir)) {
    throw containmentFailure(`homeDir must be an absolute path, got "${input.homeDir}".`);
  }
  const homeDir = path.resolve(input.homeDir);
  const liveHomeDir = path.resolve(input.liveHomeDir ?? defaultLiveHomeDir());

  if (normalize(homeDir) === normalize(liveHomeDir)) {
    throw containmentFailure('homeDir is the live T3 home; the sidecar would share the developer\'s database.');
  }
  if (isStrictlyInside(liveHomeDir, homeDir)) {
    throw containmentFailure(`homeDir "${homeDir}" is inside the live T3 home "${liveHomeDir}".`);
  }
  if (isStrictlyInside(homeDir, liveHomeDir)) {
    throw containmentFailure(`homeDir "${homeDir}" contains the live T3 home "${liveHomeDir}".`);
  }
  if (homeDir === path.parse(homeDir).root) {
    throw containmentFailure('homeDir must not be a filesystem root.');
  }

  return { homeDir, liveHomeDir };
};
