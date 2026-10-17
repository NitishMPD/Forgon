import * as three from 'three';
import type { Object3D } from 'three';
import type { JsonValue, ScriptProp, ScriptProps, ScriptModule } from '@forgon/project-schema';

type Value<P extends ScriptProp> = P extends { type: 'number' } ? number
  : P extends { type: 'boolean' } ? boolean
  : P extends { type: 'color' | 'vec3' } ? [number, number, number]
  : P extends { type: 'enum'; options: infer O extends string[] } ? O[number]
  : P extends { type: 'entity' } ? string | null : string;
export type ScriptParams<P extends ScriptProps> = { [K in keyof P]: Value<P[K]> };
export interface ScriptInput {
  down(keyOrAction: string): boolean;
  pressed(keyOrAction: string): boolean;
}
export interface ScriptContext<P extends ScriptProps = ScriptProps> {
  entity: Object3D;
  params: ScriptParams<P>;
  find(id: string): Object3D | undefined;
  findByName(name: string): Object3D | undefined;
  input: ScriptInput;
  time: { elapsed: number; dt: number };
  emit(name: string, value?: JsonValue): void;
  on(name: string, listener: (value: JsonValue | undefined) => void): () => void;
  log(...values: unknown[]): void;
}
export interface ScriptDefinition<P extends ScriptProps = ScriptProps> {
  props: P;
  start?(ctx: ScriptContext<P>): void;
  update?(ctx: ScriptContext<P>, dt: number): void;
  destroy?(ctx: ScriptContext<P>): void;
}
export function defineScript<P extends ScriptProps>(definition: ScriptDefinition<P>): ScriptDefinition<P> { return definition; }
export const prop = {
  number: (value: number, options: { min?: number; max?: number; step?: number } = {}) => ({ type: 'number' as const, default: value, ...options }),
  boolean: (value: boolean) => ({ type: 'boolean' as const, default: value }),
  string: (value: string) => ({ type: 'string' as const, default: value }),
  color: (value: [number, number, number]) => ({ type: 'color' as const, default: value }),
  vec3: (value: [number, number, number]) => ({ type: 'vec3' as const, default: value }),
  entity: (value: string | null = null) => ({ type: 'entity' as const, default: value }),
  enum: <const O extends string[]>(value: O[number], options: O) => ({ type: 'enum' as const, default: value, options }),
};
export type { ScriptModule, ScriptModules } from '@forgon/project-schema';

/** Call only from Play: importing the generated module evaluates project top-level code. */
export async function loadScriptModule(code: string, signal?: AbortSignal): Promise<ScriptModule> {
  signal?.throwIfAborted();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    const compiled = await import(/* @vite-ignore */ url) as { load(modules: Record<string, unknown>): ScriptModule };
    signal?.throwIfAborted();
    return compiled.load({ three, '@forgon/game-runtime/scripting': { defineScript, prop } });
  } finally { URL.revokeObjectURL(url); }
}
