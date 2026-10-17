import { Raycaster, Vector2 } from 'three';
import type { Camera, Object3D } from 'three';
import { isVisible, resolveOwnerEntity, type SceneRegistry } from './projection.js';

export interface PickingSession {
  pickAt(camera: Camera, x: number, y: number): string | null;
  dispose(): void;
}
export function createPickingSession(
  canvas: Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight' | 'width' | 'height'>,
  root: Object3D,
  registry: SceneRegistry,
): PickingSession {
  const raycaster = new Raycaster();
  return {
    pickAt(camera, x, y) {
      root.updateWorldMatrix(true, true); camera.updateWorldMatrix(true, false);
      raycaster.setFromCamera(new Vector2(x / (canvas.clientWidth || canvas.width || 1) * 2 - 1,
        1 - y / (canvas.clientHeight || canvas.height || 1) * 2), camera);
      for (const hit of raycaster.intersectObject(root, true)) {
        if (!isVisible(hit.object) || hit.object.userData.helper) continue;
        const owner = resolveOwnerEntity(registry, hit.object);
        if (owner !== null) return owner;
      }
      return null;
    },
    dispose() {},
  };
}
