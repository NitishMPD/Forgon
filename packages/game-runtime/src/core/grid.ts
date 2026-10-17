import { GridHelper } from 'three';

export function createGridEntity(size = 40): GridHelper {
  const grid = new GridHelper(size, size * 10, 0x595961, 0x303039);
  grid.name = 'Forgon Grid';
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  return grid;
}
