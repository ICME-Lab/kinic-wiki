import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';

export function assertSeparated(graph, classify) {
  for (const start of graph.keys()) {
    const side = classify(start);
    if (!side) continue;
    const visit = (node, path, seen) => {
      if (seen.has(node)) return;
      seen.add(node);
      const target = classify(node);
      if ((side === 'wiki' && target === 'vault') || (side === 'vault' && target === 'wiki') || (side === 'ui' && target && target !== 'ui'))
        throw new Error(`Forbidden ${side} dependency: ${[...path, node].join(' -> ')}`);
      for (const next of graph.get(node) ?? []) visit(next, [...path, node], seen);
    };
    visit(start, [], new Set());
  }
}
export function checkCargo(metadata) {
  const names = new Map(metadata.packages.map(p => [p.id, p.name]));
  const graph = new Map(metadata.resolve.nodes.map(n => [n.id, n.deps.map(d => d.pkg)]));
  assertSeparated(graph, id => /^vault[-_]/.test(names.get(id)) ? 'vault' : /^(vfs[-_]|wiki[-_])/.test(names.get(id)) ? 'wiki' : null);
}
export function imports(ts, text, file = 'module.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = [];
  const walk = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return result;
}
export function loadParser(root) {
  return createRequire(resolve(root, 'wikibrowser/package.json'))('typescript-parser');
}
export function checkTypescript(root, ts = loadParser(root)) {
  const files = [], packages = new Map();
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (/^(node_modules|dist|target|\.git|test|tests|__tests__|scripts)$/.test(e.name)) continue;
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?[jt]sx?$/.test(p) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) files.push(p);
    }
  };
  for (const dir of ['wikibrowser/src', 'wikibrowser/app', 'wikibrowser/components', 'wikibrowser/hooks', 'wikibrowser/lib', 'vaultbrowser/src', 'packages']) {
    if (existsSync(resolve(root, dir))) walk(resolve(root, dir));
  }
  for (const e of readdirSync(resolve(root, 'packages'))) {
    const dir = resolve(root, 'packages', e), manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) packages.set(JSON.parse(readFileSync(manifest)).name, { dir, ...JSON.parse(readFileSync(manifest)) });
  }
  const serviceFiles = new Set(files.filter(p => /\b(?:localStorage|sessionStorage|indexedDB)\b|\bfetch\s*\(/.test(readFileSync(p, 'utf8'))));
  const classify = p => {
    const name = relative(root, p).replaceAll('\\', '/');
    if (/^(vaultbrowser|packages\/vault-)/.test(name)) return 'vault';
    if (/^(wikibrowser|packages\/vfs-)/.test(name)) return 'wiki';
    if (/^packages\/ui\//.test(name)) return 'ui';
    if (serviceFiles.has(p)) return 'service';
    if (/^external:(?:@icp-sdk\/(?:auth|core)(?:\/|$)|@dfinity\/|(?:.*[\/@-])?(?:auth|actor|agent|network|storage|persistence|sqlite)(?:[\/@-]|$))/i.test(p)) return 'service';
    return null;
  };
  const resolveFile = p => [p, ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(s => p+s), ...['.ts', '.tsx', '.mts'].map(s => p.replace(/\.[cm]?jsx?$/, s))].find(x => existsSync(x) && !readdirSafe(x));
  function readdirSafe(p) { try { readdirSync(p); return true; } catch { return false; } }
  const graph = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (classify(file) === 'ui' && /\b(?:localStorage|sessionStorage|indexedDB)\b|\bfetch\s*\(/.test(text)) throw new Error(`Shared UI persistence/networking: ${file}`);
    graph.set(file, imports(ts, text, file).map(spec => {
      if (spec.startsWith('.')) return resolveFile(resolve(dirname(file), spec)) ?? resolve(dirname(file), spec);
      if (spec.startsWith('@/')) return resolveFile(resolve(root, relative(root, file).split('/')[0], spec.slice(2))) ?? spec;
      const name = spec.startsWith('@') ? spec.split('/').slice(0,2).join('/') : spec.split('/')[0];
      const pkg = packages.get(name);
      if (!pkg) return `external:${spec}`;
      const sub = spec.slice(name.length), key = sub ? '.'+sub : '.';
      const exp = pkg.exports?.[key] ?? (key === '.' ? pkg.exports : null);
      const entry = typeof exp === 'string' ? exp : exp?.import ?? exp?.default ?? exp?.types;
      if (!entry) throw new Error(`Unresolved workspace import ${spec} in ${file}`);
      return resolveFile(resolve(pkg.dir, entry)) ?? resolve(pkg.dir, entry);
    }));
  }
  assertSeparated(graph, classify);
}
