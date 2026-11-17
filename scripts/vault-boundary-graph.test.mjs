import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertSeparated, checkCargo, imports, checkTypescript, loadParser } from './vault-boundary-graph.mjs';
import { selectsVault } from './vault-ci-paths.mjs';
const ts = loadParser(new URL('../', import.meta.url).pathname);
for (const statement of ['import x from "../vault/x"', 'export * from "../vault/x"', 'export {x} from "../vault/x"', 'const x = import("../vault/x")', 'import type {X} from "../vault/x"']) {
 test(`AST detects ${statement}`, () => assert.deepEqual(imports(ts, statement), ['../vault/x']));
}
test('comments and nonliteral dynamic imports are not static edges', () => assert.deepEqual(imports(ts, '// import x from "bad"\nconst x = import(name)'), []));
for (const reverse of [false, true]) test(`transitive Cargo cross-app edge reverse=${reverse}`, () => {
 const names = reverse ? ['vault-service','helper','vfs-runtime'] : ['vfs-canister','helper','vault-types'];
 const metadata = { packages: names.map(name => ({id:name,name})), resolve:{nodes:names.map((id,i)=>({id,deps:i<2?[{pkg:names[i+1]}]:[]}))}};
 assert.throws(() => checkCargo(metadata), /Forbidden/);
});
test('shared SQLite and external libs allowed', () => checkCargo({packages:['vfs-store','vault-store','kinic_sqlite_compat','serde'].map(name=>({id:name,name})),resolve:{nodes:[{id:'vfs-store',deps:[{pkg:'kinic_sqlite_compat'}]},{id:'vault-store',deps:[{pkg:'kinic_sqlite_compat'}]},{id:'kinic_sqlite_compat',deps:[{pkg:'serde'}]},{id:'serde',deps:[]}]}}));
test('shared UI allowed but transitive services rejected', () => {
 const side = p => ({wiki:'wiki',vault:'vault',ui:'ui',auth:'service'})[p];
 assertSeparated(new Map([['wiki',['ui']],['vault',['ui']],['ui',[]]]),side);
 assert.throws(()=>assertSeparated(new Map([['ui',['helper']],['helper',['auth']]]),side),/Forbidden ui/);
 assert.throws(()=>assertSeparated(new Map([['wiki',['vault']]]),side),/Forbidden wiki/);
});
for(const path of ['packages/ui/src/button.tsx','packages/vault-candid/index.ts','vaultbrowser/src/auth.ts','packages/vault-client/src/funding.ts','crates/vault_service/src/funding.rs','scripts/vault-ci-paths.mjs','crates/vfs_canister/vfs.did']) test(`CI selects ${path}`,()=>assert.equal(selectsVault([path]),true));
test('unrelated docs do not select Vault',()=>assert.equal(selectsVault(['docs/CLI.md']),false));

function fixture(entries, run) {
 const root = mkdtempSync(resolve(tmpdir(), 'vault-boundary-'));
 try {
  for (const dir of ['wikibrowser','vaultbrowser','packages']) mkdirSync(resolve(root,dir),{recursive:true});
  for (const [file, content] of Object.entries(entries)) {
   mkdirSync(resolve(root,file,'..'),{recursive:true}); writeFileSync(resolve(root,file),content);
  }
  run(root);
 } finally {rmSync(root,{recursive:true,force:true});}
}
for(const edge of ['import x from "../../vaultbrowser/src/private"', 'export * from "../../vaultbrowser/src/private"','const x = import("../../vaultbrowser/src/private")']) test(`relative file graph rejects ${edge}`,()=>fixture({
 'wikibrowser/src/start.ts':'export * from "./bridge"', 'wikibrowser/src/bridge.ts':edge, 'vaultbrowser/src/private.ts':'export const x=1'
},root=>assert.throws(()=>checkTypescript(root,ts),/Forbidden wiki/)));
test('workspace reexport resolves into forbidden app',()=>fixture({
 'wikibrowser/src/start.ts':'import {x} from "@fixture/bridge"',
 'packages/bridge/package.json':JSON.stringify({name:'@fixture/bridge',exports:{'.':'./src/index.ts'}}),
 'packages/bridge/src/index.ts':'export * from "../../../vaultbrowser/src/private"',
 'vaultbrowser/src/private.ts':'export const x=1'
},root=>assert.throws(()=>checkTypescript(root,ts),/Forbidden wiki/)));
test('shared UI cannot reach relative persistence helper',()=>fixture({
 'packages/ui/src/button.ts':'import {x} from "../../helper/src/index"',
 'packages/helper/src/index.ts':'export {x} from "@icp-sdk/auth"'
},root=>assert.throws(()=>checkTypescript(root,ts),/Forbidden ui/)));
test('both apps may use shared UI, type package metadata does not create edges',()=>fixture({
 'wikibrowser/src/start.ts':'import {x} from "@kinic/ui/button"',
 'vaultbrowser/src/start.ts':'import {x} from "@kinic/ui/button"',
 'packages/ui/package.json':JSON.stringify({name:'@kinic/ui',exports:{'./button':'./src/button.ts'},devDependencies:{'@kinic/vfs-candid':'workspace:*'}}),
 'packages/ui/src/button.ts':'export const x=1'
},root=>checkTypescript(root,ts)));

