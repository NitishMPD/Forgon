import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(jsonValueSchema),
]));
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const relativePathSchema = z.string().min(1).refine(path =>
  !/[\\:\u0000]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
'Expected a project-relative POSIX path');
const name = z.string().min(1).refine(value => value.trim().length > 0, 'Name cannot be blank');
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const transformSchema = z.object({ position: vec3, rotationEuler: vec3, scale: vec3 }).strict();
export const scriptPathSchema = relativePathSchema.refine(path => path.startsWith('scripts/') && path.endsWith('.ts'), 'Expected scripts/<name>.ts');
export const scriptPropertiesSchema = z.object({ src: scriptPathSchema, params: z.record(jsonValueSchema) }).strict();
export const componentSchema = z.object({
  id: idSchema, type: name, enabled: z.boolean(), properties: z.record(jsonValueSchema),
  entityRefs: z.array(idSchema), assetRefs: z.array(idSchema),
}).strict().superRefine((component, ctx) => {
  if (component.type === 'model') {
    if (component.assetRefs.length !== 1) ctx.addIssue({ code: 'custom', path: ['assetRefs'], message: 'Model requires exactly one GLB asset reference' });
    for (const key of ['castShadows', 'receiveShadows', 'loop']) {
      if (component.properties[key] !== undefined && typeof component.properties[key] !== 'boolean') ctx.addIssue({ code: 'custom', path: ['properties', key], message: 'Expected a boolean' });
    }
    if (component.properties.animation !== undefined && (typeof component.properties.animation !== 'string' || !component.properties.animation.trim())) ctx.addIssue({ code: 'custom', path: ['properties', 'animation'], message: 'Expected an animation clip name' });
  }
  if (component.type !== 'script') return;
  const result = scriptPropertiesSchema.safeParse(component.properties);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['properties', ...issue.path] });
});
export const prefabInstanceSchema = z.object({
  prefabId: idSchema, instanceId: idSchema, sourceEntityId: idSchema,
}).strict();
export const entitySchema = z.object({
  id: idSchema, name, parentId: idSchema.nullable(), enabled: z.boolean(), transform: transformSchema,
  components: z.array(componentSchema), prefab: prefabInstanceSchema.optional(),
}).strict();
export const sceneSchema = z.object({
  schemaVersion: z.literal(1), sceneId: idSchema, name, entities: z.array(entitySchema),
}).strict();
export const prefabSchema = z.object({
  schemaVersion: z.literal(1), prefabId: idSchema, name, rootId: idSchema, entities: z.array(entitySchema),
}).strict();
export const assetSchema = z.object({
  id: idSchema, name, kind: z.enum(['model', 'texture', 'audio', 'material', 'script', 'other']),
  path: relativePathSchema,
  provenance: z.object({ source: name, license: name, generator: name.optional(), hash: name.optional() }).strict().optional(),
}).strict();
export const assetRegistrySchema = z.object({ schemaVersion: z.literal(1), assets: z.array(assetSchema) }).strict();
/** One playable course in a campaign. Medal times are seconds; gold must be the fastest. */
export const campaignCourseSchema = z.object({
  sceneId: idSchema, name, subtitle: name,
  goldSeconds: z.number().finite().positive(),
  silverSeconds: z.number().finite().positive(),
  bronzeSeconds: z.number().finite().positive(),
}).strict();
/**
 * Campaign order, medal targets and unlock policy for a multi-course game. The project format
 * keeps levels as ordinary scenes; this document only sequences them into a shipped game.
 */
export const campaignSchema = z.object({
  schemaVersion: z.literal(1), campaignId: idSchema, title: name, tagline: name,
  unlock: z.enum(['sequential', 'all']).optional(),
  credits: name.optional(),
  courses: z.array(campaignCourseSchema).min(1).max(64),
}).strict();
const documentRef = z.object({ id: idSchema, path: relativePathSchema }).strict();
export const projectManifestSchema = z.object({
  schemaVersion: z.literal(1), projectId: idSchema, name, startScene: idSchema,
  scenes: z.array(documentRef).min(1), prefabs: z.array(documentRef), assetRegistry: relativePathSchema,
  campaign: relativePathSchema.optional(),
}).strict();

