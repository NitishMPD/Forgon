import type { SceneDocument, ScriptCatalog, ScriptModules } from '@forgon/project-schema';
import { loadScriptModule } from '@forgon/game-runtime/scripting';

export function validateScriptsForPlay(scene: SceneDocument, catalog: ScriptCatalog): void {
  if (catalog.diagnostics.length) throw new Error('Scripts did not compile. Check Console for file and line details.');
  const available = new Set(catalog.scripts.map(script => script.src));
  for (const entity of scene.entities) for (const component of entity.components) {
    if (entity.enabled && component.type === 'script' && component.enabled && !available.has(String(component.properties.src))) {
      throw new Error(`Script not found or invalid: ${String(component.properties.src)} (${entity.name}). Check Console.`);
    }
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
