import { parseScene, validateProject } from '@forgon/project-schema';
import type { AssetRegistry, Component, Entity, JsonValue, PrefabDocument, ProjectManifest, SceneDocument } from '@forgon/project-schema';
import { instantiatePrefab, SceneAuthor } from '@forgon/procedural-authoring';
import type { AuthoringArtifact, PrefabBindings } from '@forgon/procedural-authoring';

export interface ProjectFixture {
  manifest: ProjectManifest; scenes: SceneDocument[]; prefabs: PrefabDocument[]; assets: AssetRegistry;
  authoring: AuthoringArtifact; files: Record<string, string | Uint8Array>;
}
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function component(author: SceneAuthor, key: string, type: string, properties: Record<string, JsonValue>, entityRefs: string[] = [], assetRefs: string[] = []): Component {
  return { id: author.id(`component:${key}`), type, enabled: true, properties, entityRefs, assetRefs };
}
function box(author: SceneAuthor, key: string, name: string, position: [number, number, number], scale: [number, number, number], color: number[], parentId: string | null, collider = true): Entity {
  const entity = author.entity(key, name, parentId);
  entity.transform.position = position; entity.transform.scale = scale;
  entity.components.push(component(author, `${key}:render`, 'render', { primitive: 'box', color, castShadows: true }));
  if (collider) entity.components.push(component(author, `${key}:collision`, 'collision', { shape: 'box', halfExtents: [0.5, 0.5, 0.5], isTrigger: false }));
  return entity;
}
function cameraAndLights(author: SceneAuthor): Entity[] {
  const camera = author.entity('camera', 'Lobby camera');
  camera.transform.position = [12, 13, 16]; camera.transform.rotationEuler = [-32, 36, 0];
  camera.components.push(component(author, 'camera', 'camera', { fov: 50, nearClip: 0.1, farClip: 100, clearColor: [0.07, 0.09, 0.13] }));
  const sun = author.entity('sun', 'Warm daylight'); sun.transform.rotationEuler = [-55, 25, 0];
  sun.components.push(component(author, 'sun', 'light', { kind: 'directional', color: [1, 0.93, 0.8], intensity: 1.5, castShadows: true, range: 30 }));
  const fill = author.entity('fill', 'Reception fill'); fill.transform.position = [0, 4, -3];
  fill.components.push(component(author, 'fill', 'light', { kind: 'omni', color: [0.65, 0.8, 1], intensity: 1, castShadows: false, range: 18 }));
  return [camera, sun, fill];
}

/** Original short, quiet two-tone reception cue: mono PCM16, 22050Hz, 0.2s. */
export function receptionWav(): Uint8Array {
  const rate = 22050; const count = rate / 5;
  const bytes = new Uint8Array(44 + count * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const time = i / rate; const envelope = Math.sin(Math.PI * i / count) ** 2;
    view.setInt16(44 + i * 2, Math.round((Math.sin(2 * Math.PI * 660 * time) + Math.sin(2 * Math.PI * 880 * time)) * envelope * 1800), true);
  }
  return bytes;
}

function finish(author: SceneAuthor, name: string, entities: Entity[], prefabs: PrefabDocument[], assets: AssetRegistry, extra: Record<string, string | Uint8Array>, bindings: { path: string; bindings: PrefabBindings }[] = []): ProjectFixture {
  const scene = parseScene({ schemaVersion: 1, sceneId: author.id('scene'), name, entities }, { prefabs, assets: assets.assets });
  const manifest: ProjectManifest = { schemaVersion: 1, projectId: author.id('project'), name,
    startScene: scene.sceneId, scenes: [{ id: scene.sceneId, path: 'scenes/main.scene.json' }],
    prefabs: prefabs.map(prefab => ({ id: prefab.prefabId, path: `prefabs/${prefab.prefabId}.prefab.json` })), assetRegistry: 'assets/registry.json' };
  const authoring: AuthoringArtifact = { formatVersion: 1, generator: { id: author.namespace, version: '1.0.0', seed: author.seed }, base: scene, overrides: [], detached: [],
    prefabBindings: bindings.map(item => ({ prefabId: item.bindings.prefabId, path: item.path })) };
  validateProject({ manifest, scenes: [scene], prefabs, assets });
  const files: ProjectFixture['files'] = { ...extra, 'game.project.json': json(manifest), 'scenes/main.scene.json': json(scene), 'assets/registry.json': json(assets), 'authoring/generated.json': json(authoring) };
  for (const [index, prefab] of prefabs.entries()) files[manifest.prefabs[index]!.path] = json(prefab);
  for (const item of bindings) files[item.path] = json(item.bindings);
  return { manifest, scenes: [scene], prefabs, assets, authoring, files };
}

