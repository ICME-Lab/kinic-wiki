import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of ['crates/vfs_canister/src/lib.rs', 'crates/vfs_canister/vfs.did', 'crates/vfs_canister/Cargo.toml', 'crates/vfs_runtime/src/lib.rs', 'crates/vfs_runtime/Cargo.toml', 'packages/vfs-candid/index.ts']) assert.doesNotMatch(readFileSync(root + file, 'utf8'), /vault/i, file);
function walk(path) {
  for (const e of readdirSync(root + path, {
    withFileTypes: true
  })) {
    const p = path + '/' + e.name;
    if (e.isDirectory()) walk(p);else if (/\.(ts|tsx)$/.test(p)) assert.doesNotMatch(readFileSync(root + p, 'utf8'), /@kinic\/vfs|wikibrowser|useAppSession|app-session-provider|dashboard\.vault/, p);
  }
}
walk('vaultbrowser/src');
walk('packages/vault-client/src');
assert.match(readFileSync(root + 'wikibrowser/components/admin-shell.tsx', 'utf8'), /https:\/\/vault\.kinic\.xyz/);
assert.doesNotMatch(readFileSync(root + 'vaultbrowser/icp.yaml', 'utf8'), /name: wiki/);
console.log('Wiki/Vault runtime, contract, browser and deployment boundaries PASS');
