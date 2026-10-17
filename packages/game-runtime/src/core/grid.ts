import { GridHelper } from 'three';

export function createGridEntity(size = 40, step = 0.5): GridHelper {
  const grid = new GridHelper(size, size / step, 0x595961, 0x303039);
  grid.name = 'Forgon Grid';
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  return grid;
}

export function setGridStep(grid: GridHelper, step: number): void {
  if (!Number.isFinite(step) || step < 0.01) throw new RangeError('Grid step must be at least 0.01 m.');
  const next = createGridEntity(40, step);
  grid.geometry.dispose();
  grid.geometry = next.geometry;
  next.material.dispose();
}
