import { AnimationMixer, Box3, BoxGeometry, Group, InstancedMesh, Light, Line, LoadingManager, LoopOnce, LoopRepeat, Mesh, MeshBasicMaterial, Points, SkinnedMesh, Texture } from 'three';
import type { BufferGeometry, Material, Object3D, Skeleton } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetBytesResolver } from './types.js';

/** Reject resource URLs before GLTFLoader can fetch them, including optional extensions. */
function embeddedGlb(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteLength < 20 || bytes.byteLength > 32 * 1024 * 1024) throw new Error('Expected a GLB of at most 32 MiB');
  const buffer = Uint8Array.from(bytes).buffer;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength
    || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('Expected a GLB v2 container');
  const length = view.getUint32(12, true);
  if (length % 4 !== 0 || length > 2 * 1024 * 1024 || length + 20 > buffer.byteLength) throw new Error('Invalid GLB JSON chunk');
  const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 20, length)));
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 64) throw new Error('GLB JSON nesting exceeds 64');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri') throw new Error('GLB resource URLs are unsupported; embed buffers and images in the GLB');
      if (key === 'KHR_draco_mesh_compression') throw new Error('Draco-compressed GLB requires a decoder; Draco is unsupported');
      if (key === 'KHR_texture_basisu') throw new Error('KTX2/Basis textures require a transcoder; KTX2 is unsupported');
      if (key === 'EXT_meshopt_compression' || key === 'KHR_meshopt_compression') throw new Error('Meshopt-compressed GLB requires a decoder; Meshopt is unsupported');
      walk(child, depth + 1);
    }
  };
  walk(json);
  return buffer;
}

/** Clones share GPU resources; only the last asset user releases the parsed template. */
function disposeModel(scenes: readonly Object3D[]): void {
  const geometries = new Set<BufferGeometry>(); const materials = new Set<Material>(); const textures = new Set<Texture>();
  for (const scene of scenes) scene.traverse(node => {
    if (!(node instanceof Mesh || node instanceof Line || node instanceof Points)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) images.add(texture.image);
  }
  for (const image of images) image.close();
  for (const geometry of geometries) geometry.dispose();
  disposeInstanceResources(scenes);
}

function disposeInstanceResources(scenes: readonly Object3D[]): void {
  const skeletons = new Set<Skeleton>();
  const disposable = new Set<Light | InstancedMesh>();
  for (const scene of scenes) scene.traverse(node => {
    if (node instanceof SkinnedMesh) skeletons.add(node.skeleton);
    if (node instanceof Light || node instanceof InstancedMesh) disposable.add(node);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const node of disposable) node.dispose();
}

export interface ModelInstance {
  root: Group;
  /** Settles after attaching meshes or recording a fault; loading faults never reject. */
  ready: Promise<void>;
  dispose(): void;
}

interface CachedModel {
  users: number;
  ready: Promise<GLTF>;
  gltf?: GLTF;
  bounds?: Box3;
}

export function createModelCache(loadAssetBytes?: AssetBytesResolver, onChange?: () => void) {
  const entries = new Map<string, CachedModel>();
  const mixers = new Set<AnimationMixer>();
  let disposed = false;
  const loader = new GLTFLoader(new LoadingManager());
  // Embedded image bufferViews become local blob URLs inside GLTFLoader.
  loader.manager.setURLModifier(url => {
    if (!url.startsWith('blob:')) throw new Error('GLB external resource loading is disabled');
    return url;
  });
  const evict = (id: string, entry: CachedModel): void => {
    if (entries.get(id) === entry) entries.delete(id);
    if (entry.gltf) { disposeModel(entry.gltf.scenes); delete entry.gltf; }
  };
  return {
    get size() { return entries.size; },
    bounds(assetId: string): Box3 | null { return entries.get(assetId)?.bounds?.clone() ?? null; },
    instantiate(assetId: string, properties: Record<string, unknown>, enabled: boolean, onFault: (message: string) => void, play = false): ModelInstance {
      const root = new Group(); root.visible = enabled;
      const placeholder = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x909090, wireframe: true }));
      root.add(placeholder);
      let active = true; let content: Object3D | undefined; let placeholderReleased = false;
      let mixer: AnimationMixer | undefined;
      const report = (detail: string): void => {
        const message = `Model ${assetId}: ${detail}`;
        root.userData.modelFault = message; onFault(message);
      };
      const releasePlaceholder = (): void => {
        if (placeholderReleased) return; placeholderReleased = true;
        placeholder.removeFromParent(); placeholder.geometry.dispose(); placeholder.material.dispose();
      };
      let entry = entries.get(assetId);
      if (!entry) {
        entry = { users: 0, ready: Promise.resolve().then(async () => {
          if (disposed) throw new Error('Model cache is disposed');
          const bytes = await loadAssetBytes?.(assetId);
          if (!bytes) throw new Error('Asset bytes are unavailable');
          return loader.parseAsync(embeddedGlb(bytes), '');
        }) };
        const pending = entry;
        entry.ready = entry.ready.then(gltf => {
          if (pending.users === 0 || disposed) { disposeModel(gltf.scenes); return gltf; }
          pending.gltf = gltf;
          pending.bounds = new Box3().setFromObject(gltf.scene);
          return gltf;
        });
        entries.set(assetId, entry);
      }
      entry.users++;
      const retained = entry;
      const ready = entry.ready.then(gltf => {
        if (!active || disposed) return;
        content = clone(gltf.scene);
        content.traverse(node => {
          if (node instanceof Mesh) { node.castShadow = properties.castShadows !== false; node.receiveShadow = properties.receiveShadows !== false; }
        });
        releasePlaceholder(); root.add(content);
        if (play && typeof properties.animation === 'string') {
          const clip = gltf.animations.find(clip => clip.name === properties.animation);
          if (!clip) report(`Animation clip "${properties.animation}" was not found`);
          else {
            mixer = new AnimationMixer(content); mixers.add(mixer);
            const action = mixer.clipAction(clip);
            action.setLoop(properties.loop === true ? LoopRepeat : LoopOnce, properties.loop === true ? Infinity : 1);
            action.clampWhenFinished = properties.loop !== true; action.play();
          }
        }
        onChange?.();
      }).catch(error => {
        if (!active || disposed) return;
        placeholder.material.color.set(0xe56c63);
        report(error instanceof Error ? error.message : String(error)); onChange?.();
      });
      return { root, ready, dispose() {
        if (!active) return; active = false;
        releasePlaceholder();
        if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(content!); mixers.delete(mixer); }
        if (content) disposeInstanceResources([content]);
        root.removeFromParent(); root.clear();
        if (--retained.users === 0) evict(assetId, retained);
      } };
    },
    update(dt: number): void { for (const mixer of mixers) mixer.update(dt); },
    dispose(): void {
      if (disposed) return; disposed = true;
      for (const mixer of mixers) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); }
      mixers.clear();
      for (const [id, entry] of entries) evict(id, entry);
    },
  };
}

export type ModelCache = ReturnType<typeof createModelCache>;
