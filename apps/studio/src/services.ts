import type { StudioServices } from '@forgon/editor-ui';
import { mountStudioViewport } from './playViewport.js';
import { connectDesktop, isDesktop } from '@forgon/studio-desktop';

// Native project/agent adapters are provided by the desktop lane; never import Node here.
export const studioServices: StudioServices = {
  project: null,
  agent: null,
  viewport: mountStudioViewport,
};

export async function loadStudioServices(): Promise<StudioServices> {
  if (!isDesktop()) return studioServices;
  const desktop = await connectDesktop();
  window.addEventListener('pagehide', () => desktop.dispose(), { once: true });
  return { project: desktop.project, agent: desktop.agent, viewport: mountStudioViewport };
}
