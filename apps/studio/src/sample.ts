import { parseScene, type Entity, type SceneDocument } from '@forgon/project-schema';

// In-memory sample for trying the UI without a desktop host. It is never written to disk.
function entity(id: string, name: string, parentId: string | null, position: [number, number, number], components: Entity['components']): Entity {
  return {
    id,
    name,
    parentId,
    enabled: true,
    transform: { position, rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    components,
  };
}

function component(id: string, type: string, properties: Entity['components'][number]['properties']): Entity['components'][number] {
  return { id, type, enabled: true, properties, entityRefs: [], assetRefs: [] };
}

export function sampleScene(): SceneDocument {
  return parseScene({
    schemaVersion: 1,
    sceneId: 'scene_sample_lobby',
    name: 'Sample lobby (in memory)',
    entities: [
      entity('entity_sample_lobby', 'Lobby', null, [0, 0, 0], []),
      entity('entity_sample_camera', 'Main camera', 'entity_sample_lobby', [0, 3, 8], [component('component_sample_camera', 'camera', { fov: 45 })]),
      entity('entity_sample_light', 'Key light', 'entity_sample_lobby', [2, 4, 2], [component('component_sample_light', 'light', { intensity: 1.2 })]),
      entity('entity_sample_reception', 'Reception desk', 'entity_sample_lobby', [2, 0, 4], [component('component_sample_render', 'render', { mesh: 'box' })]),
      entity('entity_sample_queue', 'Guest queue', 'entity_sample_lobby', [-2, 0, 1], [component('component_sample_queue', 'queue', { capacity: 5, serviceSeconds: 3 })]),
      entity('entity_sample_guest', 'Guest', 'entity_sample_queue', [0, 0, 0.5], [component('component_sample_script', 'script', { src: 'scripts/GuestBrain.ts', params: {} })]),
    ],
  });
}
