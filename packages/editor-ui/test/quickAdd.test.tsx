import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { searchPlacements, type PlacementTarget } from '../src/model/placement.js';
import { QuickAdd } from '../src/shell/QuickAdd.js';

function find(node: ReactNode, role: string): ReactElement<Record<string, any>> {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, any>>(child)) continue;
    if (child.props.role === role) return child;
    if (child.props.children) {
      const nested = find(child.props.children, role);
      if (nested) return nested;
    }
  }
  return undefined!;
}

test('quick placement searches only placeable models, primitives and prefabs by name or path', () => {
  const assets = [
    { id: 'tree', name: 'Oak', kind: 'model' as const, path: 'forest/oak.GLB' },
    { id: 'image', name: 'Oak picture', kind: 'texture' as const, path: 'oak.png' },
    { id: 'unsupported', name: 'Oak external', kind: 'model' as const, path: 'oak.gltf' },
  ];
  assert.deepEqual(searchPlacements(assets, [], ' FOREST '), [{ name: 'Oak', detail: 'forest/oak.GLB', target: { kind: 'model', assetId: 'tree' } }]);
  assert.equal(searchPlacements(assets, [], 'oak').length, 1);
  assert.equal(searchPlacements([], [], 'sphere')[0]?.target.kind, 'primitive');
  assert.equal(searchPlacements([], [], 'missing').length, 0);
});

test('quick placement exposes a searchable combobox and handles Enter, Escape and mouse selection', () => {
  let tree!: ReactElement;
  let placed: PlacementTarget | undefined;
  let restored = false;
  function Probe() {
    tree = QuickAdd({ x: 20, y: 30, assets: [], prefabs: [], onPlace: target => { placed = target; }, onClose: restore => { restored = restore; } });
    return tree;
  }
  const html = renderToStaticMarkup(<Probe />);
  assert.match(html, /role="combobox"[^>]*aria-label="Search objects and assets"/);
  assert.match(html, /role="listbox"/);
  const dialog = find(tree, 'dialog');
  const key = (value: string, composing = false) => dialog.props.onKeyDown({ key: value, nativeEvent: { isComposing: composing }, stopPropagation() {}, preventDefault() {} });
  key('Enter', true); assert.equal(placed, undefined);
  key('Enter'); assert.deepEqual(placed, { kind: 'primitive', primitive: 'box' });
  key('Escape'); assert.equal(restored, true);
  placed = undefined;
  find(tree, 'option').props.onClick();
  assert.deepEqual(placed, { kind: 'primitive', primitive: 'box' });
});