test('shared UI cannot hide fetch in an extension-mapped relative helper',()=>fixture({
 'packages/ui/src/button.ts':'export * from "../../helper/src/index.js"',
 'packages/helper/src/index.ts':'export const x = () => fetch("https://example.com")'
},root=>assert.throws(()=>checkTypescript(root,ts),/Forbidden ui/)));

for (const path of ['wikibrowser/lib/auth-client.ts','wikibrowser/components/app-session-provider.tsx','crates/vfs_runtime/Cargo.toml','packages/helper/src/bridge.ts']) test(`CI selects boundary input ${path}`,()=>assert.equal(selectsVault([path]),true));
test('CI invokes the tested selector CLI and writes a GitHub output',()=>{
 assert.match(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8'),/node scripts\/vault-ci-paths\.mjs/);
 const dir=mkdtempSync(resolve(tmpdir(),'vault-ci-'));
 try {
  const output=resolve(dir,'outputs');
  const result=spawnSync(process.execPath,[new URL('./vault-ci-paths.mjs',import.meta.url).pathname],{input:'packages/ui/src/button.tsx\n',env:{...process.env,GITHUB_OUTPUT:output}});
  assert.equal(result.status,0,result.stderr?.toString());
  assert.equal(readFileSync(output,'utf8'),'vault=true\n');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

for (const dependency of ['node:fs/promises','axios','idb']) test(`shared UI rejects persistence/network package ${dependency}`,()=>fixture({
 'packages/ui/src/button.ts':`import * as service from "${dependency}"`
},root=>assert.throws(()=>checkTypescript(root,ts),/Forbidden ui/)));

// These static imports must not bypass the graph by changing literal syntax or adding attributes.
for (const edge of [
 'const x = import(`../../vaultbrowser/src/private`)',
 'const x = import("../../vaultbrowser/src/private", { with: { type: "json" } })',
 'const x = import(`../../vaultbrowser/src/private`, { with: { type: "json" } })',
]) test(`relative file graph rejects ${edge}`, () => fixture({
 'wikibrowser/src/start.ts': edge,
 'vaultbrowser/src/private.ts': 'export const x = 1',
}, root => assert.throws(() => checkTypescript(root, ts), /Forbidden wiki/)));

for (const target of ['kinic-vfs-types', 'kinic-wiki-domain']) test(`Cargo rejects actual workspace package name ${target}`, () => {
 assert.throws(() => checkCargo({
  packages: [{ id: 'vault-service', name: 'vault-service' }, { id: target, name: target }],
  resolve: { nodes: [{ id: 'vault-service', deps: [{ pkg: target }] }, { id: target, deps: [] }] },
 }), /Forbidden vault/);
});

for (const entry of [
 'import { useAppSession } from "../../wikibrowser/components/app-session-provider"',
 'import { useAppSession } from "@fixture/session"',
]) test(`Vault cannot import Wiki session through ${entry}`, () => fixture({
 'vaultbrowser/src/start.ts': entry,
 'wikibrowser/components/app-session-provider.tsx': 'export const useAppSession = () => null',
 'packages/session/package.json': JSON.stringify({ name: '@fixture/session', exports: './index.ts' }),
 'packages/session/index.ts': 'export * from "../../wikibrowser/components/app-session-provider"',
}, root => assert.throws(() => checkTypescript(root, ts), /Forbidden vault/)));

test('Wiki root alias resolves session provider reexports into Vault', () => fixture({
 'wikibrowser/src/start.ts': 'import {x} from "@/components/app-session-provider"',
 'wikibrowser/components/app-session-provider.tsx': 'export * from "../../vaultbrowser/src/private"',
 'vaultbrowser/src/private.ts': 'export const x = 1',
}, root => assert.throws(() => checkTypescript(root, ts), /Forbidden wiki/)));

test('checker rejects an optional target-specific Cargo cross-app dependency', () => fixture({
 'Cargo.toml': '[workspace]\nmembers = ["wiki", "vault"]\nresolver = "2"\n',
 'wiki/Cargo.toml': '[package]\nname = "vfs-fixture"\nversion = "0.1.0"\nedition = "2021"\n[target.\'cfg(target_arch = "wasm32")\'.dependencies]\nvault-fixture = {path = "../vault", optional = true}\n',
 'wiki/src/lib.rs': '',
 'vault/Cargo.toml': '[package]\nname = "vault-fixture"\nversion = "0.1.0"\nedition = "2021"\n',
 'vault/src/lib.rs': '',
 'crates/vfs_canister/src/lib.rs': '',
 'crates/vfs_canister/vfs.did': '',
 'crates/vfs_canister/Cargo.toml': '',
 'crates/vfs_runtime/src/lib.rs': '',
 'crates/vfs_runtime/Cargo.toml': '',
 'packages/vfs-candid/index.ts': '',
 'wikibrowser/components/admin-shell.tsx': 'export const url = "/dashboard"',
 'vaultbrowser/icp.yaml': 'name: vault',
 'vaultbrowser/src/start.ts': '',
 'packages/ui/src/index.ts': '',
 'packages/vault-client/src/index.ts': '',
}, root => {
 for (const file of ['check-vault-boundary.mjs', 'vault-boundary-graph.mjs']) {
  mkdirSync(resolve(root, 'scripts'), {recursive:true});
  writeFileSync(resolve(root, 'scripts', file), readFileSync(new URL(file, import.meta.url)));
 }
 symlinkSync(new URL('../node_modules', import.meta.url).pathname, resolve(root, 'node_modules'), 'dir');
 const lock = spawnSync('cargo', ['generate-lockfile', '--offline'], {cwd:root, encoding:'utf8'});
 assert.equal(lock.status, 0, lock.stderr);
 const result = spawnSync(process.execPath, [resolve(root, 'scripts/check-vault-boundary.mjs')], {encoding:'utf8', env:{...process.env, CARGO_NET_OFFLINE:'true'}});
 assert.notEqual(result.status, 0);
 assert.match(result.stderr, /Forbidden wiki dependency/);
}));

for (const statement of [
 'import Auth = require("@icp-sdk/auth")',
 'const Auth = require("@icp-sdk/auth")',
 'type Auth = import("@icp-sdk/auth").AuthClient',
]) test(`shared UI rejects alternate dependency syntax ${statement}`, () => fixture({
 'packages/ui/src/button.ts': statement,
}, root => assert.throws(() => checkTypescript(root, ts), /Forbidden ui/)));

for (const statement of [
 'import Wiki = require("@kinic/vfs-candid")',
 'const Wiki = require("@kinic/vfs-candid")',
 'type Wiki = import("@kinic/vfs-candid")._SERVICE',
]) test(`Vault rejects alternate Wiki dependency syntax ${statement}`, () => fixture({
 'vaultbrowser/src/start.ts': statement,
 'packages/vfs-candid/package.json': JSON.stringify({name:'@kinic/vfs-candid', exports:'./index.ts'}),
 'packages/vfs-candid/index.ts': 'export interface _SERVICE {}',
}, root => assert.throws(() => checkTypescript(root, ts), /Forbidden vault/)));

test('shared UI JavaScript cannot require a network service with a static template', () => fixture({
 'packages/ui/src/button.cjs': 'const Auth = require(`@icp-sdk/auth`)',
}, root => assert.throws(() => checkTypescript(root, ts), /Forbidden ui/)));
