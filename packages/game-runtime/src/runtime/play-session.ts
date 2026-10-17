import { Color, Group, MeshStandardMaterial, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';
import { SceneNode, disposeGraph, rotationDegrees, setRotationDegrees, setWorldPosition, setWorldRotationDegrees, isVisible } from '../core/projection.js';
import { createPhysicsWorld, type PhysicsWorld } from './physics.js';
import type { SceneDocument, ValidationContext } from '@forgon/project-schema';
import { projectScene } from '../core/reconcile.js';
import type { MaterialCache } from '../core/projection.js';
import type { AssetBytesResolver, RuntimeEvent } from '../core/types.js';
import { validatePlayableScene } from './validate.js';
import { createGuestMover, guestQueueDefinition, stepGuestMover } from './guest-queue.js';
import type { GuestMoverState, GuestQueueDefinition, GuestStepEvent } from './guest-queue.js';
import { buildParkourLevel, createInputState, createParkourState, stepParkour } from './parkour.js';
import type { ParkourEvent, ParkourInputState, ParkourLevel, ParkourState } from './parkour.js';
import { autoYaw, cameraDef, cameraView, createCameraState, stepCamera } from './camera-director.js';
import type { CameraDef, CameraState } from './camera-director.js';
import type { InputSample } from './input.js';
import type { HudSnapshot } from './hud.js';
import { createScriptHost, type ScriptHost } from '../scripting/host.js';
import type { ScriptModules } from '../scripting/index.js';

interface AudioChannel {
  entityId: string; buffer: AudioBuffer | null; volume: number; loop: boolean; autoplay: boolean; playing: boolean;
  /** Runtime event that fires this cue; `any` keeps the original play-on-any-event behaviour. */
  on: 'any' | 'arrival' | 'checkpoint' | 'goal' | 'death';
}
interface Pulse {
  entityId: string; entity: SceneNode; baseline: Vector3; duration: number; elapsed: number;
  material: MeshStandardMaterial; color: Color;
}
interface RigPart { entity: SceneNode; basePosition: SimpleVec; baseRotation: SimpleVec }
interface PlayerRig {
  root: SceneNode;
  baseScale: SimpleVec;
  legsLeft: RigPart[];
  legsRight: RigPart[];
  armsLeft: RigPart[];
  armsRight: RigPart[];
  head: RigPart[];
  torso: RigPart[];
}
interface SimpleVec { x: number; y: number; z: number }
interface ParkourRuntime {
  level: ParkourLevel;
  state: ParkourState;
  playerEntity: SceneNode;
  rig: PlayerRig;
  platformEntities: SceneNode[];
  cameraEntity: SceneNode | null;
  cameraDef: CameraDef;
  cameraState: CameraState | null;
  cameraYaw: number;
  cameraPitch: number;
  baseFov: number;
  accumulator: number;
  hudTimer: number;
}

export interface PlaySession {
  start(scene: SceneDocument, scripts?: ScriptModules): void;
  stop(): void;
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  update(dt: number): void;
  /** Master gain for every cue started from now on; live cues update immediately. */
  setVolume(value: number): void;
  /** Freezes simulation and HUD time while the caller keeps rendering the last frame. */
  setPaused(value: boolean): void;
  /** Latest parkour HUD numbers, or null for a non-parkour scene. */
  getHud(): HudSnapshot | null;
  getCamera(): PerspectiveCamera | null;
  getPhysics(): PhysicsWorld | null;
  dispose(): void;
}

/** Physics step for the parkour controller; small and fixed for a deterministic feel. */
const FIXED_STEP = 1 / 120;
const MAX_STEPS = 12;

/** All state belongs to a detached play graph; stop destroys it, never writes authoring data. */
export function createPlaySession(deps: {
  world: Object3D; editRoot: Object3D; context?: ValidationContext | undefined;
  loadAssetBytes?: AssetBytesResolver | undefined;
  audioContext?: AudioContext | null;
  scripts?: ScriptModules | undefined;
  input?: { sample(dt: number): InputSample } | undefined;
  onRuntimeEvent(event: RuntimeEvent): void;
}): PlaySession {
  const { world, editRoot, loadAssetBytes, onRuntimeEvent: emit } = deps;
  let root: Group | null = null;
  let physics: PhysicsWorld | null = null;
  let materials: MaterialCache | undefined;
  let movers: { entityId: string; entity: SceneNode; state: GuestMoverState; definition: GuestQueueDefinition }[] = [];
  let channels: AudioChannel[] = [];
  let pulses: Pulse[] = [];
  let context: AudioContext | null = null;
  let ownsContext = false;
  let masterVolume = 1;
  let paused = false;
  let generation = 0;
  let parkour: ParkourRuntime | null = null;
  let hud: HudSnapshot | null = null;
  let activeCamera: PerspectiveCamera | null = null;
  let scriptHost: ScriptHost | null = null;
  let inputFrame: InputSample | null = null;
  const actionDown = (name: string): boolean => {
    const state = inputFrame?.state;
    if (!state) return false;
    switch (name) {
      case 'jump': return state.jumpHeld || state.jump;
      case 'slide': return state.slide;
      case 'restart': return inputFrame?.restart === true;
      case 'sprint': return state.sprint;
      case 'left': return state.moveX < 0;
      case 'right': return state.moveX > 0;
      case 'forward': return state.moveZ > 0;
      case 'backward': return state.moveZ < 0;
      default: return false;
    }
  };
  let previousActions = new Set<string>();
  let pressedActions = new Set<string>();
  const sources = new Set<AudioBufferSourceNode>();
  /** Live cue gains, so a volume change reaches a looping cue already playing. */
  const liveGains = new Map<GainNode, number>();

  const playAudio = (channel: AudioChannel): void => {
    if (!context || !channel.buffer || (channel.loop && channel.playing)) return;
    if (context.state !== 'running') { emit({ type: 'audio', entityId: channel.entityId, status: 'unavailable', message: 'Browser audio is suspended; start play from a user gesture' }); return; }
    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = channel.buffer; source.loop = channel.loop; gain.gain.value = channel.volume * masterVolume;
      source.connect(gain).connect(context.destination);
      sources.add(source);
      liveGains.set(gain, channel.volume);
      source.onended = () => { channel.playing = false; sources.delete(source); liveGains.delete(gain); source.disconnect(); gain.disconnect(); };
      source.start(); channel.playing = true;
      emit({ type: 'audio', entityId: channel.entityId, status: 'played' });
    } catch (error) {
      emit({ type: 'audio', entityId: channel.entityId, status: 'error', message: String(error) });
    }
  };
  /** Plays the cues bound to a runtime event; `any` cues respond to every event. */
  const cue = (kind: Exclude<AudioChannel['on'], 'any'>): void => {
    for (const channel of channels) if (!channel.autoplay && (channel.on === 'any' || channel.on === kind)) playAudio(channel);
  };
  const triggerPulse = (pulse: Pulse, entityId: string): void => {
    pulse.elapsed = 0;
    emit({ type: 'vfx', entityId: pulse.entityId, waypointEntityId: entityId });
  };
  const pulseFor = (entityId: string): void => { for (const pulse of pulses) if (pulse.entityId === entityId) triggerPulse(pulse, entityId); };

  const mapParkourEvent = (runtime: ParkourRuntime, event: ParkourEvent): void => {
    const total = runtime.level.collectibles.length;
    switch (event.type) {
      case 'checkpoint':
        pulseFor(event.entityId);
        cue('checkpoint');
        emit({ type: 'checkpoint', entityId: event.entityId, index: event.index, total: runtime.level.checkpoints.length });
        break;
      case 'collect':
        pulseFor(event.entityId);
        emit({ type: 'collect', entityId: event.entityId, value: event.value, collected: runtime.state.collected.length, total });
        break;
      case 'goal':
        if (runtime.level.goal) pulseFor(runtime.level.goal.id);
        cue('goal');
        emit({ type: 'goal', time: event.time, deaths: event.deaths, collected: event.collected, total: event.total });
        break;
      case 'death': cue('death'); emit({ type: 'death', reason: event.reason, deaths: event.deaths }); break;
      case 'respawn': emit({ type: 'respawn', checkpointEntityId: event.checkpointEntityId, index: event.index }); break;
      case 'jump': emit({ type: 'jump', double: event.double }); break;
      case 'wall-run': emit({ type: 'wall-run', side: event.side }); break;
      case 'slide': emit({ type: 'slide' }); break;
      default: break;
    }
  };

  const stepSimulation = (runtime: ParkourRuntime, frame: InputSample, dt: number): number => {
    runtime.accumulator = Math.min(runtime.accumulator + dt, FIXED_STEP * MAX_STEPS);
    let index = 0;
    while (runtime.accumulator >= FIXED_STEP && index < MAX_STEPS) {
      const input: ParkourInputState = index === 0 ? frame.state : {
        ...createInputState(), moveX: frame.state.moveX, moveZ: frame.state.moveZ,
        jumpHeld: frame.state.jumpHeld, sprint: frame.state.sprint, cameraYaw: frame.state.cameraYaw,
      };
      const events: ParkourEvent[] = [];
      stepParkour(runtime.state, runtime.level, input, FIXED_STEP, events);
      for (const event of events) mapParkourEvent(runtime, event);
      runtime.accumulator -= FIXED_STEP;
      index++;
    }
    return index;
  };

  const drivePlayer = (runtime: ParkourRuntime): void => {
    const { state, rig } = runtime;
    const stretch = state.visual.stretch;
    const squash = 1 / Math.sqrt(Math.max(0.5, stretch));
    setWorldRotationDegrees(rig.root, state.visual.lean * 16, state.facing * 180 / Math.PI, state.visual.roll * 180 / Math.PI);
    rig.root.scale.set(rig.baseScale.x * squash, rig.baseScale.y * stretch, rig.baseScale.z * squash);
    setWorldPosition(rig.root, state.position.x, state.position.y, state.position.z);

    const run = Math.sin(state.visual.runPhase);
    const crouch = 1 - state.visual.stance;
    const airborne = !state.grounded;
    const swing = airborne ? 0.45 : 1;
    const rot = (part: RigPart, x: number): void => setRotationDegrees(part.entity, part.baseRotation.x + x * 180 / Math.PI, part.baseRotation.y, part.baseRotation.z);
    for (const part of rig.legsLeft) rot(part, run * 0.95 * swing - crouch * 1.1);
    for (const part of rig.legsRight) rot(part, -run * 0.95 * swing - crouch * 1.1);
    for (const part of rig.armsLeft) rot(part, -run * 1.0 * swing - (airborne ? 0.9 : 0));
    for (const part of rig.armsRight) rot(part, run * 1.0 * swing - (airborne ? 0.9 : 0));
    for (const part of rig.torso) rot(part, airborne ? -0.16 : -0.28);
    for (const part of rig.head) rot(part, airborne ? 0.02 : 0.08);
  };

  const driveCamera = (runtime: ParkourRuntime, frame: InputSample, dt: number): void => {
    const camera = runtime.cameraEntity;
    if (!camera || runtime.cameraDef.mode !== 'follow' || !runtime.cameraState) return;
    const intro = runtime.cameraDef.intro > 0 && runtime.cameraState.elapsed < runtime.cameraDef.intro;
    runtime.cameraYaw = frame.manual ? frame.yaw : autoYaw(runtime.state.facing, runtime.cameraYaw, runtime.state.visual.moving || intro, dt, intro ? 3.2 : 1.8);
    runtime.cameraPitch = frame.pitch;
    stepCamera(runtime.cameraState, runtime.cameraDef, {
      position: runtime.state.position, velocity: runtime.state.velocity, headHeight: runtime.level.config.height,
    }, { yaw: runtime.cameraYaw, pitch: runtime.cameraPitch, speed: runtime.state.speed, roll: runtime.state.visual.roll * 0.5, baseFov: runtime.baseFov }, dt);
    const view = cameraView(runtime.cameraState);
    setWorldPosition(camera, view.position.x, view.position.y, view.position.z);
    setWorldRotationDegrees(camera, view.rotationEuler[0], view.rotationEuler[1], view.rotationEuler[2]);
    if (camera.camera) { camera.camera.fov = view.fov; camera.camera.updateProjectionMatrix(); }
  };

  const updateHud = (runtime: ParkourRuntime, dt: number): void => {
    hud = {
      time: runtime.state.time, deaths: runtime.state.deaths,
      collected: runtime.state.collected.length, total: runtime.level.collectibles.length,
      checkpointIndex: runtime.state.checkpointIndex, checkpointTotal: runtime.level.checkpoints.length,
      speed: runtime.state.speed, grounded: runtime.state.grounded,
      finished: runtime.state.finished, finishTime: runtime.state.finishTime,
    };
    runtime.hudTimer -= dt;
    if (runtime.hudTimer <= 0) { runtime.hudTimer = 0.1; emit({ type: 'hud', hud: { ...hud } }); }
  };

  const session: PlaySession = {
    get isPlaying() { return root !== null; },
    get isPaused() { return paused; },
    setVolume(value): void {
      masterVolume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
      for (const [gain, volume] of liveGains) gain.gain.value = volume * masterVolume;
    },
    setPaused(value): void { paused = value === true; },
    getHud: () => hud,
    getCamera: () => activeCamera,
    getPhysics: () => physics,
    start(scene, scripts = deps.scripts ?? {}): void {
      const snapshot = validatePlayableScene(scene, deps.context);
      session.stop();
      const token = ++generation;
      const nextRoot = new Group();
      nextRoot.name = 'Forgon Play Snapshot';
      world.add(nextRoot);
      try {
        const projection = projectScene(nextRoot, snapshot, true);
        materials = projection.materials;
        root = nextRoot;
        const registry = projection.registry;
        physics = createPhysicsWorld(nextRoot);
        activeCamera = [...registry.byId.values()].find(node => node.camera && isVisible(node) && node.camera.visible)?.camera ?? null;
        editRoot.visible = false;
        const hasAudio = snapshot.entities.some(e => e.components.some(c => c.type === 'audio' && c.enabled));
        context = hasAudio ? deps.audioContext ?? (typeof AudioContext === 'undefined' ? null : new AudioContext()) : null;
        ownsContext = hasAudio && deps.audioContext === undefined;
        paused = false;
        if (context?.state === 'suspended') void context.resume().catch(error => emit({ type: 'fault', message: `Audio resume failed: ${String(error)}` }));
        const level = buildParkourLevel(snapshot);
        for (const definition of snapshot.entities) {
          const entity = registry.byId.get(definition.id)!;
          if (!isVisible(entity)) continue;
          for (const component of definition.components) {
            if (!component.enabled) continue;
            const p = component.properties;
            if (component.type === 'guestQueue') {
              const queue = guestQueueDefinition(p, id => {
                const point = registry.byId.get(id)!.getWorldPosition(new Vector3());
                return { x: point.x, y: point.y, z: point.z };
              })!;
              movers.push({ entityId: definition.id, entity, definition: queue, state: createGuestMover(queue, entity.getWorldPosition(new Vector3())) });
            }
            if (component.type === 'vfx' && entity.render) {
              const material = (entity.render.material as MeshStandardMaterial).clone();
              entity.render.material = material;
              const color = p.color as number[] | undefined;
              const pulse: Pulse = { entityId: definition.id, entity, material, color: new Color(...(color ?? [1, 0.75, 0.3]) as [number, number, number]),
                baseline: entity.scale.clone(), duration: Number(p.duration ?? 0.5), elapsed: Infinity };
              pulses.push(pulse);
              if (p.autoplay === true) triggerPulse(pulse, definition.id);
            }
            if (component.type === 'audio') {
              const trigger = p.on === 'arrival' || p.on === 'checkpoint' || p.on === 'goal' || p.on === 'death' ? p.on : 'any';
              const channel: AudioChannel = { entityId: definition.id, buffer: null, volume: Number(p.volume ?? 0.25), loop: p.loop === true, autoplay: p.autoplay === true, playing: false, on: trigger };
              channels.push(channel);
              if (!context || !loadAssetBytes) {
                emit({ type: 'audio', entityId: definition.id, status: 'unavailable', message: 'AudioContext or asset-byte resolver unavailable' });
                continue;
              }
              const audioContext = context;
              void Promise.resolve(loadAssetBytes(String(p.assetId))).then(async bytes => {
                if (token !== generation) return;
                if (!bytes) throw new Error(`Audio bytes unavailable: ${String(p.assetId)}`);
                const buffer = await audioContext.decodeAudioData(Uint8Array.from(bytes).buffer);
                if (token !== generation) return;
                channel.buffer = buffer;
                if (channel.autoplay) playAudio(channel);
              }).catch(error => {
                if (token === generation) emit({ type: 'audio', entityId: definition.id, status: 'error', message: String(error) });
              });
            }
          }
        }
        if (level) {
          const definition = snapshot.entities.find(entity => entity.id === level.playerId)!;
          const playerEntity = registry.byId.get(level.playerId)!;
          const cameraEntity = snapshot.entities.find(entity => registry.byId.get(entity.id)?.camera === activeCamera);
          const cameraComponent = cameraEntity?.components.find(component => component.type === 'camera' && component.enabled);
          const runtime: ParkourRuntime = {
            level, state: createParkourState(level), playerEntity,
            rig: captureRig(playerEntity, definition.transform.scale),
            platformEntities: level.platforms.map(platform => registry.byId.get(platform.id)!),
            cameraEntity: cameraEntity ? registry.byId.get(cameraEntity.id)! : null,
            cameraDef: cameraDef(cameraComponent?.properties), cameraState: null,
            cameraYaw: level.spawnFacing, cameraPitch: 0.16,
            baseFov: typeof cameraComponent?.properties.fov === 'number' ? cameraComponent.properties.fov : 50,
            accumulator: 0, hudTimer: 0,
          };
          if (runtime.cameraEntity) {
            const position = runtime.cameraEntity.getWorldPosition(new Vector3());
            runtime.cameraState = createCameraState(
              { x: position.x, y: position.y, z: position.z },
              { x: runtime.state.position.x, y: runtime.state.position.y + 1, z: runtime.state.position.z },
              runtime.baseFov,
            );
          }
          parkour = runtime;
          updateHud(runtime, 0);
        }
        scriptHost = createScriptHost({ scene: snapshot, entities: registry.byId, scripts,
          input: {
            down: name => inputFrame?.keysDown?.includes(name) === true || actionDown(name),
            pressed: name => inputFrame?.keysPressed?.includes(name) === true || pressedActions.has(name),
          },
          onFault: message => emit({ type: 'fault', message }), log: message => console.info(message),
        });
        emit({ type: 'play-started' });
      } catch (error) { disposeGraph(nextRoot); session.stop(); throw error; }
    },
    update(dt): void {
      if (!root || paused || !Number.isFinite(dt) || dt <= 0) return;
      inputFrame = deps.input?.sample(dt) ?? null;
      const actions = new Set(['jump', 'sprint', 'left', 'right', 'forward', 'backward'].filter(actionDown));
      pressedActions = new Set([...actions].filter(name => !previousActions.has(name)));
      if (inputFrame?.state.jump) pressedActions.add('jump');
      if (inputFrame?.state.slide) pressedActions.add('slide');
      if (inputFrame?.restart) pressedActions.add('restart');
      previousActions = actions;
      scriptHost?.update(dt);
      for (const mover of movers) {
        const events: GuestStepEvent[] = [];
        stepGuestMover(mover.state, mover.definition, dt, events);
        const p = mover.state.position;
        setWorldPosition(mover.entity, p.x, p.y, p.z);
        for (const event of events) {
          if (event.type !== 'arrival') continue;
          const waypointEntityId = mover.definition.waypointIds[event.waypointIndex]!;
          emit({ type: 'arrival', entityId: mover.entityId, waypointEntityId });
          for (const pulse of pulses) triggerPulse(pulse, waypointEntityId);
          cue('arrival');
        }
      }
      for (const pulse of pulses) {
        if (pulse.elapsed >= pulse.duration) continue;
        pulse.elapsed = Math.min(pulse.duration, pulse.elapsed + dt);
        const strength = Math.sin(Math.PI * pulse.elapsed / pulse.duration);
        pulse.entity.scale.copy(pulse.baseline).multiplyScalar(1 + strength * 0.25);
        pulse.material.emissive.copy(pulse.color).multiplyScalar(strength);

      }
      physics?.sync();
      if (!parkour) return;
      const frame: InputSample = inputFrame ?? { state: createInputState(), yaw: parkour.cameraYaw, pitch: parkour.cameraPitch, manual: false, restart: false };
      if (frame.restart) {
        parkour = { ...parkour, state: createParkourState(parkour.level), accumulator: 0 };
        const spawn = parkour.level.checkpoints.find(checkpoint => checkpoint.spawn);
        emit({ type: 'respawn', checkpointEntityId: spawn?.id ?? '', index: parkour.state.checkpointIndex });
        updateHud(parkour, 0);
      }
      if (!stepSimulation(parkour, frame, dt)) return;
      drivePlayer(parkour);
      driveCamera(parkour, frame, dt);
      for (const [index, entity] of parkour.platformEntities.entries()) {
        const motion = parkour.state.platforms[index]!;
        setWorldPosition(entity, motion.position.x, motion.position.y, motion.position.z);
      }
      physics?.sync();
      updateHud(parkour, dt);
    },
    stop(): void {
      generation++;
      const wasPlaying = root !== null;
      scriptHost?.stop(); scriptHost = null;
      inputFrame = null; previousActions.clear(); pressedActions.clear();
      for (const source of sources) source.stop();
      sources.clear(); liveGains.clear();
      if (ownsContext && context && context.state !== 'closed') void context.close().catch(() => undefined);
      context = null; ownsContext = false;
      physics?.dispose(); physics = null;
      if (root) disposeGraph(root); root = null; activeCamera = null;
      for (const pulse of pulses) pulse.material.dispose();
      materials?.dispose(); materials = undefined;
      movers = []; channels = []; pulses = []; parkour = null; hud = null;
      editRoot.visible = true;
      if (wasPlaying) emit({ type: 'play-stopped' });
    },
    dispose(): void { session.stop(); },
  };
  return session;
}

