// Rebuild the exact PR #187 Wiki source with schema 007 for an actual Wasm upgrade.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'target/wiki-credit-schema7');
const source = resolve(output, 'source');
const fixture = resolve(root, 'pocketic-tests/fixtures/wiki-credit-schema7-pr187-source.tar.gz');
const fixtureSha256 = '9a4ce209b2cce6385f0501eb7d130d85f411edb38c00d103f3bd44230693940e';
const lockSha256 = '866e125dade65a1a05277912fca6efa9b18a45c46a6aa626ead2968ea0d93f3d';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(readFileSync(fixture)), fixtureSha256, 'PR #187 source fixture');
rmSync(source, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
execFileSync('tar', ['-xzf', fixture, '-C', source]);
assert.equal(sha(readFileSync(resolve(source, 'Cargo.lock'))), lockSha256);
const members = ['credit_bridge_types', 'vfs_canister', 'vfs_runtime', 'vfs_types',
  'vfs_store', 'wiki_domain', 'kinic_sqlite_compat'];
const manifest = resolve(source, 'Cargo.toml');
writeFileSync(manifest, readFileSync(manifest, 'utf8')
  .replace(/members = \[[\s\S]*?\]/,
    `members = [${members.map((name) => `"crates/${name}"`).join(',')}]`)
  .replace('ic-agent = { path = "vendor/ic-agent" }', ''));
const env = { ...process.env, CARGO_TARGET_DIR: resolve(output, 'build') };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'RUSTFLAGS',
  'CARGO_ENCODED_RUSTFLAGS']) delete env[key];
execFileSync('cargo', ['build', '-p', 'vfs-canister', '--target', 'wasm32-unknown-unknown',
  '--release', '--offline'], { cwd: source, env, stdio: 'inherit' });
const wasm = resolve(env.CARGO_TARGET_DIR, 'wasm32-unknown-unknown/release/vfs_canister.wasm');
const wasmSha256 = sha(readFileSync(wasm));
const result = { sourceCommit: 'b8bb9125b138927a20f81bb82db0c8979cb2a93f',
  fixtureSha256, lockSha256, wasmSha256, wasm,
  productionDeployment: false };
writeFileSync(resolve(output, 'source.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
