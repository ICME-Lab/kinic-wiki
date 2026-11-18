// Verify pinned predecessor binaries for CI after the source commit is squashed.
// Set VAULT_REBUILD_FROZEN_SOURCE=1 to rebuild and compare the original Git source.
// Outputs are local PocketIC fixtures, never deployable distribution artifacts.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from '../../vaultbrowser/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../..');
const baseline = '82f03ce7da704e07d895cd4f1ef9df2827964148';
const expected = {
  vault_canister: '5eee3725539b5fc9871ea6d781d76fcc3ce9aaacb27d847868a616d8c499ea43',
  vfs_canister: '54ffc16c2440cabcfeb48023c8e44ed52e91c57ed3ba509c40016ea6b3a6f0e3',
};
const output = resolve(root, 'target/vault-credit-baseline82');
const fixture = resolve(root, 'pocketic-tests/fixtures/vault-credit-baseline82.tar.gz');
const fixtureSha256 = 'c3e551fb7c59d5ac05c0c8149e1358fb4910d282321e997f21d43c182d2e7b70';
const oldClientSha256 = 'ce5a3e6e39249dee9de2c194a2c0831cde0a9109e5c34f317cb6150b7cb3c7cf';
const oldDidSha256 = {
  'vault.did': 'ffd1f10a788ab43652e44ebefc86a82218f62f1ec9d541d00c14ea17d48f6211',
  'vfs.did': 'f658ad5d3fca86f76e0566b81502ffeccd1b693de8ed5fd4b23a11039ff34c55',
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
mkdirSync(output, { recursive: true });
if (process.env.VAULT_REBUILD_FROZEN_SOURCE !== '1') {
  assert.equal(sha(fixture), fixtureSha256, 'frozen baseline fixture checksum');
  execFileSync('tar', ['-xzf', fixture, '-C', output]);
  const artifacts = {};
  for (const name of ['vault_canister', 'vfs_canister']) {
    const path = resolve(output, `${name}.wasm`);
    assert.equal(sha(path), expected[name], `frozen ${name} Wasm checksum`);
    artifacts[name] = { sha256: sha(path), bytes: readFileSync(path).length };
  }
  for (const [name, checksum] of Object.entries(oldDidSha256))
    assert.equal(sha(resolve(output, name)), checksum, `frozen ${name} checksum`);
  const client = resolve(output, 'client/client.mjs');
  assert.equal(sha(client), oldClientSha256, 'frozen client checksum');
  writeFileSync(resolve(output, 'source.json'), JSON.stringify({ baseline,
    fixtureSha256, artifacts,
    client: { sha256: sha(client), executableSha256: oldClientSha256,
      bytes: readFileSync(client).length },
    productionDeployment: false, realFunds: false }, null, 2) + '\n');
  console.log(JSON.stringify({ baseline, fixtureSha256, artifacts }));
  process.exit(0);
}
const source = mkdtempSync(join(root, '.vault-credit-baseline-'));
const target = resolve(output, 'build');
const environment = { ...process.env, CARGO_TARGET_DIR: target };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])
  delete environment[key];
try {
  const archive = join(source, 'source.tar');
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '--output', archive, baseline], { env: environment });
  execFileSync('tar', ['-xf', archive, '-C', source]);
  rmSync(archive);
  execFileSync('cargo', ['build', '-p', 'vault-canister', '-p', 'vfs-canister',
    '--target', 'wasm32-unknown-unknown', '--release', '--locked', '--offline'],
  { cwd: source, env: environment, stdio: 'inherit' });
  const artifacts = {};
  for (const name of ['vault_canister', 'vfs_canister']) {
    const path = resolve(output, `${name}.wasm`);
    copyFileSync(resolve(target, 'wasm32-unknown-unknown/release', `${name}.wasm`), path);
    assert.equal(sha(path), expected[name], `frozen ${name} Wasm must match the reviewed artifact`);
    artifacts[name] = { sha256: sha(path), bytes: readFileSync(path).length };
  }
  copyFileSync(resolve(source, 'crates/vault_canister/vault.did'), resolve(output, 'vault.did'));
  copyFileSync(resolve(source, 'crates/vfs_canister/vfs.did'), resolve(output, 'vfs.did'));
  for (const [name, checksum] of Object.entries(oldDidSha256))
    assert.equal(sha(resolve(output, name)), checksum, `frozen source ${name} must match the reviewed contract`);
  await build({ configFile: false, root: source,
    resolve: { alias: [
      { find: '@icp-sdk/core/principal', replacement: resolve(root, 'vaultbrowser/node_modules/@icp-sdk/core/lib/esm/principal/index.js') },
      { find: '@icp-sdk/vetkeys', replacement: resolve(root, 'packages/vault-crypto/node_modules/@icp-sdk/vetkeys/dist/lib/index.es.js') },
    ] },
    build: { outDir: resolve(output, 'client'), emptyOutDir: true, lib: {
      entry: resolve(source, 'pocketic-tests/fixtures/vault-client-entry.ts'),
      formats: ['es'], fileName: () => 'client.mjs',
    }, rollupOptions: { output: { codeSplitting: false } } },
  });
  const client = resolve(output, 'client/client.mjs');
  const clientExecutable = readFileSync(client, 'utf8').replace(/^\/\/#region.*\n|^\/\/#endregion\n/gm, '');
  const clientExecutableSha256 = createHash('sha256').update(clientExecutable).digest('hex');
  assert.equal(clientExecutableSha256, oldClientSha256,
    'frozen client executable bytes must match the reviewed old bundle after path comments');
  writeFileSync(resolve(output, 'source.json'), JSON.stringify({ baseline, artifacts,
    client: { sha256: sha(client), executableSha256: clientExecutableSha256,
      bytes: readFileSync(client).length },
    productionDeployment: false, realFunds: false }, null, 2) + '\n');
  console.log(JSON.stringify({ baseline, artifacts, client: { sha256: sha(client) } }));
} finally { rmSync(source, { recursive: true, force: true }); }
