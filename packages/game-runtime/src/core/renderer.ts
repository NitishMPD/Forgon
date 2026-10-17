import { Color, PCFSoftShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import type { PerspectiveCamera, Scene } from 'three';

/** GPU creation stays at the DOM mount boundary; scene/session modules remain headless. */
export function createRenderSurface(
  canvas: HTMLCanvasElement, container: HTMLElement, world: Scene,
  getCamera: () => PerspectiveCamera | null,
  update: (dt: number) => void,
  onFault: (error: unknown) => void,
) {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const background = new Color(0.075, 0.09, 0.13);
  let disposed = false;
  const render = (): void => {
    if (disposed) return;
    const camera = getCamera();
    if (!camera) return;
    const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1);
    if (camera.aspect !== width / height) { camera.aspect = width / height; camera.updateProjectionMatrix(); }
    world.background = camera.userData.clearColor instanceof Color ? camera.userData.clearColor : background;
    renderer.render(world, camera);
  };
  const resize = (): void => {
    if (disposed) return;
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false);
    // Resizing clears the drawing buffer: repaint before a panel drag can expose it.
    render();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    try { resize(); } catch (error) { onFault(error); }
  });
  observer?.observe(container);
  let previous: number | null = null;
  return {
    resize,
    render,
    start() {
      resize();
      renderer.setAnimationLoop(time => {
        if (disposed) return;
        const dt = previous === null ? 0 : Math.min((time - previous) / 1000, 0.1);
        previous = time;
        try { update(dt); render(); } catch (error) { renderer.setAnimationLoop(null); onFault(error); }
      });
    },
    dispose() {
      if (disposed) return; disposed = true;
      observer?.disconnect(); renderer.setAnimationLoop(null); renderer.dispose(); renderer.forceContextLoss();
    },
  };
}
