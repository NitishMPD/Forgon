import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntity } from '@forgon/project-schema';
import { SceneSession } from '@forgon/editor-ui';
// Node-only integration harness: renderer entrypoints never import filesystem adapters.
import { createProject, openProject } from '../../../packages/project-io/src/index.js';

async function ready(session: SceneSession): Promise<void> {
  if (session.phase === 'loading') await new Promise<void>(resolve => {
    const stop = session.subscribe(() => { if (session.phase !== 'loading') { stop(); resolve(); } });
  });
  assert.equal(session.phase, 'ready', session.failure ?? 'load failed');
}

test('real IO persists enabled/property overrides and retains rejected generated structural edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgon-studio-'));
  const root = join(directory, 'hotel');
  let project = await createProject(root, 'hotel');
  const path = project.manifest.scenes[0]!.path;
  const session = SceneSession.open({ io: project.sceneIO, path, context: { assets: project.assets, prefabs: project.prefabs }, log() {} });
  try {
    await ready(session);
    const entity = session.store!.scene.entities.find(item => item.components.some(component => component.type === 'render'))!;
    const component = entity.components.find(item => item.type === 'render')!;
    assert.equal(session.execute({ type: 'enabled', entityId: entity.id, enabled: false }), true);
    assert.equal(session.execute({ type: 'component', entityId: entity.id, component: { ...component, properties: { ...component.properties, color: [0.2, 0.3, 0.4] } } }), true);
    assert.equal(await session.save(), true);
    session.dispose(); project.close();
    project = await openProject(root);
    const saved = await project.sceneIO.readScene(path);
    const reopened = saved.document.entities.find(item => item.id === entity.id)!;
    assert.equal(reopened.enabled, false);
    assert.deepEqual(reopened.components.find(item => item.id === component.id)!.properties.color, [0.2, 0.3, 0.4]);
    const next = SceneSession.open({ io: project.sceneIO, path, context: { assets: project.assets, prefabs: project.prefabs }, log() {} });
    try {
      await ready(next);
      next.execute({ type: 'create', entity: createEntity('Unsaved structural addition') });
      assert.equal(await next.save(), false);
      assert.equal(next.dirty, true);
      assert.match(next.saveError!, /Your edits are still here/);
      assert.ok(next.store!.scene.entities.some(item => item.name === 'Unsaved structural addition'));
      assert.deepEqual((await project.sceneIO.readScene(path)).document, saved.document);
    } finally { next.dispose(); }
  } finally {
    session.dispose(); project.close();
    const resolved = join(tmpdir(), directory.split(/[\\/]/).at(-1)!);
    assert.equal(directory, resolved);
    await rm(directory, { recursive: true, force: true });
  }
});