export function createEmpty3dFixture(seed = 'forgon'): ProjectFixture {
  const author = new SceneAuthor('empty-3d', seed);
  return finish(author, 'Empty 3D', cameraAndLights(author), [], { schemaVersion: 1, assets: [] }, {});
}

export function createHotelFixture(seed = 'forgon'): ProjectFixture {
  const author = new SceneAuthor('hotel', seed);
  const root = author.entity('lobby', 'Lantern House lobby');
  const entities: Entity[] = [root, ...cameraAndLights(author)];
  const add = (key: string, name: string, position: [number, number, number], scale: [number, number, number], color: number[], collider = true): Entity => {
    const entity = box(author, key, name, position, scale, color, root.id, collider); entities.push(entity); return entity;
  };
  add('floor', 'Terrazzo floor', [0, -0.15, 0], [18, 0.3, 16], [0.7, 0.73, 0.68]);
  add('wall:back', 'Back wall', [0, 1.5, -8], [18, 3, 0.2], [0.84, 0.79, 0.68]);
  add('wall:left', 'Left wall', [-9, 1.5, 0], [0.2, 3, 16], [0.84, 0.79, 0.68]);
  add('wall:right', 'Right wall', [9, 1.5, 0], [0.2, 3, 16], [0.84, 0.79, 0.68]);
  add('wall:front:left', 'Entrance left wall', [-6, 1.5, 8], [6, 3, 0.2], [0.84, 0.79, 0.68]);
  add('wall:front:right', 'Entrance right wall', [6, 1.5, 8], [6, 3, 0.2], [0.84, 0.79, 0.68]);
  const reception = add('reception', 'Reception desk', [0, 0.6, -4.5], [5, 1.2, 1.4], [0.28, 0.38, 0.33]);
  add('counter', 'Reception counter', [0, 1.25, -4.5], [5.3, 0.15, 1.6], [0.86, 0.67, 0.38]);
  add('sign', 'Lantern House sign', [0, 2.2, -7.8], [4, 0.8, 0.1], [0.86, 0.67, 0.38], false);
  for (let i = 0; i < 6; i++) add(`seat:${i}`, `Lounge seat ${i + 1}`, [i < 3 ? -6 : 6, 0.45, (i % 3) * 2 - 2], [1.2, 0.9, 1.2], [0.31, 0.43, 0.5]);
  for (let i = 0; i < 4; i++) {
    const x = i % 2 ? 7 : -7; const z = i < 2 ? -6 : 6;
    add(`pot:${i}`, `Planter ${i + 1}`, [x, 0.35, z], [0.8, 0.7, 0.8], [0.51, 0.29, 0.2]);
    add(`plant:${i}`, `Plant canopy ${i + 1}`, [x, 1.1, z], [1, 0.9, 1], [0.18, 0.4, 0.26], false);
  }
  const waypoints = Array.from({ length: 5 }, (_, i) => {
    const waypoint = author.entity(`queue:${i}`, `Queue waypoint ${i + 1}`, root.id);
    waypoint.transform.position = [0, 0.9, 5 - i * 1.6]; entities.push(waypoint); return waypoint.id;
  });
  const guestAuthor = new SceneAuthor('hotel-guest-prefab', seed);
  const body = box(guestAuthor, 'body', 'Guest body', [0, 0.9, 0], [0.6, 1.2, 0.5], [0.7, 0.35, 0.22], null);
  const head = box(guestAuthor, 'head', 'Guest head', [0, 0.7, 0], [0.7, 0.4, 0.8], [0.78, 0.58, 0.41], body.id, false);
  const bag = box(guestAuthor, 'bag', 'Travel bag', [0.8, -0.2, 0], [0.4, 0.55, 0.5], [0.2, 0.24, 0.29], body.id, false);
  const queue = component(guestAuthor, 'queue', 'guestQueue', { waypoints: [body.id], speed: 1.2, arrivalRadius: 0.15, loop: true, visualComponentId: body.components[0]!.id }, [body.id]);
  body.components.push(queue);
  const prefab: PrefabDocument = { schemaVersion: 1, prefabId: guestAuthor.id('prefab'), name: 'Original traveler', rootId: body.id, entities: [body, head, bag] };
  const bindings: PrefabBindings = { formatVersion: 1, prefabId: prefab.prefabId, references: [
    { componentId: queue.id, path: ['waypoints', 0], kind: 'entity' },
    { componentId: queue.id, path: ['visualComponentId'], kind: 'component' },
  ] };
  for (let i = 0; i < 5; i++) {
    const instance = instantiatePrefab(prefab, author.id(`guest-instance:${i}`), bindings, root.id);
    const guest = instance.entities.find(entity => entity.prefab!.sourceEntityId === prefab.rootId)!;
    guest.name = `Guest ${i + 1}`; guest.transform.position = [0, 0.9, 5 - i * 1.6];
    const render = guest.components.find(item => item.type === 'render')!;
    render.properties.color = [0.35 + author.random(`guest:${i}:red`) * 0.4, 0.3, 0.45];
    const behavior = guest.components.find(item => item.type === 'guestQueue')!;
    behavior.properties.waypoints = [...waypoints.slice(i), ...waypoints.slice(0, i)]; behavior.entityRefs = [...waypoints];
    entities.push(...instance.entities);
  }
  const audioId = author.id('asset:reception-audio');
  reception.components.push(component(author, 'reception:audio', 'audio', { assetId: audioId, autoplay: false, loop: false, volume: 0.25 }, [], [audioId]));
  reception.components.push(component(author, 'reception:vfx', 'vfx', { kind: 'arrivalPulse', color: [1, 0.75, 0.3], duration: 0.5, autoplay: false }));
  const provenance = { source: 'Original Forgon fixture artwork and synthesized audio; created for this repository', license: 'CC0-1.0', generator: 'forgon-hotel-1.0.0' };
  const assets: AssetRegistry = { schemaVersion: 1, assets: [
    { id: audioId, name: 'Reception chime', kind: 'audio', path: 'assets/reception.wav', provenance },
    { id: author.id('asset:sign'), name: 'Lantern House sign source', kind: 'texture', path: 'assets/lantern-house.svg', provenance },
    { id: author.id('asset:palette'), name: 'Lobby primitive palette', kind: 'material', path: 'assets/palette.json', provenance },
  ] };
  return finish(author, 'Lantern House Hotel', entities, [prefab], assets, {
    'assets/reception.wav': receptionWav(),
    'assets/lantern-house.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="128" viewBox="0 0 512 128"><rect width="512" height="128" fill="#2b463b"/><path d="M42 30h36v64H42zM50 20h20v10H50z" fill="#dbab61"/><text x="108" y="78" font-family="sans-serif" font-size="36" fill="#f6edcf">LANTERN HOUSE</text></svg>\n',
    'assets/palette.json': json({ floor: '#b3baad', walls: '#d6c9ad', desk: '#476154', brass: '#dbab61' }),
    'assets/PROVENANCE.md': '# Original placeholder assets\nAuthor: Nitish\n\nAll geometry is authored as original primitives in the scene/prefab files. The Lantern House SVG, palette and mathematically synthesized two-tone WAV were created for this repository, with no imported third-party artwork or audio. These fixture assets are dedicated under CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). The SVG uses a platform sans-serif font; no font file is distributed. Registry entries identify provenance. The SVG and palette are source placeholders; the scene uses inline primitive colors and does not claim texture/material import support.\n',
  }, [{ path: 'authoring/guest.bindings.json', bindings }]);
}

export function createFixture(id: string, seed = 'forgon'): ProjectFixture {
  if (id === 'hotel') return createHotelFixture(seed);
  if (id === 'empty-3d') return createEmpty3dFixture(seed);
  throw new Error(`Unavailable built-in generator: ${id}`);
}
