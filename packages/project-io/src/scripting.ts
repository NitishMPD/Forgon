import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { build, type Message } from 'esbuild';
import ts from 'typescript';
import { parseScriptProps, scriptPathSchema, type Diagnostic, type ScriptCatalog, type ScriptProps } from '@forgon/project-schema';
import { canonicalRoot, missing, readBytes, targetPath } from './files.js';

class SourceError extends Error {
  constructor(message: string, readonly node: ts.Node, readonly source: ts.SourceFile) { super(message); }
}
function sourceFile(text: string, path: string): ts.SourceFile { return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function literal(input: ts.Expression, source: ts.SourceFile): unknown {
  const node = unwrap(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(node.operand)) return Number(node.operand.text) * (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item, source));
  if (ts.isObjectLiteralExpression(node)) return object(node, source, value => literal(value, source));
  throw new SourceError('Script properties must use literal values; project code is never evaluated for extraction', node, source);
}
function object(node: ts.ObjectLiteralExpression, source: ts.SourceFile, read: (value: ts.Expression) => unknown): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const item of node.properties) {
    if (!ts.isPropertyAssignment(item) || !(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))) throw new SourceError('Use named literal properties without spreads or computed keys', item, source);
    const key = item.name.text;
    if (Object.hasOwn(result, key)) throw new SourceError(`Duplicate property: ${key}`, item, source);
    result[key] = read(item.initializer);
  }
  return result;
}
/** Reads declarations only. No imports, callbacks, getters or project expressions execute. */
export function extractScriptProps(text: string, path = 'scripts/script.ts'): ScriptProps | null {
  const source = sourceFile(text, path);
  let defineName: string | undefined; let propName: string | undefined;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@forgon/game-runtime/scripting') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) {
      if ((item.propertyName ?? item.name).text === 'defineScript') defineName = item.name.text;
      if ((item.propertyName ?? item.name).text === 'prop') propName = item.name.text;
    }
  }
  const statement = source.statements.find((item): item is ts.ExportAssignment => ts.isExportAssignment(item) && !item.isExportEquals);
  if (!statement) return null;
  const call = unwrap(statement.expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== defineName) return null;
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0]!)) throw new SourceError('Default export must be defineScript({ props: {...}, ... })', statement, source);
  const declaration = call.arguments[0] as ts.ObjectLiteralExpression;
  if (declaration.properties.some(ts.isSpreadAssignment)) throw new SourceError('Script declarations cannot spread objects; keep props statically declared', declaration, source);
  const props = declaration.properties.filter(item => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === 'props');
  const property = props[0];
  if (props.length !== 1 || !property || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(unwrap(property.initializer))) throw new SourceError('Declare props as an object literal', declaration, source);
  const values = object(unwrap(property.initializer) as ts.ObjectLiteralExpression, source, input => {
    const node = unwrap(input);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== propName) throw new SourceError('Use prop.number/boolean/string/color/vec3/entity/enum', node, source);
    const kind = node.expression.name.text;
    const args = node.arguments.map(arg => literal(arg, source));
    if (!['number', 'boolean', 'string', 'color', 'vec3', 'entity', 'enum'].includes(kind) || args.length > (kind === 'number' || kind === 'enum' ? 2 : 1) || (!args.length && kind !== 'entity')) throw new SourceError('Invalid property declaration', node, source);
    if (kind === 'number') {
      const options = args[1] ?? {};
      if (options === null || Array.isArray(options) || typeof options !== 'object' || Object.keys(options).some(key => !['min', 'max', 'step'].includes(key))) throw new SourceError('Number options support min, max and step', node, source);
      return { type: kind, default: args[0], ...options };
    }
    return { type: kind, default: args[0] ?? null, ...(kind === 'enum' ? { options: args[1] } : {}) };
  });
  try { return parseScriptProps(values); } catch (error) { throw new SourceError(String(error), property, source); }
}
function diagnostic(error: unknown, path: string): Diagnostic[] {
  if (error instanceof SourceError) {
    const location = error.source.getLineAndCharacterOfPosition(error.node.getStart(error.source));
    return [{ path: error.source.fileName, message: error.message, line: location.line + 1, column: location.character + 1 }];
  }
  if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) return (error.errors as Message[]).map(item => ({ path: item.location?.file.replace(/^forgon-project:/, '') ?? path, message: item.text,
    ...(item.location ? { line: item.location.line, column: item.location.column + 1 } : {}) }));
  return [{ path, message: String(error) }];
}

