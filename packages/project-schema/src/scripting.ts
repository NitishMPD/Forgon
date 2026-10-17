import { z } from 'zod';
import { idSchema, jsonValueSchema, type JsonValue } from './documents.js';
import type { Diagnostic } from './boundaries.js';

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const scriptPropSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('number'), default: z.number().finite(), min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().positive().finite().optional() }).strict(),
  z.object({ type: z.literal('boolean'), default: z.boolean() }).strict(),
  z.object({ type: z.literal('string'), default: z.string() }).strict(),
  z.object({ type: z.literal('color'), default: vector }).strict(),
  z.object({ type: z.literal('vec3'), default: vector }).strict(),
  z.object({ type: z.literal('entity'), default: idSchema.nullable() }).strict(),
  z.object({ type: z.literal('enum'), default: z.string(), options: z.array(z.string()).min(1) }).strict(),
]);
export type ScriptProp = z.infer<typeof scriptPropSchema>;
export type ScriptProps = Record<string, ScriptProp>;
export interface ScriptModule { default: unknown }
export type ScriptModules = Readonly<Record<string, ScriptModule>>;
export interface CompiledScript { src: string; props: ScriptProps; code: string }
export interface ScriptCatalog { scripts: CompiledScript[]; diagnostics: Diagnostic[] }

export function validateScriptValue(prop: ScriptProp, value: unknown): JsonValue {
  switch (prop.type) {
    case 'number': return z.number().finite().min(prop.min ?? -Infinity).max(prop.max ?? Infinity).parse(value);
    case 'boolean': return z.boolean().parse(value);
    case 'string': return z.string().parse(value);
    case 'entity': return idSchema.nullable().parse(value);
    case 'enum': {
      if (typeof value !== 'string' || !prop.options.includes(value)) throw new Error('Expected a declared enum option');
      return value;
    }
    case 'color': return vector.refine(items => items.every(item => item >= 0 && item <= 1), 'Color channels must be between 0 and 1').parse(value);
    case 'vec3': return vector.parse(value);
  }
}
export function parseScriptProps(value: unknown): ScriptProps {
  const props = z.record(scriptPropSchema).parse(value);
  for (const prop of Object.values(props)) {
    if (prop.type === 'number' && prop.min !== undefined && prop.max !== undefined && prop.min > prop.max) throw new Error('Minimum exceeds maximum');
    validateScriptValue(prop, prop.default);
  }
  return props;
}
export function resolveScriptParams(props: ScriptProps, input: unknown): Record<string, JsonValue> {
  const values = z.record(jsonValueSchema).parse(input);
  const resolved: Record<string, JsonValue> = Object.create(null);
  for (const [key, prop] of Object.entries(props)) resolved[key] = validateScriptValue(prop, Object.hasOwn(values, key) ? values[key] : prop.default);
  return resolved;
}
