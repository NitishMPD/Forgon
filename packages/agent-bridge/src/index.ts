/**
 * `@forgon/agent-bridge` public surface.
 *
 * This package owns the T3 protocol-v2 wire contract and the pure mapping to Forgon's
 * `AgentEvent`/`AgentService` vocabulary. It owns no provider logic, no process lifetime, and no
 * filesystem access: the sidecar manager in `apps/agent-service` supplies those.
 *
 * Consumers should import from the package root, not from individual modules, so an internal
 * file can move without breaking a caller.
 */
export * from './protocol.js';
export * from './errors.js';
export * from './redaction.js';
export * from './rpcFraming.js';
export * from './wsClient.js';
export * from './httpClient.js';
export * from './orchestration.js';
export * from './connection.js';
export * from './commands.js';
export * from './eventMapping.js';
export * from './providers.js';
export * from './permissions.js';
export * from './agentConnection.js';
export * from './agentIpc.js';
