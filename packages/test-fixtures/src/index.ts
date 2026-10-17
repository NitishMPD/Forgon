import { parseScene, validateProject } from '@forgon/project-schema';
import type { AssetRegistry, CampaignDocument, Component, Entity, JsonValue, PrefabDocument, ProjectManifest, SceneDocument } from '@forgon/project-schema';
import { instantiatePrefab, SceneAuthor } from '@forgon/procedural-authoring';
import type { AuthoringArtifact, PrefabBindings } from '@forgon/procedural-authoring';
import { createRooftopRelayFixture } from './rooftop-relay.js';

export { createRooftopRelayFixture, relayChimeWav, relayLoopWav } from './rooftop-relay.js';

export interface ProjectFixture {
  manifest: ProjectManifest; scenes: SceneDocument[]; prefabs: PrefabDocument[]; assets: AssetRegistry;
  authoring: AuthoringArtifact; campaign?: CampaignDocument; files: Record<string, string | Uint8Array>;
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
export function receptionWav(): Uint8Array {  const rate = 22050; const count = rate / 5;
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

/** Rising two-note data cue: mono PCM16, 22050Hz, 0.3s. Original, synthesized here. */
export function sectorWav(): Uint8Array {
  const rate = 22050; const count = Math.round(rate * 0.3);
  const bytes = new Uint8Array(44 + count * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const time = i / rate;
    const step = time < 0.15 ? 0 : 1;
    const frequency = step === 0 ? 523.25 : 783.99;
    const envelope = Math.min(1, time / 0.012) * Math.exp(-(time - step * 0.15) * 6);
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * time) * envelope * 2600), true);
  }
  return bytes;
}

/** Vivid, fully saturated neon for a hue in 0..1, so a generated accent reads as a light source. */
function neon(hue: number): [number, number, number] {
  const position = (((hue % 1) + 1) % 1) * 6;
  const index = Math.floor(position); const fraction = position - index;
  const x = 1 - Math.abs((fraction % 2) - 1);
  const sectors: [number, number, number][] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]];
  const [r, g, b] = sectors[index % 6]!;
  return [0.16 + r * 0.8, 0.16 + g * 0.8, 0.2 + b * 0.8];
}

