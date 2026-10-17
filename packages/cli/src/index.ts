import { parseScene, serializeScene } from '@forgon/project-schema';
import { bakeAuthoring, replayOverrides } from '@forgon/procedural-authoring';
import { createFixture } from '@forgon/test-fixtures';
import { createProject, openProject, readProject } from '@forgon/project-io/node';
import { importAsset, readAssetRegistry } from '@forgon/asset-pipeline';
export { ProjectReader, readProject } from './read-project.js';
export { buildWeb } from './build-web.js';

export interface CliOutput { stdout(text: string): void; stderr(text: string): void }
const usage = 'Usage: forge inspect|validate <root>; create <root> [--template empty-3d|hotel|sector]; bake <root> [--seed <seed>] [--write]; import <root> <source> --license <license> [--id <id>] [--destination assets/<filename>] [--source <provenance>] [--name <name>]; build --target web <root> --out <nonexistent-output>';
function options(args: readonly string[], allowed: readonly string[], flags: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new Error('Invalid options');
    if (flags.includes(key)) result[key] = 'true';
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('Missing option value'); result[key] = value; }
  }
  return result;
}
export async function runCli(args: readonly string[], output: CliOutput = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }): Promise<number> {
  const [command, root, ...rest] = args;
  if (command === '--help' && !root) { output.stdout(`${usage}\nBake emits {scene, authoring}; only --write persists it. No project scripts execute.\n`); return 0; }
  if (command === 'build') {
    let projectRoot: string | undefined;
    let buildOptions: Record<string, string>;
    try {
      const optionArgs: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg.startsWith('--')) { optionArgs.push(arg, args[++i] ?? ''); }
        else if (!projectRoot) projectRoot = arg;
        else throw new Error('Multiple project roots');
      }
      buildOptions = options(optionArgs, ['--target', '--out']);
      if (!projectRoot || buildOptions['--target'] !== 'web' || !buildOptions['--out']) throw new Error('Build requires target web and output');
    } catch { output.stderr(`${usage}\n`); return 2; }
    try {
      const { buildWeb } = await import('./build-web.js');
      output.stdout(`${JSON.stringify(await buildWeb(projectRoot, buildOptions['--out']!), null, 2)}\n`);
      return 0;
    } catch (error) { output.stderr(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  }
  if (['snapshot', 'test', 'preview', 'open'].includes(command ?? '')) {
    output.stderr(`Unavailable command: ${command}. Runtime/export integration is required.\n`); return 2;
  }
  let opts: Record<string, string>;
  try {
    if (!['inspect', 'validate', 'bake', 'create', 'import'].includes(command ?? '') || !root) throw new Error('Usage');
    opts = options(command === 'import' ? rest.slice(1) : rest, command === 'bake' ? ['--seed', '--write'] : command === 'create' ? ['--template'] : command === 'import' ? ['--license', '--id', '--destination', '--source', '--name'] : [], ['--write']);
    if (command === 'create' && opts['--template'] && !['empty-3d', 'hotel', 'sector'].includes(opts['--template'])) throw new Error('Template');
    if (command === 'import' && (!rest[0] || rest[0].startsWith('--') || !opts['--license'])) throw new Error('Import requires source and license');
  } catch { output.stderr(`${usage}\n`); return 2; }
  try {
    if (command === 'create') {
      const session = await createProject(root!, opts['--template'] ?? 'empty-3d');
      try { output.stdout(`${JSON.stringify({ status: 'created', root: session.root, manifest: session.manifest }, null, 2)}\n`); } finally { session.close(); }
      return 0;
    }
    if (command === 'import') {
      const registry = await readAssetRegistry(root!);
      const result = await importAsset(root!, { sourcePath: rest[0]!, license: opts['--license']!, expectedRegistryRevision: registry.revision,
        ...(opts['--id'] ? { id: opts['--id'] } : {}), ...(opts['--destination'] ? { destination: opts['--destination'] } : {}),
        ...(opts['--source'] ? { source: opts['--source'] } : {}), ...(opts['--name'] ? { name: opts['--name'] } : {}) });
      if (result.status === 'conflict') throw new Error('Asset registry changed; import not saved');
      output.stdout(`${JSON.stringify(result, null, 2)}\n`); return 0;
    }
    // A write bake reads both revisions before generation and commits through the session's journaled pair save.
    const session = command === 'bake' && opts['--write'] ? await openProject(root!) : null;
    try {
      const project = session ? await session.readCatalog() : await readProject(root!);
      if (command === 'bake') {
        if (!project.authoring) throw new Error('No authoring/generated.json artifact; bake unavailable');
        const path = project.manifest.scenes.find(ref => ref.id === project.authoring!.base.sceneId)!.path;
        const sceneRead = session ? await session.sceneIO.readScene(path) : null;
        const authoringRead = session ? await session.readAuthoring() : null;
        const artifact = authoringRead?.document ?? project.authoring;
        const { generator } = artifact;
        if (generator.version !== '1.0.0') throw new Error(`Unavailable generator version ${generator.version}`);
        const previous = replayOverrides(artifact);
        const saved = sceneRead?.document ?? project.scenes.find(scene => scene.sceneId === artifact.base.sceneId)!;
        if (!previous.scene || previous.conflicts.length) throw new Error(`Existing override conflicts: ${JSON.stringify(previous.conflicts)}`);
        if (serializeScene(previous.scene) !== serializeScene(saved)) throw new Error('Scene contains unrecorded manual edits; captureOverrides and persist the authoring artifact before baking');
        const generated = createFixture(generator.id, opts['--seed'] ?? generator.seed);
        const result = bakeAuthoring(artifact, generated.authoring.base, generated.authoring.generator);
        if (result.conflicts.length || !result.scene || !result.authoring) throw new Error(`Bake conflicts: ${JSON.stringify(result.conflicts)}`);
        parseScene(result.scene, { assets: project.assets.assets, prefabs: project.prefabs });
        if (session) {
          if (!sceneRead || !authoringRead) throw new Error('Authoring artifact disappeared');
          const saved = await session.saveAuthoring({ path, scene: result.scene, authoring: result.authoring, expectedRevision: sceneRead.revision, expectedAuthoringRevision: authoringRead.revision });
          if (saved.status === 'conflict') throw new Error('Scene or authoring artifact changed; bake not saved');
        }
        output.stdout(`${JSON.stringify({ scene: result.scene, authoring: result.authoring }, null, 2)}\n`);
      } else {
        output.stdout(`${JSON.stringify({ status: 'valid', projectId: project.manifest.projectId, name: project.manifest.name,
          scenes: project.scenes.length, prefabs: project.prefabs.length, assets: project.assets.assets.length,
          entities: project.scenes.reduce((count, scene) => count + scene.entities.length, 0),
          ...(command === 'inspect' ? { manifest: project.manifest, generator: project.authoring?.generator ?? null } : {}) }, null, 2)}\n`);
      }
    } finally { session?.close(); }
    return 0;
  } catch (error) { output.stderr(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
