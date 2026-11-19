// LOCAL ONLY: real vetKD + signed native calls; all operating credit is synthetic.
// Prerequisites: build-vault-client-acceptance, build-vault-ledger, and a current
// --features synthetic-funding-test-only Wasm at KINIC_NATIVE_TEST_VAULT_WASM.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';
import { createVaultPocketIcWithTestKeys } from '../helpers/vault-pocketic-test-keys.mjs';
import { idlFactory } from '../../packages/vault-candid/index.js';
import { VaultClient, documents } from '../../target/vault-ii-acceptance/client/client.mjs';
const local = createRequire(new URL('../package.json', import.meta.url));
const require = createRequire(realpathSync(local.resolve('@dfinity/pic')));
const { PocketIcServer } = require('@dfinity/pic');
const { Ed25519KeyIdentity } = require('@icp-sdk/core/identity');
const { HttpAgent } = require('@icp-sdk/core/agent');
const { IDL } = require('@icp-sdk/core/candid');
const root = resolve(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'kinic-native-vault-'));
const seed = new Uint8Array(32).fill(42); // disposable test identity, never a user's identity
const identity = Ed25519KeyIdentity.generate(seed);
const owner = identity.getPrincipal();
let counter = 0;
const operation = () => { const data = new Uint8Array(16); new DataView(data.buffer).setUint32(12, ++counter); return data; };
const ok = result => { assert.ok('Ok' in result, `Vault rejected fixture setup: ${Object.keys(result.Err ?? {})}`); return result.Ok; };
const server = await startVaultPocketIc(process.env.POCKET_IC_BIN ?? PocketIcServer.getBinPath());
let pic;
let web;
try {
  pic = await createVaultPocketIcWithTestKeys(server.getUrl(), { nns: { state: { type: 'new' } }, application: [{ state: { type: 'new' } }], fiduciary: { state: { type: 'new' } }, icpConfig: { betaFeatures: 'Enabled' } });
  await pic.setTime(Date.now());
  const { actor, canisterId } = await pic.setupCanister({ sender: owner, idlFactory, wasm: resolve(root, process.env.KINIC_NATIVE_TEST_VAULT_WASM ?? '.local/vault-native-pocketic-target/wasm32-unknown-unknown/release/vault_canister.wasm'), cycles: 100_000_000_000_000n });
  actor.setPrincipal(owner);
  ok(await actor.set_config([{ key_name: 'key_1', minimum_cycles: 100_000_000_000n }]));
  const ledger = await pic.setupCanister({ sender: owner, idlFactory: () => IDL.Service({ configure: IDL.Func([IDL.Nat8, IDL.Nat64], [], []) }), wasm: resolve(root, 'target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm'), cycles: 100_000_000_000_000n });
  ledger.actor.setPrincipal(owner); await ledger.actor.configure(0, 10n);
  ok(await actor.set_funding_config([{ ledger: ledger.canisterId, recipient: canisterId, cycles_per_kinic: 2_000_000_000_000n }]));
  const payment = operation();
  ok(await actor.quote_purchase({ operation: payment, beneficiary: owner, amount_e8s: 100_000_000n, min_credits: 2_000_000_000_000n, created_at_time: BigInt(await pic.getTime()) * 1_000_000n }));
  assert.ok('Paid' in ok(await actor.pay_purchase(payment)).status);
  web = new VaultClient({ actor, identity, canister: canisterId.toText(), local: true });
  const header = await web.create(); await web.open(header);
  await web.save({ kind: 'credential', title: 'Native round-trip', username: 'native-user', domains: ['example.com'], hasTotp: true }, new TextEncoder().encode(JSON.stringify({ username: 'native-user', password: 'local-only-password', URL: 'https://example.com', totp: 'JBSWY3DPEHPK3PXP' })));
  const port = await pic.makeLive(); const replica = `http://127.0.0.1:${port}`;
  const agent = await HttpAgent.create({ host: replica, shouldFetchRootKey: true });
  const file = join(directory, 'fixture.json'); const output = join(directory, 'swift-ciphertext.json');
  writeFileSync(file, JSON.stringify({ replica, canister: canisterId.toText(), rootKey: Buffer.from(agent.rootKey).toString('base64'), seed: Buffer.from(seed).toString('base64'), principal: owner.toText(), swiftCipherOutput: output }), { mode: 0o600 });
  // SwiftPM may spend over a minute preparing a test runner. Keep PocketIC's
  // default idle TTL alive without changing replica time or bypassing calls.
  const heartbeat = setInterval(() => { void pic.getTime().catch(() => {}); }, 10_000);
  let code;
  try { code = await new Promise((resolveCode, reject) => {
    const child = spawn('swift', ['test', '--disable-sandbox', '--package-path', 'mobile/ios/Packages/KinicVaultNative', '--scratch-path', process.env.KINIC_NATIVE_SWIFT_SCRATCH ?? '/private/tmp/kinic-vault-native-swift', '--filter', 'localReplicaRoundTrip'], { cwd: root, env: { ...process.env, KINIC_NATIVE_VAULT_FIXTURE: file }, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolveCode);
  }); } finally { clearInterval(heartbeat); }
  assert.equal(code, 0, 'Native real-replica integration failed');
  const encrypted = JSON.parse(readFileSync(output, 'utf8'));
  const unb64 = documents.unb64;
  const context = { canister: canisterId.toText(), owner: owner.toText(), vault: new Uint8Array(header.id), nonce: new Uint8Array(header.nonce), key_name: header.key_name };
  const doc = await documents.decryptDocumentV3(web.session.root, context, unb64(encrypted.object), 1n, unb64(encrypted.manifest), encrypted.chunks.map(unb64), encrypted.hashes.map(unb64));
  assert.equal(new TextDecoder().decode(doc.plaintext), 'Swift to Web root continuity'); doc.plaintext.fill(0);
  console.log('Native signed calls, real vetKD, encrypted AutoFill cache, and Web ↔ Swift root continuity PASS (synthetic credit only).');
} finally {
  web?.destroy();
  try { await pic?.tearDown(); } finally { await server.stop(); rmSync(directory, { recursive: true, force: true }); }
}