/** CSS hex for a linear 0..1 colour, used to keep the generated palette in step with the scene. */
function hex(rgb: readonly number[]): string {
  return `#${rgb.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Sector 07: one complete Vector-style 3D parkour course — blown-out white run surfaces and
 * flanking panels backlighting ink-black silhouette sides and a black runner. Six rooftop decks,
 * a wall-run chasm, a slide gate, a relay ferry and a rising lift, four checkpoint gates, eight
 * shards and three sentinel hazards, plus a cinematic follow camera. Deterministic from the seed.
 */
export function createSectorFixture(seed = 'forgon'): ProjectFixture {
  const author = new SceneAuthor('sector', seed);
  const root = author.entity('sector', 'Sector 07 relay course');
  const entities: Entity[] = [root];

  // Art direction: blown-out white run surfaces and flank panels; ink shows up only as silhouette
  // sides and occluders, with teal glass and amber hazard trim over the white sky.
  const shell: [number, number, number] = [0.05, 0.055, 0.075];
  const deckTint: [number, number, number] = [0.09, 0.1, 0.13];
  const surfaceTint: [number, number, number] = [0.92, 0.94, 0.965];
  const wallTint: [number, number, number] = [0.72, 0.78, 0.86];
  // The seed picks the course's signature neon accent (kept in the cold cyan-violet band).
  const edge: [number, number, number] = neon(0.5 + author.random('sector:accent:hue') * 0.25);
  const warm: [number, number, number] = [1, 0.74, 0.26];
  const dangerTint: [number, number, number] = [1, 0.14, 0.2];
  const shardTint: [number, number, number] = [0.42, 0.93, 1];
  const goalTint: [number, number, number] = [1, 0.79, 0.32];
  const gateTint: [number, number, number] = [1, 0.72, 0.3];
  const runner: [number, number, number] = [0.04, 0.045, 0.062];
  const runnerTrim: [number, number, number] = [0.055, 0.06, 0.08];
  const hurt: [number, number, number] = [0.05, 0.055, 0.075];

  const add = (key: string, name: string, position: [number, number, number], size: [number, number, number], tint: readonly number[], solid = true, parentId = root.id): Entity => {
    const entity = box(author, key, name, position, size, [...tint], parentId, solid);
    entities.push(entity); return entity;
  };
  /** Position-only marker used as a platform/gate anchor. */
  const marker = (key: string, name: string, position: [number, number, number]): Entity => {
    const entity = author.entity(key, name, root.id);
    entity.transform.position = position; entities.push(entity); return entity;
  };

  // --- the runner: an invisible root carrying the sim, six visible rig parts ------------------
  const player = author.entity('player', 'Runner', root.id);
  player.transform.position = [0, 1.06, -4];
  player.components.push(component(author, 'player', 'player', {
    runSpeed: 7.6, sprintSpeed: 12.4, gravity: 27, jumpVelocity: 10.5, doubleJumpVelocity: 9.2, maxJumps: 2,
    coyoteTime: 0.13, jumpBuffer: 0.16, wallRun: true, wallRunTime: 1.5, wallRunSpeed: 13,
    wallJumpUp: 10, wallJumpOut: 8, slide: true, slideTime: 0.75, slideHeight: 0.85,
    radius: 0.42, height: 1.85, fallLimit: -34, invulnerable: 0.6,
  }));
  entities.push(player);
  add('rig:torso', 'Torso', [0, 1.02, 0], [0.62, 0.72, 0.36], runner, false, player.id);
  add('rig:head', 'Head', [0, 1.6, 0], [0.34, 0.32, 0.34], runner, false, player.id);
  add('rig:arm:left', 'Left arm', [-0.44, 1.18, 0], [0.16, 0.62, 0.16], runnerTrim, false, player.id);
  add('rig:arm:right', 'Right arm', [0.44, 1.18, 0], [0.16, 0.62, 0.16], runnerTrim, false, player.id);
  add('rig:leg:left', 'Left leg', [-0.18, 0.48, 0], [0.22, 0.9, 0.22], hurt, false, player.id);
  add('rig:leg:right', 'Right leg', [0.18, 0.48, 0], [0.22, 0.9, 0.22], hurt, false, player.id);

  /** A blown-out white run surface cap on an ink deck; render-only, so the sim never sees it. */
  const cap = (key: string, deck: Entity): void => {
    const t = deck.transform;
    add(key, `${deck.name} surface`,
      [t.position[0], t.position[1] + t.scale[1] / 2 + 0.045, t.position[2]],
      [t.scale[0] * 0.98, 0.09, t.scale[2] * 0.98], surfaceTint, false);
  };

  // --- act 1: rooftop relay, 4-5m gaps with 0.5-1m rises --------------------------------------
  cap('roof:start:surface', add('roof:start', 'Entry rooftop', [0, 0, 0], [16, 2, 16], shell));
  cap('roof:a:surface', add('roof:a', 'Ferry rooftop', [0, 0, 17], [10, 2, 10], deckTint));
  cap('roof:b:surface', add('roof:b', 'Switchback rooftop', [0, 0.6, 31], [9, 2, 9], shell));
  cap('roof:c:surface', add('roof:c', 'Chasm launch', [0, 1.6, 45], [8, 2, 9], deckTint));
  add('edge:start', 'Entry lip', [0, 1.03, 7.85], [15.6, 0.08, 0.32], edge, false);
  add('edge:a', 'Ferry lip', [0, 1.03, 21.85], [9.6, 0.08, 0.32], edge, false);
  add('edge:b', 'Switchback lip', [0, 1.63, 35.35], [8.6, 0.08, 0.32], warm, false);

  // --- act 2: a 13m chasm with two flanking white panels and a rescue ferry --------------------
  add('wall:left', 'Chasm wall left', [-4.8, 5, 57], [1.2, 10, 17], wallTint);
  add('wall:right', 'Chasm wall right', [4.8, 5, 57], [1.2, 10, 17], wallTint);
  add('edge:wall:left', 'Left wall light line', [-4.16, 0.5, 57], [0.1, 0.28, 16.6], edge, false);
  add('edge:wall:right', 'Right wall light line', [4.16, 0.5, 57], [0.1, 0.28, 16.6], edge, false);
  cap('roof:d:surface', add('roof:d', 'Chasm landing', [0, 1.6, 67], [8, 2, 9], shell));
  add('edge:c', 'Chasm landing lip', [0, 2.63, 71.35], [7.6, 0.08, 0.32], warm, false);

  // --- act 3: raised slide run with a low gate ------------------------------------------------
  cap('catwalk:slide:surface', add('catwalk:slide', 'Slide run', [0, 3.1, 84], [7, 2, 22], deckTint));
  add('gate:bar', 'Slide gate', [0, 5.7, 84], [7.4, 1.2, 0.7], dangerTint);
  add('edge:slide:left', 'Slide run lip left', [-3.4, 4.13, 84], [0.3, 0.08, 21.6], edge, false);
  add('edge:slide:right', 'Slide run lip right', [3.4, 4.13, 84], [0.3, 0.08, 21.6], edge, false);
  add('edge:gate', 'Slide gate lip', [0, 5.06, 84], [7.4, 0.12, 0.7], warm, false);

  // --- act 4: rising relay lift onto the uplink terrace ---------------------------------------
  cap('roof:goal:surface', add('roof:goal', 'Uplink terrace', [0, 6.6, 106.5], [10, 2, 10], deckTint));
  add('edge:goal', 'Uplink lip', [0, 7.63, 101.6], [9.6, 0.08, 0.32], goalTint, false);

  // --- checkpoint gates (index 0 is the spawn) -------------------------------------------------
  const gate = (key: string, name: string, position: [number, number, number], index: number, isSpawn = false): Entity => {
    const entity = author.entity(key, name, root.id);
    entity.transform.position = position;
    entity.transform.scale = [0.7, 0.14, 0.7];
    entity.components.push(component(author, `${key}:render`, 'render', { primitive: 'box', color: gateTint, castShadows: false }));
    entity.components.push(component(author, `${key}:checkpoint`, 'checkpoint', {
      index, radius: 1.9, offsetY: 1.3, ...(isSpawn ? { spawn: true } : {}),
    }));
    entities.push(entity);
    for (const side of [-1, 1]) {
      add(`${key}:post:${side}`, `${name} post`, [position[0] + side * 1.6, position[1] + 1.45, position[2]], [0.26, 2.9, 0.26], gateTint, false);
    }
    return entity;
  };
  const spawnGate = gate('gate:spawn', 'Relay gate', [0, 1, -4], 0, true);
  gate('gate:a', 'Ferry gate', [0, 1, 20], 1);
  gate('gate:b', 'Launch gate', [0, 2.6, 47.5], 2);
  gate('gate:c', 'Slide gate', [0, 4.1, 90], 3);

  // --- data shards ------------------------------------------------------------------------------
  const shards: [string, [number, number, number]][] = [
    ['shard:start', [0, 2.2, 4]],
    ['shard:gap', [0, 3.1, 10]],
    ['shard:switchback', [0, 2.6, 31]],
    ['shard:switchback:left', [-3.6, 2.6, 31.5]],
    ['shard:chasm', [0, 4.6, 54]],
    ['shard:ferry', [0, 2.9, 56.5]],
    ['shard:tunnel', [0, 4.6, 85.5]],
    ['shard:uplink', [0, 8.6, 107]],
  ];
  for (const [key, position] of shards) {
    const shard = author.entity(key, 'Data shard', root.id);
    shard.transform.position = position;
    shard.transform.rotationEuler = [45, 0, 45];
    shard.transform.scale = [0.55, 0.55, 0.55];
    shard.components.push(component(author, `${key}:render`, 'render', { primitive: 'box', color: shardTint, castShadows: false }));
    shard.components.push(component(author, `${key}:collectible`, 'collectible', { value: 1, radius: 1.25, offsetY: 0 }));
    if (key === 'shard:start') {
      shard.components.push(component(author, `${key}:spinner`, 'script', { src: 'scripts/spinner.ts', params: { speed: 90 } }));
      shard.components.push(component(author, `${key}:bobber`, 'script', { src: 'scripts/bobber.ts', params: { amplitude: 0.25, frequency: 0.8 } }));
    }
    entities.push(shard);
  }

  // --- the uplink goal ---------------------------------------------------------------------------
  const goal = author.entity('goal:uplink', 'Uplink', root.id);
  goal.transform.position = [0, 9.2, 110.5];
  goal.transform.scale = [4, 3.2, 0.6];
  goal.components.push(component(author, 'goal:render', 'render', { primitive: 'box', color: goalTint, castShadows: false }));
  goal.components.push(component(author, 'goal', 'goal', { radius: 2.6, offsetY: -0.7 }));
  entities.push(goal);

  const camera = author.entity('camera', 'Relay camera');
  camera.transform.position = [0, 7.5, -14];
  camera.transform.rotationEuler = [-17, 0, 0];
  camera.components.push(component(author, 'camera', 'camera', {
    fov: 62, nearClip: 0.1, farClip: 600, clearColor: [0.82, 0.89, 0.95],
    mode: 'follow', distance: 8.2, height: 2, lag: 6.5, intro: 3.6, speedFov: 14, lookAhead: 0.3,
  }));
  entities.push(camera);
  const sun = author.entity('sun', 'Blown-out sun'); sun.transform.rotationEuler = [-54, 34, 0];
  sun.components.push(component(author, 'sun', 'light', { kind: 'directional', color: [1, 1, 1], intensity: 1.6, castShadows: true, range: 80 }));
  entities.push(sun);
  const fillStart = author.entity('fill:start', 'Entry fill'); fillStart.transform.position = [0, 7, 2];
  fillStart.components.push(component(author, 'fill:start', 'light', { kind: 'omni', color: [0.5, 0.85, 1], intensity: 1.4, castShadows: false, range: 30 }));
  entities.push(fillStart);
  const fillGoal = author.entity('fill:goal', 'Uplink fill'); fillGoal.transform.position = [0, 13, 108];
  fillGoal.components.push(component(author, 'fill:goal', 'light', { kind: 'omni', color: [1, 0.68, 0.3], intensity: 1.3, castShadows: false, range: 34 }));
  entities.push(fillGoal);

  // --- prefab: the relay lift, reused as the chasm ferry and the uplink lift ---------------------
  const liftAuthor = new SceneAuthor('sector-lift', seed);
  const liftDeck = box(liftAuthor, 'deck', 'Relay lift deck', [0, 0, 0], [5, 1, 5], [...deckTint], null);
  liftDeck.components.find(item => item.type === 'collision')!.properties.isTrigger = true;
  const liftAnchor = liftAuthor.entity('anchor', 'Relay lift anchor', liftDeck.id);
  const liftRail = box(liftAuthor, 'rail', 'Relay lift rim', [0, -0.62, 0], [4.6, 0.14, 4.6], [...edge], liftDeck.id, false);
  const liftMotion = component(liftAuthor, 'deck:motion', 'movingPlatform', { waypoints: [liftAnchor.id], speed: 2.2, mode: 'pingpong', wait: 1.4 }, [liftAnchor.id]);
  liftDeck.components.push(liftMotion);
  const liftPrefab: PrefabDocument = { schemaVersion: 1, prefabId: liftAuthor.id('prefab'), name: 'Original relay lift', rootId: liftDeck.id, entities: [liftDeck, liftAnchor, liftRail] };
  const liftBindings: PrefabBindings = { formatVersion: 1, prefabId: liftPrefab.prefabId, references: [
    { componentId: liftMotion.id, path: ['waypoints', 0], kind: 'entity' },
  ] };

  // --- prefab: the sentinel hazard pylon ---------------------------------------------------------
  const sentinelAuthor = new SceneAuthor('sector-sentinel', seed);
  const pylon = box(sentinelAuthor, 'pylon', 'Sentinel pylon', [0, 0, 0], [2, 1.5, 1.5], [...hurt], null);
  pylon.components.push(component(sentinelAuthor, 'pylon:hazard', 'hazard', { kind: 'plasma', halfExtents: [0.5, 0.5, 0.5] }));
  const sentinelCore = box(sentinelAuthor, 'core', 'Sentinel core', [0, 0, 0.78], [1.2, 0.9, 0.3], [...dangerTint], pylon.id, false);
  const sentinelPrefab: PrefabDocument = { schemaVersion: 1, prefabId: sentinelAuthor.id('prefab'), name: 'Original sentinel hazard', rootId: pylon.id, entities: [pylon, sentinelCore] };

  const instantiate = (prefab: PrefabDocument, key: string, bindings?: PrefabBindings): Entity => {
    const instance = instantiatePrefab(prefab, author.id(key), bindings, root.id);
    entities.push(...instance.entities);
    return instance.entities.find(entity => entity.prefab!.sourceEntityId === prefab.rootId)!;
  };
  /** Places a lift instance and rewires its platform path to two scene waypoints. */
  const placeLift = (key: string, from: Entity, to: Entity, speed: number, wait: number): Entity => {
    const platformRoot = instantiate(liftPrefab, key, liftBindings);
    platformRoot.name = `Relay lift ${key.split(':')[1]}`;
    platformRoot.transform.position = from.transform.position;
    const motion = platformRoot.components.find(item => item.type === 'movingPlatform')!;
    motion.properties.waypoints = [from.id, to.id];
    motion.properties.speed = speed; motion.properties.wait = wait;
    motion.entityRefs = [from.id, to.id];
    return platformRoot;
  };

  placeLift(
    'lift-instance:ferry',
    marker('lift:ferry:a', 'Ferry stop lower', [0, 1.6, 53]),
    marker('lift:ferry:b', 'Ferry stop upper', [0, 1.6, 60]),
    3, 1.2,
  );
  placeLift(
    'lift-instance:uplink',
    marker('lift:uplink:a', 'Uplink lift lower stop', [0, 3.6, 99]),
    marker('lift:uplink:b', 'Uplink lift upper stop', [0, 7.1, 99]),
    2.2, 1.4,
  );
  const sentinels: [string, [number, number, number]][] = [
    ['sentinel-instance:switchback', [-1.7, 2.35, 31]],
    ['sentinel-instance:slide', [2.2, 4.85, 78]],
    ['sentinel-instance:landing', [-2.3, 3.35, 67]],
  ];
  for (const [key, position] of sentinels) {
    const instance = instantiate(sentinelPrefab, key);
    instance.name = `Sentinel ${key.split(':')[1]}`;
    instance.transform.position = position;
  }

  const audioId = author.id('asset:relay-audio');
  spawnGate.components.push(component(author, 'gate:spawn:audio', 'audio', { assetId: audioId, autoplay: false, loop: false, volume: 0.3 }, [], [audioId]));

  const provenance = { source: 'Original Forgon fixture artwork, level design and synthesized audio; created for this repository', license: 'CC0-1.0', generator: 'forgon-sector-1.0.0' };
  const assets: AssetRegistry = { schemaVersion: 1, assets: [
    { id: audioId, name: 'Relay data cue', kind: 'audio', path: 'assets/relay.wav', provenance },
    { id: author.id('asset:mark'), name: 'Sector 07 wordmark source', kind: 'texture', path: 'assets/sector-mark.svg', provenance },
    { id: author.id('asset:palette'), name: 'Sector material palette', kind: 'material', path: 'assets/palette.json', provenance },
  ] };
  return finish(author, 'Sector 07', entities, [liftPrefab, sentinelPrefab], assets, {
    'scripts/spinner.ts': `import { defineScript, prop } from '@forgon/game-runtime/scripting';

export default defineScript({
  props: { speed: prop.number(90, { min: -360, max: 360, step: 5 }) },
  update(ctx, dt) {
    ctx.entity.rotateY(ctx.params.speed * Math.PI / 180 * dt);
  },
});
`,
    'scripts/bobber.ts': `import { defineScript, prop } from '@forgon/game-runtime/scripting';
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
`,
    'assets/relay.wav': sectorWav(),
    'assets/sector-mark.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="128" viewBox="0 0 512 128"><rect width="512" height="128" fill="#dfe8f2"/><path d="M40 34h44v60H40z" fill="none" stroke="${hex(edge)}" stroke-width="6"/><path d="M52 46h20v36H52z" fill="#0c0e13"/><text x="108" y="80" font-family="sans-serif" font-size="42" letter-spacing="6" fill="#12151c">SECTOR 07</text></svg>\n`,
    'assets/palette.json': json({ ink: '#0d0e13', deck: '#171921', surface: '#ebf0f6', wall: '#b8c7db', edge: hex(edge), warm: '#ffbd42', danger: '#ff2433', shard: '#6bedff', goal: '#ffc952', sky: '#d1e3f2' }),
    'assets/PROVENANCE.md': '# Original placeholder assets\nAuthor: Nitish\n\nAll Sector 07 geometry is authored as original primitives in the scene and prefab files. The Sector wordmark SVG, the material palette and the mathematically synthesized relay WAV were created for this repository, with no imported third-party artwork, audio or level data. These fixture assets are dedicated under CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/). The SVG uses a platform sans-serif font; no font file is distributed. Registry entries identify provenance. The SVG and palette are source placeholders; the scene uses inline primitive colors and does not claim texture/material import support.\n',
  }, [{ path: 'authoring/relay-lift.bindings.json', bindings: liftBindings }]);
}

export function createFixture(id: string, seed = 'forgon'): ProjectFixture {
  if (id === 'hotel') return createHotelFixture(seed);
  if (id === 'empty-3d') return createEmpty3dFixture(seed);
  if (id === 'sector') return createSectorFixture(seed);
  if (id === 'rooftop-relay') return createRooftopRelayFixture(seed);
  throw new Error(`Unavailable built-in generator: ${id}`);
}
