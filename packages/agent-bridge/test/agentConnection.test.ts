import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentConnection,
  permissionModesForConnection,
  type AgentProviderInfo,
} from '../src/index.js';
import type { AgentEvent, AgentRunRequest, AgentService } from '@forgon/project-schema';

const stubService: AgentService = {
  start: (_request: AgentRunRequest) => Promise.resolve({ runId: 'r' }),
  cancel: (_runId: string) => Promise.resolve(),
  approve: (_runId: string, _requestId: string, _allow: boolean) => Promise.resolve(),
  subscribe: (_listener: (event: AgentEvent) => void) => () => undefined,
};

const providerInfo: AgentProviderInfo = {
  id: 'codex',
  name: 'Codex',
  readiness: 'ready',
  models: ['gpt-5'],
  permissionModes: ['supervised', 'auto-edits', 'full-local'],
};

test('permissionModesForConnection excludes inspect unless Forgon enforces it', () => {
  assert.deepEqual(permissionModesForConnection(), ['supervised', 'auto-edits', 'full-local']);
  assert.deepEqual(permissionModesForConnection({ forgonEnforcesInspect: false }), [
    'supervised',
    'auto-edits',
    'full-local',
  ]);
  assert.deepEqual(permissionModesForConnection({ forgonEnforcesInspect: true }), [
    'inspect',
    'supervised',
    'auto-edits',
    'full-local',
  ]);
});

test('createAgentConnection carries the service and provider snapshot', () => {
  const connection = createAgentConnection({ service: stubService, providers: [providerInfo] });
  assert.equal(connection.service, stubService);
  assert.deepEqual(connection.providers, [providerInfo]);
  assert.equal(connection.refreshProviders, undefined);
});

test('createAgentConnection includes refreshProviders only when supplied', async () => {
  const refreshed: AgentProviderInfo[] = [{ ...providerInfo, models: ['gpt-5', 'gpt-5-mini'] }];
  const connection = createAgentConnection({
    service: stubService,
    providers: [providerInfo],
    refreshProviders: () => Promise.resolve(refreshed),
  });
  assert.ok(connection.refreshProviders !== undefined);
  assert.deepEqual(await connection.refreshProviders(), refreshed);
});

test('an unavailable provider reports not-ready with a reason', () => {
  const info: AgentProviderInfo = {
    id: 'claude-code',
    name: 'Claude Code',
    readiness: 'not-ready',
    message: 'Sign in to Claude Code to use it.',
    models: [],
    permissionModes: ['supervised', 'auto-edits', 'full-local'],
  };
  assert.equal(info.readiness, 'not-ready');
  assert.ok(info.message !== undefined);
});
