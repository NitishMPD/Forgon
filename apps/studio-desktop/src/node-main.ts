import { createDesktopBridge } from './bridge.js';
import { MAX_FRAME, VERSION, parseRequest } from './protocol.js';
import { loadAgentServiceConfig, redactSecrets, startAgentService } from '@forgon/agent-service';
import { join } from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('Native app data directory required');
// Rust assigns the process to its kill-on-close job before writing the first request.
await new Promise<void>(resolve => process.stdin.once('readable', resolve));
function send(value: unknown) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('Desktop response exceeds frame limit');
  if (process.stdout.writableLength > 2 * MAX_FRAME) { void shutdown(); return; }
  process.stdout.write(`${line}\n`);
}
const bridge = await createDesktopBridge({ dataDir, agentMessage: process.env.FORGON_T3_CONFIG ? 'Agent service is starting. Check again shortly.' : 'No isolated, verified T3 artifact configured. Project editing is available.', emit: event => send({ v: VERSION, event }) });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await bridge.close(); process.exit(0);
}
process.stdin.on('end', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
let buffer = Buffer.alloc(0), pending = 0;
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  let newline: number;
  while ((newline = buffer.indexOf(10)) !== -1) {
    const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
    if (line.length > MAX_FRAME || pending >= 64) { void shutdown(); return; }
    let envelope: { request: unknown; native?: boolean };
    try { envelope = JSON.parse(line.toString('utf8')); parseRequest(envelope.request); }
    catch { void shutdown(); return; }
    const request = parseRequest(envelope.request); pending++;
    void bridge.dispatch(request, envelope.native === true).then(
      result => send({ v: VERSION, id: request.id, result: result ?? null }),
      error => send({ v: VERSION, id: request.id, error: { code: typeof error?.code === 'string' ? error.code : 'DESKTOP_ERROR', message: request.method.startsWith('agent:') ? 'Agent request failed. Check provider readiness and isolated service configuration.' : error instanceof Error ? error.message : 'Desktop request failed' } }),
    ).finally(() => { pending--; });
  }
  if (buffer.length > MAX_FRAME) void shutdown();
});

// Project requests must remain available while the independent agent service starts.
if (process.env.FORGON_T3_CONFIG) {
  void (async () => {
    try {
      const config = await loadAgentServiceConfig(process.env.FORGON_T3_CONFIG!);
      const agent = await startAgentService({
        artifact: config.artifact,
        homeDir: join(dataDir, 'agent-home'), port: config.port,
        nodePath: process.execPath,
        resumeOnStart: false,
      });
      await bridge.attachAgent(agent);
    } catch (cause) {
      // The renderer only gets the fixed message; the real reason goes to the host terminal so a failed start is diagnosable.
      const detail = cause instanceof Error ? `${cause.message}${'detail' in cause && typeof cause.detail === 'string' ? `: ${cause.detail}` : ''}` : String(cause);
      process.stderr.write(`[forgon] agent service failed to start: ${redactSecrets(detail)}
`);
      bridge.setAgentMessage('Configured isolated T3 service could not start. Verify artifact, Node version and port configuration.');
    }
  })();
}
