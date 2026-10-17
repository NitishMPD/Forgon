import { defineScript, prop } from '@forgon/game-runtime/scripting';

export default defineScript({
  props: { speed: prop.number(90, { min: -360, max: 360, step: 5 }) },
  update(ctx, dt) {
    ctx.entity.rotateY(ctx.params.speed * Math.PI / 180 * dt);
  },
});