export type Transform = z.infer<typeof transformSchema>;
export type Component = z.infer<typeof componentSchema>;
export type PrefabInstance = z.infer<typeof prefabInstanceSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type SceneDocument = z.infer<typeof sceneSchema>;
export type PrefabDocument = z.infer<typeof prefabSchema>;
export type AssetRecord = z.infer<typeof assetSchema>;
export type AssetRegistry = z.infer<typeof assetRegistrySchema>;
export type CampaignCourse = z.infer<typeof campaignCourseSchema>;
export type CampaignDocument = z.infer<typeof campaignSchema>;
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export interface ValidationContext { assets?: readonly AssetRecord[]; prefabs?: readonly PrefabDocument[] }
export interface CampaignValidationContext { sceneIds: readonly string[] }

export class DocumentValidationError extends Error {
  constructor(public readonly diagnostics: { path: string; message: string }[]) {
    super(diagnostics.map(item => `${item.path}: ${item.message}`).join('\n'));
    this.name = 'DocumentValidationError';
  }
}
function requireValid(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new DocumentValidationError([{ path, message }]);
}
function unique(ids: readonly string[], path: string): void {
  requireValid(new Set(ids).size === ids.length, path, 'Duplicate stable ID');
}
function validateEntities(entities: Entity[], context: ValidationContext): void {
  unique(entities.flatMap(entity => [entity.id, ...entity.components.map(component => component.id)]), 'entities');
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const assetIds = context.assets && new Set(context.assets.map(asset => asset.id));
  const prefabs = context.prefabs && new Map(context.prefabs.map(prefab => [prefab.prefabId, prefab]));
  const instances = new Map<string, { prefabId: string; sources: Set<string> }>();
  const completed = new Set<string>();
  for (const entity of entities) {
    requireValid(entity.parentId === null || byId.has(entity.parentId), `${entity.id}.parentId`, 'Missing parent');
    const chain = new Set<string>();
    let current: Entity | undefined = entity;
    while (current && !completed.has(current.id)) {
      requireValid(!chain.has(current.id), `${entity.id}.parentId`, 'Hierarchy cycle');
      chain.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of chain) completed.add(id);
    for (const component of entity.components) {
      for (const ref of component.entityRefs) requireValid(byId.has(ref), `${component.id}.entityRefs`, `Missing entity ${ref}`);
      if (assetIds) for (const ref of component.assetRefs) requireValid(assetIds.has(ref), `${component.id}.assetRefs`, `Missing asset ${ref}`);
      if (component.type === 'model' && context.assets) {
        const asset = context.assets.find(asset => asset.id === component.assetRefs[0]);
        requireValid(asset?.kind === 'model' && /\.glb$/i.test(asset.path), `${component.id}.assetRefs`, 'Model must reference a catalogued GLB model asset');
      }
    }
    if (entity.prefab) {
      const { prefabId, instanceId, sourceEntityId } = entity.prefab;
      const instance = instances.get(instanceId) ?? { prefabId, sources: new Set<string>() };
      requireValid(instance.prefabId === prefabId, `${entity.id}.prefab`, 'Instance refers to different prefabs');
      requireValid(!instance.sources.has(sourceEntityId), `${entity.id}.prefab`, 'Duplicate prefab source within instance');
      instance.sources.add(sourceEntityId);
      instances.set(instanceId, instance);
      if (prefabs) {
        const prefab = prefabs.get(prefabId);
        requireValid(prefab, `${entity.id}.prefab`, `Missing prefab ${prefabId}`);
        requireValid(prefab.entities.some(source => source.id === sourceEntityId), `${entity.id}.prefab`, 'Missing prefab source entity');
      }
    }
  }
  for (const instanceId of instances.keys()) requireValid(!byId.has(instanceId) && !entities.some(entity => entity.components.some(component => component.id === instanceId)), 'entities', 'Instance ID collides with object ID');
}
function validateDocumentId(id: string, entities: Entity[]): void {
  requireValid(!entities.some(entity => entity.id === id || entity.prefab?.instanceId === id || entity.components.some(component => component.id === id)), 'id', 'Document ID collides with object ID');
}
export function parseScene(input: unknown, context: ValidationContext = {}): SceneDocument {
  const scene = sceneSchema.parse(input);
  validateEntities(scene.entities, context);
  validateDocumentId(scene.sceneId, scene.entities);
  return scene;
}
export function parsePrefab(input: unknown, context: ValidationContext = {}): PrefabDocument {
  const prefab = prefabSchema.parse(input);
  validateEntities(prefab.entities, context);
  validateDocumentId(prefab.prefabId, prefab.entities);
  const roots = prefab.entities.filter(entity => entity.parentId === null);
  requireValid(roots.length === 1 && roots[0]?.id === prefab.rootId, 'rootId', 'Prefab must have exactly one matching root');
  return prefab;
}
export function parseAssetRegistry(input: unknown): AssetRegistry {
  const registry = assetRegistrySchema.parse(input);
  unique(registry.assets.map(asset => asset.id), 'assets');
  return registry;
}
export function parseProjectManifest(input: unknown): ProjectManifest {
  const manifest = projectManifestSchema.parse(input);
  unique([manifest.projectId, ...manifest.scenes.map(ref => ref.id), ...manifest.prefabs.map(ref => ref.id)], 'manifest');
  unique([manifest.assetRegistry, ...(manifest.campaign ? [manifest.campaign] : []), ...manifest.scenes.map(ref => ref.path), ...manifest.prefabs.map(ref => ref.path)], 'paths');
  requireValid(manifest.scenes.some(scene => scene.id === manifest.startScene), 'startScene', 'Start scene is not registered');
  return manifest;
}
/** Validates a campaign against the project's scene catalog: unique, registered, ascending medal times. */
export function parseCampaign(input: unknown, context: CampaignValidationContext): CampaignDocument {
  const campaign = campaignSchema.parse(input);
  unique(campaign.courses.map(course => course.sceneId), 'courses');
  const scenes = new Set(context.sceneIds);
  for (const [index, course] of campaign.courses.entries()) {
    requireValid(scenes.has(course.sceneId), `courses.${index}.sceneId`, `Campaign scene ${course.sceneId} is not registered`);
    requireValid(course.goldSeconds < course.silverSeconds && course.silverSeconds < course.bronzeSeconds,
      `courses.${index}`, 'Medal times must ascend: gold < silver < bronze');
  }
  return campaign;
}
export function validateProject(input: { manifest: ProjectManifest; scenes: readonly SceneDocument[]; prefabs: readonly PrefabDocument[]; assets: AssetRegistry; campaign?: CampaignDocument }): void {
  const manifest = parseProjectManifest(input.manifest);
  const assets = parseAssetRegistry(input.assets);
  const context = { assets: assets.assets, prefabs: input.prefabs };
  const prefabs = input.prefabs.map(prefab => parsePrefab(prefab, context));
  const scenes = input.scenes.map(scene => parseScene(scene, context));
  if (manifest.campaign) {
    requireValid(input.campaign !== undefined, 'campaign', 'Manifest declares a campaign document the catalog did not provide');
    parseCampaign(input.campaign, { sceneIds: scenes.map(scene => scene.sceneId) });
  }
  for (const [refs, documents] of [
    [manifest.scenes.map(ref => ref.id), scenes.map(scene => scene.sceneId)],
    [manifest.prefabs.map(ref => ref.id), prefabs.map(prefab => prefab.prefabId)],
  ]) requireValid(refs && documents && refs.length === documents.length && refs.every(id => documents.includes(id)), 'manifest', 'Document catalog does not match manifest');
  const ids = [manifest.projectId, ...assets.assets.map(asset => asset.id)];
  if (input.campaign) ids.push(input.campaign.campaignId);
  for (const document of [...scenes, ...prefabs]) {
    ids.push('sceneId' in document ? document.sceneId : document.prefabId);
    ids.push(...new Set(document.entities.flatMap(entity => [entity.id, ...entity.components.map(component => component.id), ...(entity.prefab ? [entity.prefab.instanceId] : [])])));
  }
  unique(ids, 'project');
}
export function serializeScene(scene: SceneDocument): string {
  return `${JSON.stringify(parseScene(scene), null, 2)}\n`;
}
export function createId(prefix: string): string {
  return idSchema.parse(`${prefix}_${globalThis.crypto.randomUUID()}`);
}
export function createEntity(entityName: string, parentId: string | null = null): Entity {
  return entitySchema.parse({ id: createId('entity'), name: entityName, parentId, enabled: true,
    transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, components: [] });
}
export function createScene(sceneName: string): SceneDocument {
  return parseScene({ schemaVersion: 1, sceneId: createId('scene'), name: sceneName, entities: [] });
}
