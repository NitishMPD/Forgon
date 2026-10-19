import { Box3, Object3D, PerspectiveCamera, Ray, Vector3 } from 'three';
import { defineScript } from '@forgon/game-runtime/scripting';

type ColliderNode = Object3D & { collision?: { enabled: boolean; isTrigger: boolean; halfExtents: Vector3 } };
interface DrivingState {
  camera: PerspectiveCamera;
  overviewPosition: Vector3;
  overviewRotation: PerspectiveCamera['quaternion'];
  solids: Box3[];
  route: Vector3[];
  segment: number;
  distance: number;
  speed: number;
  driving: boolean;
  hud?: HTMLDivElement;
}
const states = new WeakMap<Object3D, DrivingState>();
// A rotation-independent footprint encloses the entire car, including its corners.
const radius = 1.1;
function blocked(position: Vector3, solids: Box3[]): boolean {
  return solids.some(box => {
    if (box.max.y < position.y - 0.28 || box.min.y > position.y + 0.6) return false;
    const x = Math.max(box.min.x, Math.min(box.max.x, position.x));
    const z = Math.max(box.min.z, Math.min(box.max.z, position.z));
    return Math.hypot(position.x - x, position.z - z) < radius;
  });
}

export default defineScript({
  props: {},
  start(ctx) {
    const cameraOwner = ctx.find('gen_c68de6bf2459a97b');
    const camera = cameraOwner?.children.find(child => child instanceof PerspectiveCamera) as PerspectiveCamera | undefined;
    const road = ctx.find('city_road_x_7');
    if (!camera || !road || !ctx.entity.parent) throw new Error('City camera, roads and car root are required');
    let root = ctx.entity.parent;
    // Organizational groups must not limit collision discovery to the Vehicles subtree.
    while (root.parent) root = root.parent;
    root.updateWorldMatrix(true, true);
    const solids: Box3[] = [];
    root.traverse(object => {
      const collision = (object as ColliderNode).collision;
      if (object === ctx.entity || !collision?.enabled || collision.isTrigger) return;
      for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return;
      const half = collision.halfExtents;
      solids.push(new Box3(half.clone().negate(), half.clone()).applyMatrix4(object.matrixWorld));
    });
    const extent = Math.abs(road.position.x) - 1.5;
    const corner = 3;
    const route: Vector3[] = [];
    for (let side = 0; side < 4; side++) {
      const angle = -Math.PI / 2 + side * Math.PI / 2;
      const cx = (side === 0 || side === 1 ? 1 : -1) * (extent - corner);
      const cz = (side === 0 || side === 3 ? -1 : 1) * (extent - corner);
      for (let i = 0; i <= 16; i++) {
        const a = angle + i / 16 * Math.PI / 2;
        route.push(new Vector3(cx + Math.cos(a) * corner, ctx.entity.position.y, cz + Math.sin(a) * corner));
      }
    }
    const state: DrivingState = {
      camera, overviewPosition: camera.position.clone(), overviewRotation: camera.quaternion.clone(),
      solids, route, segment: 0, distance: 0, speed: 0, driving: false,
    };
    ctx.entity.position.copy(route[0]!);
    if (typeof document !== 'undefined') {
      const hud = document.createElement('div');
      hud.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;background:#102735e8;color:white;font:14px system-ui;pointer-events:none;z-index:10;text-align:center';
      hud.setAttribute('role', 'status');
      hud.textContent = 'City tour · Enter to drive';
      document.body.append(hud);
      state.hud = hud;
    }
    states.set(ctx.entity, state);
  },
  update(ctx, dt) {
    const s = states.get(ctx.entity)!;
    if (ctx.input.pressed('Enter') || ctx.input.pressed('NumpadEnter')) {
      s.driving = true;
      s.speed = 0;
      if (s.hud) s.hud.textContent = 'WASD / Arrows · Space brake · R restart tour';
    }
    if (ctx.input.pressed('KeyR')) {
      s.driving = false; s.speed = 0; s.segment = 0; s.distance = 0;
      ctx.entity.position.copy(s.route[0]!);
      s.camera.position.copy(s.overviewPosition); s.camera.quaternion.copy(s.overviewRotation);
      if (s.hud) s.hud.textContent = 'City tour · Enter to drive';
    }
    // Small steps bound both travel and steering; a slow frame cannot tunnel through a wall.
    let remaining = Math.min(dt, 0.25);
    while (remaining > 1e-8) {
      const h = Math.min(remaining, 1 / 120); remaining -= h;
      if (!s.driving) {
        const a = s.route[s.segment]!;
        const b = s.route[(s.segment + 1) % s.route.length]!;
        const length = a.distanceTo(b);
        s.distance += 6 * h;
        const next = a.clone().lerp(b, Math.min(1, s.distance / length));
        if (blocked(next, s.solids)) { s.distance -= 6 * h; continue; }
        ctx.entity.position.copy(next);
        ctx.entity.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        if (s.distance >= length) { s.distance -= length; s.segment = (s.segment + 1) % s.route.length; }
      } else {
        const down = (a: string, b: string) => ctx.input.down(a) || ctx.input.down(b);
        const throttle = Number(down('KeyW', 'ArrowUp')) - Number(down('KeyS', 'ArrowDown'));
        const steering = Number(down('KeyA', 'ArrowLeft')) - Number(down('KeyD', 'ArrowRight'));
        const brake = ctx.input.down('Space');
        if (brake || !throttle) {
          s.speed = Math.sign(s.speed) * Math.max(0, Math.abs(s.speed) - (brake ? 24 : 4) * h);
        } else s.speed = Math.max(-7, Math.min(18, s.speed + throttle * 10 * h));
        ctx.entity.rotation.y += steering * s.speed / 2.6 * 0.5 * h;
        const next = ctx.entity.position.clone();
        next.x += Math.sin(ctx.entity.rotation.y) * s.speed * h;
        next.z += Math.cos(ctx.entity.rotation.y) * s.speed * h;
        if (blocked(next, s.solids)) s.speed = 0;
        else ctx.entity.position.copy(next);
      }
    }
    if (s.driving) {
      const target = ctx.entity.position.clone().add(new Vector3(0, 0.7, 0));
      const offset = new Vector3(-Math.sin(ctx.entity.rotation.y) * 7, 3.7, -Math.cos(ctx.entity.rotation.y) * 7);
      const ray = new Ray(target, offset.clone().normalize());
      let distance = offset.length();
      for (const box of s.solids) {
        const hit = ray.intersectBox(box.clone().expandByScalar(0.25), new Vector3());
        if (hit) distance = Math.min(distance, Math.max(0.35, target.distanceTo(hit) - 0.2));
      }
      const position = target.clone().addScaledVector(ray.direction, distance);
      s.camera.parent!.worldToLocal(position);
      s.camera.position.copy(position);
      s.camera.lookAt(target);
    }
  },
  destroy(ctx) {
    states.get(ctx.entity)?.hud?.remove();
    states.delete(ctx.entity);
  },
});
