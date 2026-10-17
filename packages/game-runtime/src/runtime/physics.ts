import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { SceneNode, isVisible } from '../core/projection.js';

let loading: Promise<void> | undefined;
let ready = false;

/** Load the engine-tagged Ammo build once; each play session owns its own physics world. */
export function loadPhysics(): Promise<void> {
  return loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../vendor/ammo.wasm.js', import.meta.url).href;
    script.onload = () => {
      const global = globalThis as typeof globalThis & { Ammo?: unknown };
      const factory = global.Ammo as (options: { locateFile: () => string }) => Promise<unknown>;
      if (typeof factory !== 'function') { script.remove(); reject(new Error('Ammo factory unavailable')); return; }
      Promise.resolve().then(() => factory({ locateFile: () => new URL('../../vendor/ammo.wasm.wasm', import.meta.url).href })).then(module => {
        global.Ammo = module;
        ready = true;
        script.remove();
        resolve();
      }, error => { script.remove(); reject(error); });
    };
    script.onerror = () => { script.remove(); reject(new Error('Ammo physics payload could not be loaded')); };
    document.head.appendChild(script);
  }).catch(error => { loading = undefined; throw error; });
}

export function physicsReady(): boolean { return ready; }

// Only the static/kinematic box and raycast API is used; gameplay owns its movement.
interface AmmoVector { x(): number; y(): number; z(): number }
interface AmmoQuaternion { }
interface AmmoTransform {
  setIdentity(): void;
  setOrigin(value: AmmoVector): void;
  setRotation(value: AmmoQuaternion): void;
}
interface AmmoBody { setWorldTransform(value: AmmoTransform): void; setCollisionFlags(value: number): void; setActivationState(value: number): void }
interface AmmoMotion { setWorldTransform(value: AmmoTransform): void }
interface AmmoRay {
  hasHit(): boolean;
  get_m_collisionObject(): object;
  get_m_hitPointWorld(): AmmoVector;
}
interface AmmoWorld {
  addRigidBody(body: AmmoBody): void;
  removeRigidBody(body: AmmoBody): void;
  updateSingleAabb(body: AmmoBody): void;
  rayTest(from: AmmoVector, to: AmmoVector, result: AmmoRay): void;
}
interface AmmoModule {
  btVector3: new (x: number, y: number, z: number) => AmmoVector;
  btQuaternion: new (x: number, y: number, z: number, w: number) => AmmoQuaternion;
  btTransform: new () => AmmoTransform;
  btDefaultCollisionConfiguration: new () => object;
  btCollisionDispatcher: new (configuration: object) => object;
  btDbvtBroadphase: new () => object;
  btSequentialImpulseConstraintSolver: new () => object;
  btDiscreteDynamicsWorld: new (dispatcher: object, broadphase: object, solver: object, configuration: object) => AmmoWorld;
  btBoxShape: new (half: AmmoVector) => object;
  btDefaultMotionState: new (transform: AmmoTransform) => AmmoMotion;
  btRigidBodyConstructionInfo: new (mass: number, motion: AmmoMotion, shape: object, inertia: AmmoVector) => object;
  btRigidBody: new (info: object) => AmmoBody;
  ClosestRayResultCallback: new (from: AmmoVector, to: AmmoVector) => AmmoRay;
  getPointer(value: object): number;
  destroy(value: object): void;
}
export interface PhysicsWorld {
  sync(): void;
  raycastFirst(from: Vector3, to: Vector3): { entity: SceneNode; point: Vector3 } | null;
  dispose(): void;
}
export function createPhysicsWorld(root: Object3D): PhysicsWorld {
  const ammo = (globalThis as typeof globalThis & { Ammo?: AmmoModule }).Ammo;
  if (!ammo || typeof ammo.btVector3 !== 'function') throw new Error('Ammo physics is not initialized');
  const owned: object[] = [];
  const own = <T extends object>(value: T): T => { owned.push(value); return value; };
  const configuration = own(new ammo.btDefaultCollisionConfiguration());
  const dispatcher = own(new ammo.btCollisionDispatcher(configuration));
  const broadphase = own(new ammo.btDbvtBroadphase());
  const solver = own(new ammo.btSequentialImpulseConstraintSolver());
  const world = own(new ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, configuration));
  const bodies: { entity: SceneNode; body: AmmoBody; motion: AmmoMotion }[] = [];
  const byPointer = new Map<number, SceneNode>();
  const pose = (entity: SceneNode): AmmoTransform => {
    const position = entity.getWorldPosition(new Vector3());
    const rotation = entity.getWorldQuaternion(new Quaternion());
    const transform = new ammo.btTransform(); transform.setIdentity();
    const origin = new ammo.btVector3(position.x, position.y, position.z);
    const quaternion = new ammo.btQuaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    transform.setOrigin(origin); transform.setRotation(quaternion);
    ammo.destroy(origin); ammo.destroy(quaternion);
    return transform;
  };
  let disposed = false;
  const result: PhysicsWorld = {
    sync() {
      for (const { entity, body, motion } of bodies) {
        if (!entity.collision?.kinematic) continue;
        const transform = pose(entity);
        body.setWorldTransform(transform); motion.setWorldTransform(transform);
        world.updateSingleAabb(body); ammo.destroy(transform);
      }
    },
    raycastFirst(from, to) {
      const start = new ammo.btVector3(from.x, from.y, from.z);
      const end = new ammo.btVector3(to.x, to.y, to.z);
      const ray = new ammo.ClosestRayResultCallback(start, end);
      try {
        world.rayTest(start, end, ray);
        if (!ray.hasHit()) return null;
        const entity = byPointer.get(ammo.getPointer(ray.get_m_collisionObject()));
        const point = ray.get_m_hitPointWorld();
        return entity ? { entity, point: new Vector3(point.x(), point.y(), point.z()) } : null;
      } finally { ammo.destroy(ray); ammo.destroy(end); ammo.destroy(start); }
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const { body } of bodies) world.removeRigidBody(body);
      for (const value of owned.reverse()) ammo.destroy(value);
      bodies.length = 0; byPointer.clear();
    },
  };
  try {
    root.updateWorldMatrix(true, true);
    root.traverse(node => {
      if (!(node instanceof SceneNode) || !node.collision?.enabled || !isVisible(node)) return;
      const collision = node.collision;
      const half = collision.halfExtents.clone().multiply(node.getWorldScale(new Vector3()));
      const dimensions = own(new ammo.btVector3(half.x, half.y, half.z));
      const shape = own(new ammo.btBoxShape(dimensions));
      const transform = own(pose(node));
      const motion = own(new ammo.btDefaultMotionState(transform));
      const inertia = own(new ammo.btVector3(0, 0, 0));
      const info = own(new ammo.btRigidBodyConstructionInfo(0, motion, shape, inertia));
      const body = own(new ammo.btRigidBody(info));
      body.setCollisionFlags((collision.kinematic ? 2 : 1) | (collision.isTrigger ? 4 : 0));
      if (collision.kinematic) body.setActivationState(4);
      world.addRigidBody(body); bodies.push({ entity: node, body, motion });
      byPointer.set(ammo.getPointer(body), node);
    });
    return result;
  } catch (error) { result.dispose(); throw error; }
}
