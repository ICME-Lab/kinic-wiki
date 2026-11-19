// Frozen PR #177 source, not a modified current canister. Local test artifact only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'target/vault-schema9-baseline');
const source = resolve(output, 'source');
const fixture = resolve(root, 'pocketic-tests/fixtures/vault-schema9-pr177-source.tar.gz');
const checksum = '182ba86820d373a8a94f8e4977ed42e2709195741489a21d2be033f3daf130a9';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(fixture)), checksum);
rmSync(source, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
execFileSync('tar', ['-xzf', fixture, '-C', source]);
const sourceLock = hash(readFileSync(resolve(source, 'Cargo.lock')));
const cargo = resolve(source, 'Cargo.toml');
const members = ['vault_canister', 'vault_service', 'vault_store', 'vault_types', 'kinic_sqlite_compat'];
writeFileSync(cargo, readFileSync(cargo, 'utf8')
  .replace(/members = \[[\s\S]*?\]/, `members = [${members.map((m) => `"crates/${m}"`).join(',')}]`)
  .replace('ic-agent = { path = "vendor/ic-agent" }', ''));
const env = { ...process.env, CARGO_TARGET_DIR: resolve(output, 'build') };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'RUSTFLAGS',
  'CARGO_ENCODED_RUSTFLAGS', 'VAULT_LOCAL_ORIGIN', 'VAULT_LOCAL_HOST', 'VAULT_LOCAL_II']) delete env[key];
execFileSync('cargo', ['build', '-p', 'vault-canister', '--target', 'wasm32-unknown-unknown',
  '--release', '--offline'], { cwd: source, env, stdio: 'inherit' });
const wasm = resolve(env.CARGO_TARGET_DIR, 'wasm32-unknown-unknown/release/vault_canister.wasm');
writeFileSync(resolve(output, 'source.json'), JSON.stringify({
  commit: '3dfb57915eba0acc462c7439a7023e8e4dde90d2', source_archive_sha256: checksum,
  source_lock_sha256: sourceLock,
  fixture_lock_sha256: hash(readFileSync(resolve(source, 'Cargo.lock'))),
  wasm, wasm_sha256: hash(readFileSync(wasm)), productionDeployment: false, realFunds: false,
}, null, 2) + '\n');
