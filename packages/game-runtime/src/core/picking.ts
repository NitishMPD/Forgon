import { Matrix3, Mesh, Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import { isVisible, resolveOwnerEntity, type SceneRegistry } from './projection.js';
import type { SurfacePoint } from './types.js';

export interface PickingSession {
  pickAt(camera: Camera, x: number, y: number): string | null;
  surfaceAt(camera: Camera, x: number, y: number): SurfacePoint | null;
  dispose(): void;
}
export function createPickingSession(
  canvas: Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight' | 'width' | 'height'>,
  root: Object3D,
  registry: SceneRegistry,
): PickingSession {
  const raycaster = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const cast = (camera: Camera, x: number, y: number): boolean => {
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > width || y > height) return false;
    root.updateWorldMatrix(true, true); camera.updateWorldMatrix(true, false);
    raycaster.setFromCamera(new Vector2(x / width * 2 - 1, 1 - y / height * 2), camera);
    return true;
  };
  return {
    pickAt(camera, x, y) {
      if (!cast(camera, x, y)) return null;
      for (const hit of raycaster.intersectObject(root, true)) {
        if (!isVisible(hit.object) || hit.object.userData.helper) continue;
        const owner = resolveOwnerEntity(registry, hit.object);
        if (owner !== null) return owner;
      }
      return null;
    },
    surfaceAt(camera, x, y) {
      if (!cast(camera, x, y)) return null;
      for (const hit of raycaster.intersectObject(root, true)) {
        if (!(hit.object instanceof Mesh) || !hit.face || !isVisible(hit.object) || hit.object.userData.helper || resolveOwnerEntity(registry, hit.object) === null) continue;
        const normal = hit.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        return { position: hit.point.toArray(), normal: normal.toArray() };
      }
      const point = raycaster.ray.intersectPlane(ground, new Vector3());
      return point ? { position: point.toArray(), normal: [0, 1, 0] } : null;
    },
    dispose() {},
  };
}
