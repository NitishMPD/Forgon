// Cinematic third-person camera director for the Sector demo. Pure math (no engine, no DOM)
// so it can be reasoned about and tested headlessly.
//
// `follow` cameras track the player from behind with lag, a speed-driven FOV, a look-ahead
// point on the velocity vector and a roll that leans into wall runs. `intro` seconds blend
// from the authored camera pose into the follow pose for a cinematic opening dolly.

import type { Vec3 } from './parkour.js';

export type CameraMode = 'static' | 'follow';

export interface CameraDef {
  mode: CameraMode;
  /** Metres the camera sits behind the player. */
  distance: number;
  /** Height above the player's torso the camera orbits. */
  height: number;
  /** Seconds the camera is allowed to lag behind the player. */
  lag: number;
  /** Seconds of framing time before the player is in full control. */
  intro: number;
  /** Extra field of view at top speed. */
  speedFov: number;
  /** Look-ahead distance along the velocity vector. */
  lookAhead: number;
}

export const DEFAULT_CAMERA_DEF: CameraDef = { mode: 'static', distance: 7.5, height: 2.4, lag: 6, intro: 0, speedFov: 10, lookAhead: 0.28 };

export interface CameraState {
  position: Vec3;
  lookAt: Vec3;
  fov: number;
  roll: number;
  elapsed: number;
  initialized: boolean;
  /** Authored pose the opening dolly starts from. */
  home: Vec3;
  homeLookAt: Vec3;
}

export interface CameraView {
  position: Vec3;
  /** PlayCanvas-style Euler degrees (x pitch, y yaw, z roll). */
  rotationEuler: [number, number, number];
  fov: number;
}

export function cameraDef(properties: Record<string, unknown> | undefined): CameraDef {
  const def = { ...DEFAULT_CAMERA_DEF };
  if (!properties) return def;
  def.mode = properties.mode === 'follow' ? 'follow' : 'static';
  for (const key of ['distance', 'height', 'lag', 'intro', 'speedFov', 'lookAhead'] as const) {
    const value = properties[key];
    if (typeof value === 'number' && Number.isFinite(value)) def[key] = value;
  }
  return def;
}

export function createCameraState(position: Vec3, lookAt: Vec3, fov: number): CameraState {
  return {
    position: { ...position }, lookAt: { ...lookAt }, fov, roll: 0, elapsed: 0, initialized: false,
    home: { ...position }, homeLookAt: { ...lookAt },
  };
}

function smooth(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * Math.min(1, Math.max(0, rate) * dt);
}

function lerp(from: Vec3, to: Vec3, t: number): Vec3 {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
}

/**
 * Advances the camera. `yaw`/`pitch` come from the input layer (mouse/gamepad), `player` is
 * the simulated parkour state, and `speed`/`roll` drive the field of view and lean.
 */
export function stepCamera(
  state: CameraState,
  def: CameraDef,
  player: { position: Vec3; velocity: Vec3; headHeight: number },
  control: { yaw: number; pitch: number; speed: number; roll: number; baseFov: number },
  dt: number,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const pivot: Vec3 = {
    x: player.position.x,
    y: player.position.y + player.headHeight * 0.5 + def.height,
    z: player.position.z,
  };
  const cosPitch = Math.cos(control.pitch);
  const back: Vec3 = { x: -Math.sin(control.yaw) * cosPitch, y: Math.sin(control.pitch), z: -Math.cos(control.yaw) * cosPitch };
  const desired: Vec3 = {
    x: pivot.x + back.x * def.distance,
    y: pivot.y + back.y * def.distance,
    z: pivot.z + back.z * def.distance,
  };
  const lookAhead: Vec3 = {
    x: player.position.x + player.velocity.x * def.lookAhead,
    y: player.position.y + player.headHeight * 0.5 + player.velocity.y * def.lookAhead * 0.35,
    z: player.position.z + player.velocity.z * def.lookAhead,
  };

  if (!state.initialized) {
    // Opening frame holds the authored pose so the dolly below has somewhere to start.
    state.position = { ...state.home };
    state.lookAt = { ...state.homeLookAt };
    state.initialized = true;
  } else {
    state.elapsed += dt;
  }

  const rate = def.lag > 0 ? def.lag : 12;
  const intro = def.intro > 0 && state.elapsed < def.intro;
  if (intro) {
    // Cinematic dolly: ease from the authored pose into the follow pose, ignoring chase lag.
    const t = state.elapsed / def.intro;
    const ease = t * t * (3 - 2 * t);
    state.position = lerp(state.home, desired, ease);
    state.lookAt = lerp(state.homeLookAt, lookAhead, ease);
    state.roll = control.roll * ease;
  } else {
    state.position = {
      x: smooth(state.position.x, desired.x, rate, dt),
      y: smooth(state.position.y, desired.y, rate * 0.9, dt),
      z: smooth(state.position.z, desired.z, rate, dt),
    };
    // The look target snaps harder than the eye so fast motion still feels responsive.
    state.lookAt = {
      x: smooth(state.lookAt.x, lookAhead.x, rate * 2, dt),
      y: smooth(state.lookAt.y, lookAhead.y, rate * 1.6, dt),
      z: smooth(state.lookAt.z, lookAhead.z, rate * 2, dt),
    };
    state.roll = smooth(state.roll, control.roll, 6, dt);
  }
  const targetFov = control.baseFov + Math.max(0, Math.min(1, control.speed / 14)) * def.speedFov;
  state.fov = smooth(state.fov, targetFov, intro ? 2 : 4, dt);
}

/** Converts the smoothed camera state into an engine-ready pose. */
export function cameraView(state: CameraState): CameraView {
  const dx = state.lookAt.x - state.position.x;
  const dy = state.lookAt.y - state.position.y;
  const dz = state.lookAt.z - state.position.z;
  const horizontal = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horizontal);
  return {
    position: { ...state.position },
    rotationEuler: [pitch * 180 / Math.PI, yaw * 180 / Math.PI, state.roll * 180 / Math.PI],
    fov: state.fov,
  };
}

/** Chase yaw that keeps the camera behind the player when the mouse has not been touched. */
export function autoYaw(playerYaw: number, currentYaw: number, moving: boolean, dt: number, assist = 1.8): number {
  if (!moving) return currentYaw;
  let delta = playerYaw - currentYaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const maxStep = assist * dt * Math.min(1, Math.abs(delta));
  if (Math.abs(delta) <= maxStep) return playerYaw;
  return currentYaw + Math.sign(delta) * maxStep;
}
