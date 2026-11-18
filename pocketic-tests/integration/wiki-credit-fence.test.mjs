// Real two-canister admission test. Unknown revocations are temporary fences;
// an admitted pair retains a permanent fence and cannot be displaced.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';
import { idlFactory as vaultFactory } from '../../packages/vault-candid/index.js';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const sdk = createRequire(realpathSync(require.resolve('@dfinity/pic')));
const { IDL } = sdk('@icp-sdk/core/candid');
const { Principal } = sdk('@icp-sdk/core/principal');
const { PocketIc } = require('@dfinity/pic');
const who = (n) => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, n);
  return Principal.selfAuthenticating(bytes);
};
const ok = (result) => {
  assert.ok('Ok' in result, JSON.stringify(result, (_, v) => typeof v === 'bigint' ? String(v) : v));
  return result.Ok;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const binary = process.env.POCKET_IC_BIN;
assert.ok(binary, 'POCKET_IC_BIN must point to the verified PocketIC 16.1 server');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const wikiBinding = execFileSync('didc', ['bind', '--target', 'js', resolve(root, 'crates/vfs_canister/vfs.did')], { encoding: 'utf8' });
const { idlFactory: wikiFactory, init } = await import(`data:text/javascript;base64,${Buffer.from(wikiBinding).toString('base64')}`);
const wikiWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const vaultWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const server = await startVaultPocketIc(binary);
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  await pic.setTime(Date.now());
  const admin = who(7), owner = who(2000), wikiOwner = who(4000);
  const config = {
    kinic_ledger_canister_id: 'aaaaa-aa', billing_authority_id: admin.toText(),
    iap_authority_id: [admin.toText()], cycles_per_kinic: 1000n,
    min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' },
  };
  const wiki = await pic.setupCanister({
    sender: admin, idlFactory: wikiFactory, wasm: wikiWasm,
    arg: IDL.encode(init({ IDL }), [config]), cycles: 100_000_000_000_000n,
  });
  const vault = await pic.setupCanister({
    sender: admin, idlFactory: vaultFactory, wasm: vaultWasm,
    cycles: 100_000_000_000_000n,
  });
  wiki.actor.setPrincipal(admin);
  vault.actor.setPrincipal(admin);
  const limits = { enabled: true, daily_limit_cycles: 1_000_000_000_000n, physical_reserve_cycles: 10_000_000_000_000n };
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId }));
  ok(await vault.actor.set_wiki_bridge_config({ ...limits, peer: wiki.canisterId }));

  vault.actor.setPrincipal(who(2500));
  const admitted = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(11)));
  wiki.actor.setPrincipal(who(4500));
  assert.equal(ok(await wiki.actor.approve_vault_link(admitted.challenge)).active, true);
  for (let n = 0; n < 1023; n++) {
    vault.actor.setPrincipal(who(3000 + n));
    ok(await vault.actor.revoke_wiki_link());
  }
  vault.actor.setPrincipal(owner);
  const first = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(1)));
  wiki.actor.setPrincipal(wikiOwner);
  const beforeExpiry = await wiki.actor.approve_vault_link(first.challenge);
  assert.ok('Err' in beforeExpiry && 'Capacity' in beforeExpiry.Err);

  await pic.advanceTime(300_001);
  wiki.actor.setPrincipal(who(4500));
  assert.equal(ok(await wiki.actor.get_vault_link())[0].active, true);
  vault.actor.setPrincipal(owner);
  const fresh = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(2)));
  wiki.actor.setPrincipal(wikiOwner);
  const link = ok(await wiki.actor.approve_vault_link(fresh.challenge));
  assert.equal(link.active, true);
  assert.equal(link.vault_owner.toText(), owner.toText());
  assert.equal(link.wiki_owner.toText(), wikiOwner.toText());
  console.log(JSON.stringify({
    unknownRevocations: 1023, permanentPairsPreserved: 1, beforeExpiry: 'Capacity', afterExpiry: 'Linked',
    wasmSha256: { wiki: hash(wikiWasm), vault: hash(vaultWasm) },
    actualCanisterCalls: true, productionDeployment: false,
  }));
} finally {
  try { await pic?.tearDown(); } finally { await server.stop(); }
}
