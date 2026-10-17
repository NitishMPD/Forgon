/**
 * Redaction for anything the bridge logs or surfaces as an `AgentEvent`.
 *
 * `contracts.md` requires "No secrets in events". T3 credentials travel as bearer
 * tokens, one-time bootstrap tokens, and short-lived `wsTicket` query values, so
 * every free-form string that can reach a log or an event passes through here.
 */

/** Named values that are always secret regardless of length or context. */
const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'ticket',
  'wsTicket',
  'desktopBootstrapToken',
  'desktopBootstrapSecret',
  'subject_token',
  'authorization',
  'password',
  'secret',
  'apiKey',
  'api_key',
];

const REDACTED = '[redacted]';

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keyPattern = new RegExp(
  `("?\\b(?:${SECRET_KEYS.map(escapeForRegExp).join('|')})\\b"?\\s*[:=]\\s*)("([^"]*)"|'([^']*)'|[^\\s,;&]+)`,
  'gi',
);

const jwtPattern = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const bearerPattern = /\b(Bearer|DPoP)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const querySecretPattern = /([?&](?:wsTicket|token|access_token)=)[^&\s"']+/gi;

/**
 * Replace known secret values and shapes with `[redacted]`.
 *
 * This is a defense-in-depth filter, not an authorization boundary: the bridge
 * still never stores tokens on objects that flow into events.
 */
export const redactSecrets = (input: string): string =>
  input
    // Query secrets are redacted first, without quotes: `?wsTicket=abc` stays a usable URL.
    .replace(querySecretPattern, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(keyPattern, (match, prefix: string, value: string) => {
      const core = value.replace(/^["']|["']$/g, '');
      return core === REDACTED ? match : `${prefix}"${REDACTED}"`;
    })
    .replace(jwtPattern, REDACTED)
    .replace(bearerPattern, (_match, scheme: string) => `${scheme} ${REDACTED}`);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deep-redact a value for logging. Strings are scrubbed; objects with a secret
 * key are replaced wholesale so the value never reaches a formatter.
 */
export const redactValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEYS.some((secret) => secret.toLowerCase() === key.toLowerCase())
      ? REDACTED
      : redactValue(entry);
  }
  return out;
};

/** True when a string still appears to carry a credential. Used by tests and guards. */
export const containsLikelySecret = (input: string): boolean => redactSecrets(input) !== input;

export { SECRET_KEYS, REDACTED };