/** Captures the authored pose of the player's limb children so animation can offset from it. */
function captureRig(root: SceneNode, authoredScale: readonly [number, number, number]): PlayerRig {
  const legsLeft: RigPart[] = []; const legsRight: RigPart[] = [];
  const armsLeft: RigPart[] = []; const armsRight: RigPart[] = [];
  const head: RigPart[] = []; const torso: RigPart[] = [];
  for (const child of root.children.filter((child): child is SceneNode => child instanceof SceneNode)) {
    const part: RigPart = {
      entity: child,
      basePosition: vecOf(child.position),
      baseRotation: vecOf(rotationDegrees(child)),
    };
    const name = child.name.toLowerCase();
    const isLeft = /(^|[^a-z])l([^a-z]|$)/.test(name) || name.includes('left');
    if (name.includes('leg')) (isLeft ? legsLeft : legsRight).push(part);
    else if (name.includes('arm')) (isLeft ? armsLeft : armsRight).push(part);
    else if (name.includes('head')) head.push(part);
    else torso.push(part);
  }
  return { root, baseScale: { x: authoredScale[0], y: authoredScale[1], z: authoredScale[2] }, legsLeft, legsRight, armsLeft, armsRight, head, torso };
}

function vecOf(value: SimpleVec): SimpleVec { return { x: value.x, y: value.y, z: value.z }; }
