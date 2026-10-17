import { entitySchema, idSchema } from '@forgon/project-schema';
import type { Entity } from '@forgon/project-schema';

function hash(value: string): bigint {
  let result = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) result = BigInt.asUintN(64, (result ^ BigInt(byte)) * 0x100000001b3n);
  return result;
}

/** Identity excludes the seed and generator version so reruns preserve editable objects. */
export function stableId(namespace: string, key: string): string {
  if (!namespace || !key) throw new Error('Stable identity requires a namespace and semantic key');
  return idSchema.parse(`gen_${hash(JSON.stringify([namespace, key])).toString(16).padStart(16, '0')}`);
}

export class SceneAuthor {
  constructor(readonly namespace: string, readonly seed: string) {}
  id(key: string): string { return stableId(this.namespace, key); }
  /** Keyed samples do not shift when unrelated entities are inserted. */
  random(key: string): number {
    return Number(hash(JSON.stringify([this.namespace, this.seed, key])) >> 11n) / 9007199254740992;
  }
  entity(key: string, name: string, parentId: string | null = null): Entity {
    return entitySchema.parse({ id: this.id(key), name, parentId, enabled: true,
      transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, components: [] });
  }
}
