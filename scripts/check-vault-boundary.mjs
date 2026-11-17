import { execFileSync } from 'node:child_process';
import { checkCargo, checkTypescript } from './vault-boundary-graph.mjs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of ['crates/vfs_canister/src/lib.rs', 'crates/vfs_canister/vfs.did', 'crates/vfs_canister/Cargo.toml', 'crates/vfs_runtime/src/lib.rs', 'crates/vfs_runtime/Cargo.toml', 'packages/vfs-candid/index.ts']) assert.doesNotMatch(readFileSync(root + file, 'utf8'), /vault/i, file);
// Import policies belong to the transitive AST graph below. Keep lexical checks
// only for contract and deployment artifacts that cannot be represented as imports.
assert.doesNotMatch(readFileSync(root + 'wikibrowser/components/admin-shell.tsx', 'utf8'), /https:\/\/vault\.kinic\.xyz/);
assert.doesNotMatch(readFileSync(root + 'vaultbrowser/icp.yaml', 'utf8'), /name: wiki/);
// Cargo metadata includes every target unless filtered; enable optional features too.
checkCargo(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--all-features'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })));
checkTypescript(root);
console.log('Wiki/Vault runtime, contract, browser and deployment boundaries PASS');
