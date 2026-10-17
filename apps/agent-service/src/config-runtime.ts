/**
 * Node-runtime compatibility for the pinned T3 server.
 *
 * The `t3` package declares `engines.node` `^22.16 || ^23.11 || >=24.10`, and the upstream monorepo
 * root declares `^24.13.1`. A Forgon host on an older Node (this machine runs `v24.2.0`) can build
 * the bridge and all its tests, but it cannot *run* the pinned server. That distinction matters:
 * the failure otherwise surfaces as an opaque child-process crash rather than "your runtime is too
 * old".
 *
 * This module is pure (no `node:*` beyond nothing) so both the sidecar preflight and a desktop
 * bridge can call it: `startSidecar` uses it to refuse an incompatible runtime before spawning, and
 * a host can call `assertCompatibleT3Node(process.versions.node)` at startup for an even earlier
 * message.
 */
import { AgentBridgeError } from '@forgon/agent-bridge';

/** The pinned `t3` package's `engines.node` range (`apps/server/package.json` at the audit rev). */
export const T3_NODE_RANGE = '^22.16 || ^23.11 || >=24.10';

interface ParsedNodeVersion {
  readonly major: number;
  readonly minor: number;
}

const parseNodeVersion = (version: string): ParsedNodeVersion | undefined => {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
};

/**
 * True when `version` (e.g. `24.13.1`, optionally `v`-prefixed) satisfies `T3_NODE_RANGE`.
 *
 * The range is small enough to evaluate exactly: `^22.16` and `^23.11` are minor-bounded, and
 * `>=24.10` is open above. An unparseable version is `false` — never assume compatible.
 */
export const satisfiesT3Node = (version: string): boolean => {
  const parsed = parseNodeVersion(version);
  if (parsed === undefined) return false;
  const { major, minor } = parsed;
  if (major === 22) return minor >= 16;
  if (major === 23) return minor >= 11;
  if (major >= 24) return major > 24 || minor >= 10;
  return false;
};

export const describeT3NodeRequirement = (): string =>
  `The pinned T3 server runs on Node ${T3_NODE_RANGE}.`;

/**
 * Refuse a runtime the pinned server cannot start on. The message names both the observed version
 * and the range, so a bundle that copied the wrong Node is diagnosable from the error alone.
 */
export const assertCompatibleT3Node = (version: string, runtimePath?: string): void => {
  if (satisfiesT3Node(version)) return;
  const where = runtimePath === undefined ? 'The configured Node runtime' : `The Node runtime "${runtimePath}"`;
  throw new AgentBridgeError(
    'sidecar_unavailable',
    'The Node runtime that would run the pinned T3 server does not satisfy its engine requirement.',
    {
      detail: `${where} reports ${version}, which does not satisfy ${T3_NODE_RANGE}; T3 will not start. Use a Node in that range (the audited revision was built and runs under Node 24.13.1).`,
    },
  );
};
