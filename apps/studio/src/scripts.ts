import type { SceneDocument, ScriptCatalog, ScriptModules } from '@forgon/project-schema';
import { loadScriptModule } from '@forgon/game-runtime/scripting';

export function assertScriptPlaySupported(scene: SceneDocument, desktop: boolean): void {
  if (desktop && scene.entities.some(entity => entity.components.some(component => component.type === 'script'))) {
    throw new Error("Scripts can't run in the desktop app yet (isolated script context pending).");
  }
}

/** The caller must request Play before invoking this function. */
export async function prepareScriptsForPlay(catalog: ScriptCatalog, signal?: AbortSignal): Promise<ScriptModules> {
  signal?.throwIfAborted();
  if (catalog.diagnostics.length) throw new Error('Scripts did not compile. Check Console for file and line details.');
  const modules: Record<string, { default: unknown }> = Object.create(null);
  for (const script of catalog.scripts) {
    try { modules[script.src] = await loadScriptModule(script.code, signal); }
    catch (error) { throw new Error(`Could not load ${script.src}: ${String(error)}`); }
  }
  return modules;
}
