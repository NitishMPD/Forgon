// Browser input for the Sector demo: keyboard + mouse (pointer lock or drag), gamepad and a
// two-thumb touch layout. Produces the engine-free `ParkourInputState` the simulation
// consumes, plus the chase-camera yaw/pitch. Kept out of the simulation module so the whole
// course still runs headless in tests.

import { createInputState } from './parkour.js';
import type { ParkourInputState } from './parkour.js';

export interface InputSample {
  keysDown?: readonly string[];
  keysPressed?: readonly string[];
  state: ParkourInputState;
  /** Yaw the chase camera should adopt this frame, radians. */
  yaw: number;
  /** Pitch the chase camera should adopt this frame, radians. */
  pitch: number;
  /** True once the player has moved the camera manually; disables follow assist. */
  manual: boolean;
  /** True on the frame the restart control was pressed. */
  restart: boolean;
}

export interface InputSource {
  sample(dt: number): InputSample;
  /** Scale the look sensitivity at runtime; 1 keeps the authored default. */
  setSensitivity?(multiplier: number): void;
  dispose(): void;
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

interface TouchAxis { id: number; startX: number; startY: number; x: number; y: number; moved: number }

/** Attaches real listeners to `target`; `dispose` removes all of them. */
export function createInputSource(target: HTMLElement, options: { sensitivity?: number } = {}): InputSource {
  const pressed = new Set<string>();
  const edges = new Set<string>();
  let sensitivity = options.sensitivity ?? 0.0026;
  let jumpEdge = false;
  let slideEdge = false;
  let restartEdge = false;
  let yaw = 0;
  let pitch = 0.16;
  let manual = false;
  let locked = false;
  let dragging = false;
  let dragX = 0;
  let dragY = 0;
  let touchMove: TouchAxis | null = null;
  let touchLook: TouchAxis | null = null;
  let touchJumpEdge = false;
  const padScale = (): number => sensitivity / 0.0026;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) { if (SCROLL_KEYS.has(event.code)) event.preventDefault(); return; }
    if (!pressed.has(event.code)) edges.add(event.code);
    pressed.add(event.code);
    if (event.code === 'Space') jumpEdge = true;
    if (event.code === 'KeyC' || event.code === 'ControlLeft' || event.code === 'ControlRight') slideEdge = true;
    if (event.code === 'KeyR') restartEdge = true;
    if (SCROLL_KEYS.has(event.code)) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => { pressed.delete(event.code); };
  const onBlur = (): void => { pressed.clear(); edges.clear(); dragging = false; };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') { onTouchStart(event); return; }
    if (event.button !== 0) return;
    dragging = true; dragX = event.clientX; dragY = event.clientY;
    if (!locked && typeof target.requestPointerLock === 'function') { void Promise.resolve(target.requestPointerLock()).catch(() => undefined); }
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') { onTouchEnd(event); return; }
    dragging = false;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') { onTouchMove(event); return; }
    if (!locked && !dragging) return;
    yaw -= event.movementX * sensitivity;
    pitch -= event.movementY * sensitivity;
    pitch = Math.max(-0.55, Math.min(1.05, pitch));
    if (Math.abs(event.movementX) + Math.abs(event.movementY) > 1) manual = true;
  };
  const onLockChange = (): void => { locked = document.pointerLockElement === target; };

  const onTouchStart = (event: PointerEvent): void => {
    const rect = target.getBoundingClientRect();
    const axis: TouchAxis = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: 0 };
    if (event.clientX - rect.left < rect.width * 0.45 && !touchMove) touchMove = axis;
    else if (!touchLook) touchLook = axis;
    target.setPointerCapture?.(event.pointerId);
  };
  const onTouchMove = (event: PointerEvent): void => {
    const axis = touchMove?.id === event.pointerId ? touchMove : touchLook?.id === event.pointerId ? touchLook : null;
    if (!axis) return;
    const dx = event.clientX - axis.startX;
    const dy = event.clientY - axis.startY;
    axis.moved = Math.max(axis.moved, Math.hypot(dx, dy));
    if (axis === touchLook) {
      yaw -= (event.clientX - axis.x) * sensitivity * 1.4;
      pitch -= (event.clientY - axis.y) * sensitivity * 1.4;
      pitch = Math.max(-0.55, Math.min(1.05, pitch));
      if (Math.abs(event.clientX - axis.x) > 1) manual = true;
    }
    axis.x = event.clientX; axis.y = event.clientY;
  };
  const onTouchEnd = (event: PointerEvent): void => {
    const axis = touchMove?.id === event.pointerId ? touchMove : touchLook?.id === event.pointerId ? touchLook : null;
    if (!axis) return;
    if (axis === touchLook && axis.moved < 8) touchJumpEdge = true;
    if (axis === touchMove) touchMove = null; else touchLook = null;
  };

  target.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onLockChange);

  return {
    sample(): InputSample {
      const state = createInputState();
      for (const code of pressed) {
        const vector = MOVE_KEYS[code];
        if (vector) { state.moveX += vector[0]; state.moveZ += vector[1]; }
      }
      // Touch joystick: pull from the axis origin, capped to the unit circle.
      if (touchMove) {
        const dx = (touchMove.x - touchMove.startX) / 64;
        const dy = (touchMove.y - touchMove.startY) / 64;
        state.moveX += Math.max(-1, Math.min(1, dx));
        state.moveZ += Math.max(-1, Math.min(1, -dy));
      }
      const magnitude = Math.hypot(state.moveX, state.moveZ);
      if (magnitude > 1) { state.moveX /= magnitude; state.moveZ /= magnitude; }
      state.sprint = pressed.has('ShiftLeft') || pressed.has('ShiftRight') || touchMove !== null && touchMove.moved > 90;

      // Gamepad merges over keyboard.
      const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad || !pad.connected) continue;
        const lx = pad.axes[0] ?? 0; const ly = pad.axes[1] ?? 0;
        if (Math.abs(lx) > 0.15 || Math.abs(ly) > 0.15) { state.moveX = lx; state.moveZ = -ly; }
        const rx = pad.axes[2] ?? 0; const ry = pad.axes[3] ?? 0;
        if (Math.abs(rx) > 0.12 || Math.abs(ry) > 0.12) {
          yaw -= rx * 2.6 * padScale() * 0.016; pitch = Math.max(-0.55, Math.min(1.05, pitch - ry * 1.8 * padScale() * 0.016));
          manual = true;
        }
        if (pad.buttons[0]?.pressed && !jumpEdge) jumpEdge = true;
        if (pad.buttons[2]?.pressed && !slideEdge) slideEdge = true;
        if ((pad.buttons[7]?.value ?? 0) > 0.4) state.sprint = true;
        break;
      }

      state.jump = jumpEdge || touchJumpEdge;
      state.jumpHeld = pressed.has('Space') || touchMove !== null;
      state.slide = slideEdge;
      state.cameraYaw = yaw;
      jumpEdge = false; slideEdge = false; touchJumpEdge = false;
      const restart = restartEdge; restartEdge = false;
      const keysPressed = [...edges]; edges.clear();
      return { state, yaw, pitch, manual, restart, keysDown: [...pressed], keysPressed };
    },
    setSensitivity(multiplier: number): void {
      sensitivity = 0.0026 * (Number.isFinite(multiplier) ? Math.max(0.1, Math.min(5, multiplier)) : 1);
    },
    dispose(): void {
      target.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onLockChange);
      if (locked && document.exitPointerLock) document.exitPointerLock();
    },
  };
}
