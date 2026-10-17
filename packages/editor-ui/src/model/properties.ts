import type { Component, JsonValue } from '@forgon/project-schema';

// Typed editing for component properties. Every change is a whole-component upsert built here,
// so the store validates the complete component (including its references) before committing.

export type PropertyKind = 'boolean' | 'number' | 'string' | 'vector3' | 'json';

export function propertyKind(value: JsonValue): PropertyKind {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number')) return 'vector3';
  return 'json';
}

function assertFiniteJson(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Numbers must be finite.');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteJson(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertFiniteJson(item);
  }
}

export type JsonDraft = { ok: true; value: JsonValue } | { ok: false; message: string };

// JSON.parse turns 1e400 into Infinity, so finiteness is checked after parsing.
export function parseJsonDraft(text: string): JsonDraft {
  try {
    const value = JSON.parse(text) as unknown;
    assertFiniteJson(value);
    return { ok: true, value: value as JsonValue };
  } catch (error) {
    const message = error instanceof Error && error.message === 'Numbers must be finite.' ? error.message : 'Enter valid JSON.';
    return { ok: false, message };
  }
}

// Only existing property keys can be edited. Adding or removing keys is not offered by the inspector.
export function withProperty(component: Component, name: string, value: JsonValue): Component {
  if (!Object.prototype.hasOwnProperty.call(component.properties, name)) {
    throw new Error(`Unknown property ${name}`);
  }
  return { ...component, properties: { ...component.properties, [name]: value } };
}
