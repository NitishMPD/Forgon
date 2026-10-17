import { defineScript, prop } from '@forgon/game-runtime/scripting';
import type { Object3D } from 'three';

const origins = new WeakMap<Object3D, number>();

export default defineScript({
  props: {
    amplitude: prop.number(0.25, { min: 0, max: 2, step: 0.05 }),
    frequency: prop.number(0.8, { min: 0, max: 5, step: 0.1 }),
  },
  start(ctx) { origins.set(ctx.entity, ctx.entity.position.y); },
  update(ctx) {
    ctx.entity.position.y = origins.get(ctx.entity)! + Math.sin(ctx.time.elapsed * ctx.params.frequency * Math.PI * 2) * ctx.params.amplitude;
  },
  destroy(ctx) { origins.delete(ctx.entity); },
});
