/**
 * The external agent configuration descriptor.
 *
 * A native host (the desktop bridge) reads one trusted JSON file — named by `FORGON_T3_CONFIG`,
 * which only the launch environment can set — and gets back the two values `startAgentService`
 * needs: the loopback `port` and the pinned `artifact`. Renderer code and project files can never
 * reach this file, so the descriptor is the single, auditable place where a Forgon install is
 * pointed at a specific T3 build.
 *
 * The shape mirrors `T3Artifact` exactly (see `artifact.ts`); this module only *shapes and
 * bounds* the input. Byte-level provenance — that the files match their digests and that the
 * running server reports the pinned version — stays in `verifyArtifact`/`assertServerVersion`, so
 * there is exactly one verification implementation.
 *
 * Every rejection is an `AgentBridgeError` with code `invalid_configuration` and a `detail` naming
 * the offending field, so a misconfigured install is diagnosable from the error alone.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentBridgeError } from '@forgon/agent-bridge';
import type { T3Artifact } from './artifact.js';

/**
 * Upper bound on the descriptor file. The real file is a few kilobytes; 256 kB leaves room for a
 * full 18-chunk `bundle` manifest while refusing a pathologically large "config" outright.
 */
export const AGENT_SERVICE_CONFIG_MAX_BYTES = 256 * 1024;

export interface AgentServiceConfig {
  /** Loopback port for the isolated server. `startAgentService` re-binds nothing; it uses this. */
  readonly port: number;
  /** The pinned artifact, verified later by `verifyArtifact`. */
  readonly artifact: T3Artifact;
}

const digestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex SHA-256');

const artifactFileSchema = z
  .object({
    path: z.string().min(1, 'must be a non-empty relative path'),
    sha256: digestSchema,
  })
  .strict();

const artifactSchema = z
  .object({
    entryPath: z.string().min(1, 'must be a non-empty absolute path'),
    expectedSha256: digestSchema,
    expectedServerVersion: z.string().min(1).optional(),
    kind: z.enum(['node-script', 'executable']).optional(),
    bundle: z.array(artifactFileSchema).min(1, 'a bundle manifest must list at least one file').optional(),
  })
  .strict();

const configSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    artifact: artifactSchema,
  })
  .strict();

const configFailure = (detail: string): AgentBridgeError =>
  new AgentBridgeError('invalid_configuration', 'The isolated T3 agent configuration is invalid.', {
    detail,
  });

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');

/**
 * Validate an already-parsed descriptor. The `artifact.entryPath` must be absolute here because
 * this is the last point before the value is handed to a spawn command; `verifyArtifact` would
 * reject it too, but failing in the parser keeps the message about the *file*, not the filesystem.
 */
export const parseAgentServiceConfig = (value: unknown): AgentServiceConfig => {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw configFailure(describeIssues(parsed.error));
  const artifact = parsed.data.artifact;
  if (!path.isAbsolute(artifact.entryPath)) {
    throw configFailure(`artifact.entryPath must be absolute, got "${artifact.entryPath}"`);
  }
  return { port: parsed.data.port, artifact: artifact as T3Artifact };
};

/** Injectable file reader so loading is testable without a real descriptor on disk. */
export interface ConfigIo {
  readonly read: (filePath: string) => Promise<Uint8Array>;
}

export const defaultConfigIo: ConfigIo = {
  read: async (filePath) => new Uint8Array(await readFile(filePath)),
};

/**
 * Read and validate the descriptor at an absolute path. The path check comes first: a relative
 * config path would resolve against the child's cwd, which is the isolated home, so it is refused
 * rather than guessed.
 */
export const loadAgentServiceConfig = async (
  filePath: string,
  io: ConfigIo = defaultConfigIo,
): Promise<AgentServiceConfig> => {
  if (!path.isAbsolute(filePath)) {
    throw configFailure(`The configuration path must be absolute, got "${filePath}"`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await io.read(filePath);
  } catch (cause) {
    throw configFailure(
      `The configuration file "${filePath}" could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (bytes.byteLength > AGENT_SERVICE_CONFIG_MAX_BYTES) {
    throw configFailure(
      `The configuration file is ${bytes.byteLength} bytes, over the ${AGENT_SERVICE_CONFIG_MAX_BYTES}-byte limit`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw configFailure(
      `The configuration file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parseAgentServiceConfig(value);
};
