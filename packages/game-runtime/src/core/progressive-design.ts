import type { Box3 } from 'three';
import type { EditorCameraController } from './editor-camera.js';

/** One camera session per started prompt; toggling or status changes cannot undo interruption. */
export function createProgressiveDesign(camera: EditorCameraController) {
  let promptId: string | null = null;
  let active = false;
  let interrupted = false;
  let framed: Box3 | null = null;
  let aspect = 0;
  return {
    setPrompt(id: string | null, enabled: boolean): void {
      if (id !== promptId) {
        promptId = id;
        interrupted = false;
        framed = null;
      }
      active = id !== null && enabled;
    },
    interrupt(): void { interrupted = true; },
    get isActive(): boolean { return active && !interrupted; },
    update(dt: number, bounds: Box3 | null, reducedMotion: boolean): void {
      if (!active || interrupted || !bounds || bounds.isEmpty()) return;
      if (!framed?.equals(bounds) || aspect !== camera.camera.aspect) {
        camera.frameBox(bounds);
        framed = bounds.clone();
        aspect = camera.camera.aspect;
      }
      if (!reducedMotion) camera.orbit(Math.max(0, Math.min(dt, 0.1)) * Math.PI / 45);
    },
  };
}
