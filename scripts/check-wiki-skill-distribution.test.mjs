import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compare, packages } from './check-wiki-skill-distribution.mjs';

test('compares complete packages and detects drift without changing installed files', async () => {
  await mkdir('outputs', { recursive: true });
  const root = await mkdtemp('outputs/skill-distribution-test-');
  const source = join(root, 'source');
  const installed = join(root, 'installed');
  try {
    for (const base of [source, installed]) for (const name of packages) {
      await mkdir(join(base, name, 'scripts'), { recursive: true });
      await writeFile(join(base, name, 'SKILL.md'), 'canonical');
      await writeFile(join(base, name, 'scripts/check.py'), 'print("check")');
    }
    assert.deepEqual(await compare(source, installed), []);
    const name = packages[0];
    await writeFile(join(installed, name, 'SKILL.md'), 'old instructions');
    await writeFile(join(installed, name, 'custom.md'), 'preserve me');
    await rm(join(installed, name, 'scripts/check.py'));
    await mkdir(join(installed, name, '__pycache__'));
    await writeFile(join(installed, name, '__pycache__/generated.pyc'), 'ignore');
    const expected = [
      { package: name, path: 'SKILL.md', state: 'different' },
      { package: name, path: 'custom.md', state: 'installed-only' },
      { package: name, path: 'scripts/check.py', state: 'missing' }
    ];
    assert.deepEqual(await compare(source, installed), expected);
    assert.deepEqual(await compare(source, installed), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
