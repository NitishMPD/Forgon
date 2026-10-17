import { Color, Entity } from 'playcanvas';
import type { Application } from 'playcanvas';
import { Grid } from 'playcanvas/scripts/esm/grid.mjs';

// Reference grid on the XZ plane, built on the engine's own Grid script (an ES-module Script
// class that creates its own render component with a pick=false mesh instance). The script is
// engine-bundled editor tooling, not authored scene content: no guestQueue/audio/vfx-style
// document behavior ever reaches the ScriptComponentSystem in edit mode.

export function createGridEntity(app: Application, size = 40): Entity {
  const entity = new Entity('Forgon Grid', app);
  entity.addComponent('script');
  entity.script?.create(Grid, {
    properties: {
      resolution: Grid.RESOLUTION_HIGH,
      colorX: new Color(0.35, 0.35, 0.38),
      colorZ: new Color(0.35, 0.35, 0.38),
    },
  });
  // The grid plane spans the entity's local scale on XZ; keep Y at 1 to avoid a flat shader.
  entity.setLocalScale(size, 1, size);
  entity.enabled = true;
  return entity;
}
