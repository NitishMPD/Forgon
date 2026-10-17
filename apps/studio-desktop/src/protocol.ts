export const VERSION = 1;
// 32 MiB assets expand to base64; JSON documents are bounded again by project-io.
export const MAX_FRAME = 48 * 1024 * 1024;
export interface Request { v: 1; id: string; method: string; args: Record<string, unknown> }
export interface BridgeEvent { kind: 'scene' | 'agent' | 'providers' | 'closed'; session?: string; watch?: string; value: unknown }
export interface Transport {
  request<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0')) throw new Error(`Invalid ${label}`);
  return value;
}
export function parseRequest(value: unknown): Request {
  if (!value || typeof value !== 'object') throw new Error('Invalid request');
  const r = value as Partial<Request>;
  if (r.v !== VERSION || !r.args || typeof r.args !== 'object' || Array.isArray(r.args)) throw new Error('Unsupported protocol or arguments');
  return { v: VERSION, id: string(r.id, 'request id'), method: string(r.method, 'method'), args: r.args };
}