/** Node-side compilation, restricted to bounded, contained scripts/*.ts files and two runtime imports. */
export async function compileProjectScripts(projectRoot: string): Promise<ScriptCatalog> {
  const result: ScriptCatalog = { scripts: [], diagnostics: [] };
  const root = await canonicalRoot(projectRoot);
  const files = new Map<string, string>();
  let total = 0;
  let compiledBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(await targetPath(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Script symlinks are not supported: ${path}`);
      if (entry.isDirectory()) { if (path.split('/').length > 16) throw new Error('Script directory depth exceeds 16'); await walk(path); }
      else if (entry.isFile() && path.endsWith('.ts')) {
        scriptPathSchema.parse(path);
        if (files.size >= 128) throw new Error('Script count exceeds 128');
        const bytes = await readBytes(root, path, 256 * 1024);
        total += bytes.length; if (total > 4 * 1024 * 1024) throw new Error('Script sources exceed 4 MiB');
        files.set(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
    }
  };
  try { await walk('scripts'); } catch (error) { if (!missing(error)) result.diagnostics.push(...diagnostic(error, 'scripts')); return result; }
  const resolve = (specifier: string, importer: string): string | undefined => {
    if (specifier === 'three' || specifier === '@forgon/game-runtime/scripting') return specifier;
    if (!specifier.startsWith('.')) return undefined;
    const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
    return [target, target.replace(/\.js$/, '.ts'), `${target}.ts`].find(candidate => candidate.startsWith('scripts/') && files.has(candidate));
  };
  for (const [path, text] of files) {
    try {
      const props = extractScriptProps(text, path);
      // Helpers can have named exports; only default defineScript declarations are attachable.
      const compiled = await build({ entryPoints: [path], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent', sourcemap: 'inline', sourcesContent: true,
        banner: { js: `export function load(modules) {\nconst module = { exports: {} };\nconst exports = module.exports;\nconst require = id => { if (!Object.hasOwn(modules, id)) throw new Error('Unsupported script module: ' + id); return modules[id]; };` },
        footer: { js: 'return module.exports;\n}' },
        plugins: [{ name: 'forgon-project-scripts', setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => {
            if (args.path === 'three' || args.path === '@forgon/game-runtime/scripting') return { path: args.path, external: true };
            const resolved = args.kind === 'entry-point' && files.has(args.path) ? args.path : resolve(args.path, args.importer);
            if (!resolved) return { errors: [{ text: `Import is not a project script or supported runtime module: ${args.path}` }] };
            return { path: resolved, namespace: 'forgon-project' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'forgon-project' }, args => {
            const contents = files.get(args.path)!;
            const source = sourceFile(contents, args.path);
            const visit = (node: ts.Node): void => {
              if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) throw new SourceError('Use static imports; dynamic import and require are not supported', node, source);
              if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !resolve(node.moduleSpecifier.text, args.path)) throw new SourceError(`Import is not a project script or supported runtime module: ${node.moduleSpecifier.text}`, node.moduleSpecifier, source);
              if (ts.isImportEqualsDeclaration(node)) throw new SourceError('Use static ES imports', node, source);
              ts.forEachChild(node, visit);
            };
            try { visit(source); } catch (error) {
              if (!(error instanceof SourceError)) throw error;
              const location = source.getLineAndCharacterOfPosition(error.node.getStart(source));
              return { errors: [{ text: error.message, location: { file: args.path, line: location.line + 1, column: location.character, lineText: source.text.split(/\r?\n/)[location.line] ?? '' } }] };
            }
            return { contents, loader: 'ts' };
          });
        } }],
      });
      if (props) {
        const code = compiled.outputFiles[0]!.text;
        compiledBytes += Buffer.byteLength(code);
        if (compiledBytes > 16 * 1024 * 1024) throw new Error('Compiled scripts exceed 16 MiB');
        result.scripts.push({ src: path, props, code });
      }
    } catch (error) { result.diagnostics.push(...diagnostic(error, path)); }
  }
  return result;
}
