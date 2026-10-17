import { Picker } from 'playcanvas';
import type { Application, CameraComponent, GraphicsDevice, Layer, MeshInstance } from 'playcanvas';
import { resolveOwnerEntity, type SceneRegistry } from './projection.js';

// Click picking uses the engine's own Picker (framework/graphics/picker.js, exported in 2.23.3).
// prepare() renders the pickable layers into a private buffer at picker.width x picker.height,
// so screen coordinates must be scaled from canvas pixels into that buffer. Grid/gizmo shapes
// are excluded by picking only the World layer (the grid mesh instance also sets pick=false).

export interface PickingSession {
  /** Picks the stable scene entity id under canvas-relative pixel coordinates, or null. */
  pickAt(camera: CameraComponent, x: number, y: number): string | null;
  dispose(): void;
}

function deviceIsRenderable(device: GraphicsDevice): boolean {
  // NullGraphicsDevice cannot rasterize a pick buffer; WebGPU's Picker reads back empty, so
  // picking is only offered on WebGL2 devices.
  return device.deviceType === 'webgl2';
}

export function createPickingSession(
  app: Application,
  registry: SceneRegistry,
  layers: Layer[],
): PickingSession | null {
  if (!deviceIsRenderable(app.graphicsDevice)) return null;

  const canvas = app.graphicsDevice.canvas as { clientWidth?: number; clientHeight?: number; width?: number; height?: number };
  const picker = new Picker(app, 1024, 1024);

  return {
    pickAt(camera: CameraComponent, x: number, y: number): string | null {
      const width = canvas.clientWidth || canvas.width || 1;
      const height = canvas.clientHeight || canvas.height || 1;
      picker.prepare(camera, app.scene, layers);
      const hits = picker.getSelection((x / width) * picker.width, (y / height) * picker.height);
      for (const hit of hits) {
        const meshInstance = hit as MeshInstance;
        const owner = resolveOwnerEntity(registry, meshInstance.node);
        if (owner !== null) return owner;
      }
      return null;
    },
    dispose(): void {
      picker.destroy();
    },
  };
}
