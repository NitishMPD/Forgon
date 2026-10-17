import { Color, Entity, StandardMaterial, Vec3 } from 'playcanvas';
import type { Application } from 'playcanvas';
import type { SceneDocument, ValidationContext } from '@forgon/project-schema';
import { projectScene } from '../core/reconcile.js';
import type { MaterialCache } from '../core/projection.js';
import type { AssetBytesResolver, RuntimeEvent } from '../core/types.js';
import { validatePlayableScene } from './validate.js';
import { createGuestMover, guestQueueDefinition, stepGuestMover } from './guest-queue.js';
import type { GuestMoverState, GuestQueueDefinition, GuestStepEvent } from './guest-queue.js';

interface AudioChannel {
  entityId: string; buffer: AudioBuffer | null; volume: number; loop: boolean; autoplay: boolean; playing: boolean;
}
interface Pulse {
  entityId: string; entity: Entity; baseline: Vec3; duration: number; elapsed: number;
  material: StandardMaterial; color: Color;
}
export interface PlaySession {
  start(scene: SceneDocument): void;
  stop(): void;
  readonly isPlaying: boolean;
  update(dt: number): void;
  dispose(): void;
}

/** All state belongs to a detached play graph; stop destroys it, never writes authoring data. */
export function createPlaySession(deps: {
  app: Application; editRoot: Entity; context?: ValidationContext | undefined;
  loadAssetBytes?: AssetBytesResolver | undefined;
  audioContext?: AudioContext | null;
  onRuntimeEvent(event: RuntimeEvent): void;
}): PlaySession {
  const { app, editRoot, loadAssetBytes, onRuntimeEvent: emit } = deps;
  let root: Entity | null = null;
  let materials: MaterialCache | undefined;
  let movers: { entityId: string; entity: Entity; state: GuestMoverState; definition: GuestQueueDefinition }[] = [];
  let channels: AudioChannel[] = [];
  let pulses: Pulse[] = [];
  let context: AudioContext | null = null;
  let generation = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const playAudio = (channel: AudioChannel): void => {
    if (!context || !channel.buffer || (channel.loop && channel.playing)) return;
    if (context.state !== 'running') { emit({ type: 'audio', entityId: channel.entityId, status: 'unavailable', message: 'Browser audio is suspended; start play from a user gesture' }); return; }
    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = channel.buffer; source.loop = channel.loop; gain.gain.value = channel.volume;
      source.connect(gain).connect(context.destination);
      sources.add(source);
      source.onended = () => { channel.playing = false; sources.delete(source); source.disconnect(); gain.disconnect(); };
      source.start(); channel.playing = true;
      emit({ type: 'audio', entityId: channel.entityId, status: 'played' });
    } catch (error) {
      emit({ type: 'audio', entityId: channel.entityId, status: 'error', message: String(error) });
    }
  };
  const triggerPulse = (pulse: Pulse, waypointEntityId: string): void => {
    pulse.elapsed = 0;
    emit({ type: 'vfx', entityId: pulse.entityId, waypointEntityId });
  };
  const session: PlaySession = {
    get isPlaying() { return root !== null; },
    start(scene): void {
      const snapshot = validatePlayableScene(scene, deps.context);
      session.stop();
      const token = ++generation;
      const nextRoot = new Entity('Forgon Play Snapshot', app);
      app.root.addChild(nextRoot);
      try {
        const projection = projectScene(nextRoot, snapshot, true, app);
        materials = projection.materials;
        root = nextRoot;
        const registry = projection.registry;
        editRoot.enabled = false;
        const hasAudio = snapshot.entities.some(e => e.components.some(c => c.type === 'audio' && c.enabled));
        context = hasAudio ? deps.audioContext ?? (typeof AudioContext === 'undefined' ? null : new AudioContext()) : null;
        if (context?.state === 'suspended') void context.resume().catch(error => emit({ type: 'fault', message: `Audio resume failed: ${String(error)}` }));
        for (const definition of snapshot.entities) {
          const entity = registry.byId.get(definition.id)!;
          if (!entity.enabled) continue;
          for (const component of definition.components) {
            if (!component.enabled) continue;
            const p = component.properties;
            if (component.type === 'guestQueue') {
              const queue = guestQueueDefinition(p, id => {
                const point = registry.byId.get(id)!.getPosition();
                return { x: point.x, y: point.y, z: point.z };
              })!;
              movers.push({ entityId: definition.id, entity, definition: queue, state: createGuestMover(queue, entity.getPosition()) });
            }
            if (component.type === 'vfx' && entity.render) {
              const material = (entity.render.material as StandardMaterial).clone();
              entity.render.material = material;
              const color = p.color as number[] | undefined;
              const pulse: Pulse = { entityId: definition.id, entity, material, color: new Color(...(color ?? [1, 0.75, 0.3]) as [number, number, number]),
                baseline: entity.getLocalScale().clone(), duration: Number(p.duration ?? 0.5), elapsed: Infinity };
              pulses.push(pulse);
              if (p.autoplay === true) triggerPulse(pulse, definition.id);
            }
            if (component.type === 'audio') {
              const channel: AudioChannel = { entityId: definition.id, buffer: null, volume: Number(p.volume ?? 0.25), loop: p.loop === true, autoplay: p.autoplay === true, playing: false };
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
        emit({ type: 'play-started' });
      } catch (error) { nextRoot.destroy(); session.stop(); throw error; }
    },
    update(dt): void {
      if (!root || !Number.isFinite(dt) || dt <= 0) return;
      for (const mover of movers) {
        const events: GuestStepEvent[] = [];
        stepGuestMover(mover.state, mover.definition, dt, events);
        const p = mover.state.position;
        if (mover.entity.rigidbody) mover.entity.rigidbody.teleport(p.x, p.y, p.z);
        else mover.entity.setPosition(p.x, p.y, p.z);
        for (const event of events) {
          if (event.type !== 'arrival') continue;
          const waypointEntityId = mover.definition.waypointIds[event.waypointIndex]!;
          emit({ type: 'arrival', entityId: mover.entityId, waypointEntityId });
          for (const pulse of pulses) triggerPulse(pulse, waypointEntityId);
          for (const channel of channels) if (!channel.autoplay) playAudio(channel);
        }
      }
      for (const pulse of pulses) {
        if (pulse.elapsed >= pulse.duration) continue;
        pulse.elapsed = Math.min(pulse.duration, pulse.elapsed + dt);
        const strength = Math.sin(Math.PI * pulse.elapsed / pulse.duration);
        pulse.entity.setLocalScale(pulse.baseline.clone().mulScalar(1 + strength * 0.25));
        pulse.material.emissive.copy(pulse.color).mulScalar(strength);
        pulse.material.update();
      }
    },
    stop(): void {
      generation++;
      const wasPlaying = root !== null;
      for (const source of sources) source.stop();
      sources.clear();
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
      context = null;
      root?.destroy(); root = null;
      for (const pulse of pulses) pulse.material.destroy();
      materials?.dispose(); materials = undefined;
      movers = []; channels = []; pulses = [];
      editRoot.enabled = true;
      if (wasPlaying) emit({ type: 'play-stopped' });
    },
    dispose(): void { session.stop(); },
  };
  return session;
}
