import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEntity, createScene, parseScriptProps, type JsonValue } from '@forgon/project-schema';
import { Inspector, ScriptFields } from '../src/panels/inspector/Inspector.js';
import { SceneSession } from '../src/session/sceneSession.js';
import { selectOne } from '../src/model/selection.js';

const declarations = parseScriptProps({
  speed: { type: 'number', default: 90, min: -360, max: 360, step: 5 },
  enabled: { type: 'boolean', default: true }, title: { type: 'string', default: 'Spinner' },
  tint: { type: 'color', default: [1, 0.5, 0] }, offset: { type: 'vec3', default: [0, 1, 0] },
  target: { type: 'entity', default: null }, mode: { type: 'enum', default: 'walk', options: ['walk', 'run'] },
});
function fixture() {
  const scene = createScene('Scripts'); const entity = createEntity('Cube'); const target = createEntity('Target');
  const component = { id: 'script', type: 'script', enabled: true, properties: { src: 'scripts/spinner.ts', params: {} }, entityRefs: [], assetRefs: [] };
  entity.components.push(component); scene.entities = [entity, target];
  return { scene, entity, target, component };
}
type FieldProps = { children?: ReactNode; label?: string; name?: string; onCommit?: (value: JsonValue) => boolean };
function findCommit(node: ReactNode, label: string): FieldProps['onCommit'] {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<FieldProps>(child)) continue;
    if ((child.props.label ?? child.props.name) === label && child.props.onCommit) return child.props.onCommit;
    const nested = findCommit(child.props.children, label); if (nested) return nested;
  }
  return undefined;
}
test('Inspector renders labelled script controls, declared numeric bounds, stable entity options and Add script', () => {
  const { scene, entity, target } = fixture();
  const html = renderToStaticMarkup(<Inspector scene={scene} selection={selectOne(entity.id)} sourcePath={null} readOnlyReason={null} conflict={null} onCommand={() => true} onResolveConflict={() => {}} onAddToAgent={null} scripts={[{ src: 'scripts/spinner.ts', props: declarations, code: '' }]} onRefreshScripts={async () => {}} />);
  assert.match(html, /scripts\/spinner.ts/);
  assert.match(html, /min="-360" max="360" step="5"/);
  assert.match(html, /type="checkbox"/); assert.match(html, /type="color"/);
  assert.match(html, /<legend[^>]*>offset<\/legend>/);
  assert.ok(html.includes(`value="${target.id}"`));
  assert.match(html, />walk<\/option>/); assert.match(html, />run<\/option>/);
  assert.match(html, /Add script/); assert.match(html, /Refresh scripts/);
  assert.doesNotMatch(html, /Add or remove properties \(JSON\)/, 'script metadata is presented as typed controls');
});
test('committing one script form field creates one undo step and preserves other params and component identity', () => {
  const { scene, entity, component } = fixture();
  component.properties.params = { title: 'Keep me' };
  const session = SceneSession.memory(scene, entry => assert.fail(entry.message));
  let commit: FieldProps['onCommit'];
  function Probe() {
    const tree = ScriptFields({ component, entityId: entity.id, scene, props: declarations, disabled: false, onCommand: command => session.execute(command) });
    commit = findCommit(tree, 'speed'); return tree;
  }
  renderToStaticMarkup(<Probe />);
  assert.ok(commit); assert.equal(commit(120), true);
  const edited = session.store!.scene.entities[0]!.components[0]!;
  assert.equal(edited.id, component.id); assert.equal(edited.properties.src, 'scripts/spinner.ts');
  assert.deepEqual(edited.properties.params, { title: 'Keep me', speed: 120 });
  session.undo(); assert.deepEqual(session.store!.scene, scene);
  assert.equal(session.store!.canUndo, false, 'there is no second undo entry');
  session.redo(); assert.deepEqual(session.store!.scene.entities[0]!.components[0]!.properties.params, { title: 'Keep me', speed: 120 });
  session.dispose();
});
test('invalid script property edits are rejected without modifying the scene or undo history', () => {
  const { scene, entity, component } = fixture();
  const session = SceneSession.memory(scene, () => {}); let commit: FieldProps['onCommit'];
  function Probe() { const tree = ScriptFields({ component, entityId: entity.id, scene, props: declarations, disabled: false, onCommand: command => session.execute(command) }); commit = findCommit(tree, 'speed'); return tree; }
  renderToStaticMarkup(<Probe />);
  assert.equal(commit!(1000), false); assert.equal(session.store!.canUndo, false); assert.deepEqual(session.store!.scene, scene);
  const locked = renderToStaticMarkup(<ScriptFields component={component} entityId={entity.id} scene={scene} props={declarations} disabled onCommand={() => assert.fail('locked edit')} />);
  assert.match(locked, /disabled=""/); session.dispose();
});

test('externally saved params that no longer match a declaration have an explicit recovery control', () => {
  const { scene, entity, component } = fixture(); component.properties.params = { speed: 'old string value' };
  const html = renderToStaticMarkup(<ScriptFields component={component} entityId={entity.id} scene={scene} props={declarations} disabled={false} onCommand={() => true} />);
  assert.match(html, /speed: saved value does not match the script declaration/);
  assert.match(html, /Reset speed to default/);
});
