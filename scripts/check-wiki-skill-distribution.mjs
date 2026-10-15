#!/usr/bin/env node
// Compare only the Wiki workflow packages. Never install or overwrite local customizations.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packages = ['kinic-wiki-query', 'kinic-wiki-ingest', 'kinic-wiki-edit', 'kinic-wiki-lint', 'kinic-wiki-maintain'];
async function files(root, dir = root) {
  const result = new Map();
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in skill package: ${path}`);
    if (entry.isDirectory()) for (const [key, value] of await files(root, path)) result.set(key, value);
    else if (entry.isFile()) result.set(relative(root, path), createHash('sha256').update(await readFile(path)).digest('hex'));
  }
  return result;
}
export async function compare(sourceRoot, installedRoot) {
  const differences = [];
  for (const name of packages) {
    const source = await files(join(sourceRoot, name));
    if (!source.has('SKILL.md')) throw new Error(`Source package missing SKILL.md: ${name}`);
    const installed = await files(join(installedRoot, name));
    for (const path of [...new Set([...source.keys(), ...installed.keys()])].sort()) {
      if (source.get(path) !== installed.get(path)) differences.push({ package: name, path, state: !installed.has(path) ? 'missing' : !source.has(path) ? 'installed-only' : 'different' });
    }
  }
  return differences;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--installed-root') {
    console.error('Usage: node scripts/check-wiki-skill-distribution.mjs --installed-root /absolute/skills');
    process.exitCode = 2;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const differences = await compare(join(root, 'skills'), resolve(args[1]));
    console.log(JSON.stringify({ source: join(root, 'skills'), installed: resolve(args[1]), differences }, null, 2));
    process.exitCode = differences.length ? 1 : 0;
  }
}
