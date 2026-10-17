import { parseScriptProps, resolveScriptParams, scriptPropertiesSchema } from '@forgon/project-schema';
import type { JsonValue, SceneDocument } from '@forgon/project-schema';
import type { Object3D } from 'three';
import type { ScriptContext, ScriptDefinition, ScriptInput, ScriptModules } from './index.js';

interface Instance {
  entityId: string; src: string; definition: ScriptDefinition; context: ScriptContext;
  enabled: boolean; subscriptions: Set<() => void>;
}
export interface ScriptHost { update(dt: number): void; stop(): void }
export function createScriptHost(options: {
  scene: SceneDocument;
  entities: ReadonlyMap<string, Object3D>;
  scripts: ScriptModules;
  input: ScriptInput;
  onFault(message: string): void;
  log?(message: string): void;
}): ScriptHost {
  const instances: Instance[] = [];
  const events = new Map<string, Set<{ instance: Instance; listener(value: JsonValue | undefined): void }>>();
  let stopped = false;
  const clear = (instance: Instance): void => { for (const unsubscribe of instance.subscriptions) unsubscribe(); instance.subscriptions.clear(); };
  const fault = (instance: Instance, error: unknown): void => {
    instance.enabled = false; clear(instance);
    options.onFault(`Script ${instance.src} on entity ${instance.entityId}: ${String(error)}`);
  };
  const invoke = (instance: Instance, hook: 'start' | 'update' | 'destroy', dt = 0): void => {
    try { instance.definition[hook]?.(instance.context, dt); } catch (error) { fault(instance, error); }
  };
  for (const entity of options.scene.entities) {
    const object = options.entities.get(entity.id);
    if (!object || !entity.enabled) continue;
    let visible = true;
    for (let parent: Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) visible = false;
    if (!visible) continue;
    for (const component of entity.components) {
      if (!component.enabled || component.type !== 'script') continue;
      const src = String(component.properties.src);
      try {
        const attachment = scriptPropertiesSchema.parse(component.properties);
        const definition = options.scripts[src]?.default as ScriptDefinition | undefined;
        if (!definition || typeof definition !== 'object') throw new Error('Missing default defineScript export');
        const props = parseScriptProps(definition.props);
        for (const hook of ['start', 'update', 'destroy'] as const) if (definition[hook] !== undefined && typeof definition[hook] !== 'function') throw new Error(`Invalid ${hook} hook`);
        const instance: Instance = { entityId: entity.id, src, definition, enabled: true, subscriptions: new Set(), context: null! };
        instance.context = {
          entity: object, params: resolveScriptParams(props, attachment.params) as ScriptContext['params'],
          find: id => options.entities.get(id),
          findByName: name => [...options.entities.values()].find(item => item.name === name),
          input: options.input, time: { elapsed: 0, dt: 0 },
          emit(name, value) {
            if (stopped || !instance.enabled) return;
            for (const entry of [...events.get(name) ?? []]) {
              if (!entry.instance.enabled) continue;
              try { entry.listener(value); } catch (error) { fault(entry.instance, error); }
            }
          },
          on(name, listener) {
            if (stopped || !instance.enabled) return () => undefined;
            const listeners = events.get(name) ?? new Set(); events.set(name, listeners);
            const entry = { instance, listener }; listeners.add(entry);
            const unsubscribe = (): void => { listeners.delete(entry); instance.subscriptions.delete(unsubscribe); if (!listeners.size) events.delete(name); };
            instance.subscriptions.add(unsubscribe); return unsubscribe;
          },
          log: (...values) => options.log?.(`[${entity.id} ${src}] ${values.map(String).join(' ')}`),
        };
        instances.push(instance);
      } catch (error) { options.onFault(`Script ${src} on entity ${entity.id}: ${String(error)}`); }
    }
  }
  for (const instance of instances) invoke(instance, 'start');
  return {
    update(dt) {
      if (stopped || !Number.isFinite(dt) || dt <= 0) return;
      for (const instance of instances) {
        if (!instance.enabled) continue;
        instance.context.time.elapsed += dt; instance.context.time.dt = dt;
        invoke(instance, 'update', dt);
      }
    },
    stop() {
      if (stopped) return; stopped = true;
      for (const instance of instances) { invoke(instance, 'destroy'); instance.enabled = false; clear(instance); }
      instances.length = 0; events.clear();
    },
  };
}
