import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idlFactory as vaultIDL } from '../../packages/vault-candid/index.js';
import { idlFactory as wikiIDL } from '../../packages/vfs-candid/index.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
const local = createRequire(new URL('../package.json', import.meta.url));
const req = createRequire(realpathSync(local.resolve('@dfinity/pic')));
const {
  PocketIc,
  PocketIcServer
} = req('@dfinity/pic');
const {
  IDL
} = req('@icp-sdk/core/candid');
const {
  Principal
} = req('@icp-sdk/core/principal');
if (process.env.POCKET_IC_BIN) PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(90));
const other = Principal.selfAuthenticating(new Uint8Array(32).fill(91));
const ok = r => {
  assert.ok('Ok' in r);
  return r.Ok;
};
const server = await PocketIcServer.start();
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  const wasm = resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm');
  const {
    actor,
    canisterId
  } = await pic.setupCanister({
    sender: owner,
    idlFactory: vaultIDL,
    wasm,
    arg: IDL.encode([], []),
    cycles: 100_000_000_000_000n
  });
  actor.setPrincipal(owner);
  assert.equal(ok(await actor.account_balance()), 0n);
  assert.deepEqual(ok(await actor.get_config()), []);
  const config = {
    origin: 'https://vault.kinic.xyz',
    rp_id: 'vault.kinic.xyz',
    key_name: 'key_1',
    minimum_cycles: 100_000_000_000n
  };
  ok(await actor.set_config([config]));
  assert.ok('Err' in (await actor.reserve_vault({
    vault: new Uint8Array(16),
    operation: new Uint8Array(16).fill(1)
  })));
  actor.setPrincipal(other);
  assert.ok('Err' in (await actor.set_config([])));
  assert.equal(ok(await actor.account_balance()), 0n);
  actor.setPrincipal(owner);
  for (const path of ['/', '/config.json', '/.well-known/ii-alternative-origins']) {
    const r = await actor.http_request({
      url: path,
      method: 'GET',
      body: new Uint8Array(),
      headers: [],
      certificate_version: [2]
    });
    assert.equal(r.status_code, 200);
    const headers = new Map(r.headers.map(([k, v]) => [k.toLowerCase(), v]));
    assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.ok(headers.has('ic-certificate'));
    if (path === '/config.json') {
      const c = JSON.parse(new TextDecoder().decode(r.body));
      assert.equal(c.canister, canisterId.toText());
      assert.equal(c.derivationOrigin, `https://${canisterId.toText()}.icp0.io`);
    }
    if (path.endsWith('ii-alternative-origins')) assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body)), {
      alternativeOrigins: ['https://vault.kinic.xyz']
    });
  }
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], [])
  });
  assert.deepEqual(ok(await actor.get_config()), [config]);
  assert.equal(ok(await actor.account_balance()), 0n);
  // Exercise the real funding API against a separate synthetic ledger canister.
  const accountIDL = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8))
  });
  const transferIDL = IDL.Record({
    spender_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    from: accountIDL,
    to: accountIDL,
    amount: IDL.Nat,
    fee: IDL.Opt(IDL.Nat),
    memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64)
  });
  const fakeIDL = () => IDL.Service({
    configure: IDL.Func([IDL.Nat8, IDL.Nat64], [], []),
    fee_behavior: IDL.Func([IDL.Bool, IDL.Bool], [], []),
    fee_calls: IDL.Func([], [IDL.Nat64], ['query']),
    calls: IDL.Func([], [IDL.Vec(transferIDL)], ['query'])
  });
  const fake = await pic.setupCanister({
    sender: owner,
    idlFactory: fakeIDL,
    wasm: resolve(root, 'target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm'),
    arg: IDL.encode([], []),
    cycles: 10_000_000_000_000n
  });
  fake.actor.setPrincipal(owner);
  ok(await actor.set_funding_config([{
    ledger: fake.canisterId,
    recipient: canisterId,
    cycles_per_kinic: 1_000_000_000n
  }]));
  const request = async n => ({
    operation: new Uint8Array(16).fill(n),
    beneficiary: other,
    amount_e8s: 100_000_000n,
    min_credits: 1_000_000_000n,
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n
  });
  // Admission must happen before any ledger call, including malformed requests.
  const feeBefore = await fake.actor.fee_calls();
  for (const changes of [{
    amount_e8s: 0n
  }, {
    min_credits: 0n
  }, {
    min_credits: 2_000_000_000n
  }, {
    operation: new Uint8Array(15)
  }, {
    created_at_time: 0n
  }]) {
    assert.ok('Err' in (await actor.quote_purchase({
      ...(await request(80)),
      ...changes
    })));
    assert.equal(await fake.actor.fee_calls(), feeBefore, 'invalid request dispatched a fee lookup');
  }
  const until = async observe => {
    for (let i = 0; i < 100; i++) {
      if (await observe()) return;
      await pic.tick();
    }
    assert.fail('delayed fee condition was not reached');
  };
  const release = async held => {
    await pic.mockPendingHttpsOutcall({
      requestId: held.requestId,
      subnetId: held.subnetId,
      response: {
        type: 'success',
        statusCode: 200,
        headers: [],
        body: new Uint8Array()
      }
    });
    await pic.tick(10);
  };
  await fake.actor.fee_behavior(true, false);
  const finishes = [];
  for (let i = 0; i < 8; i++) {
    const deferred = pic.createDeferredActor(vaultIDL, canisterId);
    deferred.setPrincipal(Principal.selfAuthenticating(new Uint8Array(32).fill(100 + i)));
    finishes.push(await deferred.quote_purchase(await request(90 + i)));
  }
  await until(async () => (await fake.actor.fee_calls()) === feeBefore + 8n);
  actor.setPrincipal(Principal.selfAuthenticating(new Uint8Array(32).fill(100)));
  assert.ok('Err' in (await actor.quote_purchase(await request(110))));
  actor.setPrincipal(owner);
  assert.ok('Err' in (await actor.quote_purchase(await request(111))));
  assert.equal(await fake.actor.fee_calls(), feeBefore + 8n, 'over-limit request dispatched a fee lookup');
  const held = await pic.getPendingHttpsOutcalls();
  assert.equal(held.length, 8);
  for (const h of held) await release(h);
  for (const finish of finishes) ok(await finish());
  await fake.actor.fee_behavior(false, false);
  // A full wallet's completed quotes also stop fee lookup before dispatch.
  const fullWallet = Principal.selfAuthenticating(new Uint8Array(32).fill(120));
  actor.setPrincipal(fullWallet);
  for (let i = 0; i < 16; i++) ok(await actor.quote_purchase(await request(130 + i)));
  const fullCount = await fake.actor.fee_calls();
  assert.ok('Err' in (await actor.quote_purchase(await request(150))));
  assert.equal(await fake.actor.fee_calls(), fullCount);
  actor.setPrincipal(owner);
  // Fee decode failure releases the slot, so the same unpaid operation can retry.
  await fake.actor.fee_behavior(false, true);
  const failedFee = await request(151);
  assert.ok('Err' in (await actor.quote_purchase(failedFee)));
  await fake.actor.fee_behavior(false, false);
  ok(await actor.quote_purchase(failedFee));
  // Bounded timeout releases a lease; its late reply cannot overwrite a fresh one.
  await fake.actor.fee_behavior(true, false);
  const deferred = pic.createDeferredActor(vaultIDL, canisterId);
  deferred.setPrincipal(owner);
  const timeoutReq = await request(152);
  const timeoutFinish = await deferred.quote_purchase(timeoutReq);
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === 1);
  const timed = (await pic.getPendingHttpsOutcalls())[0];
  await pic.advanceTime(61_000);
  await pic.tick(20);
  assert.ok('Err' in (await timeoutFinish()));
  const oldFeeStillPending = (await pic.getPendingHttpsOutcalls()).some(h => h.requestId === timed.requestId);
  const replacementFinish = await deferred.quote_purchase({
    ...timeoutReq,
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n
  });
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === (oldFeeStillPending ? 2 : 1));
  const replacement = (await pic.getPendingHttpsOutcalls()).find(h => h.requestId !== timed.requestId);
  if (oldFeeStillPending) await release(timed);
  assert.deepEqual(ok(await actor.payment_status(timeoutReq.operation)), []);
  await release(replacement);
  ok(await replacementFinish());
  // Upgrade invalidates a fee lease. A fresh lease for the same operation survives
  // the old management HTTP reply, then alone publishes its quote.
  const upgradeReq = await request(153);
  await deferred.quote_purchase(upgradeReq);
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === 1);
  const oldHeld = (await pic.getPendingHttpsOutcalls())[0];
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], [])
  });
  const upgradeFinish = await deferred.quote_purchase({
    ...upgradeReq,
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n
  });
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === 2);
  const newHeld = (await pic.getPendingHttpsOutcalls()).find(h => h.requestId !== oldHeld.requestId);
  await release(oldHeld);
  assert.deepEqual(ok(await actor.payment_status(upgradeReq.operation)), []);
  await release(newHeld);
  ok(await upgradeFinish());
  await fake.actor.fee_behavior(false, false);
  console.log('PASS fee admission: invalid/full-wallet/over-flight limits dispatch no ledger call; delayed fee failure, timeout, late callback and upgrade recovery remain fenced.');
  await fake.actor.configure(6, 10n);
  const req = await request(40);
  const quote = ok(await actor.quote_purchase(req));
  assert.equal(quote.fee, 10n);
  actor.setPrincipal(other);
  assert.ok('Err' in (await actor.pay_purchase(req.operation)));
  actor.setPrincipal(owner);
  const unknown = ok(await actor.pay_purchase(req.operation));
  assert.ok('Unknown' in unknown.status);
  await fake.actor.configure(4, 20n);
  const paid = ok(await actor.pay_purchase(req.operation));
  assert.ok('Paid' in paid.status);
  const calls = await fake.actor.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].from.owner.toText(), owner.toText());
  assert.equal(calls[0].to.owner.toText(), canisterId.toText());
  assert.deepEqual(calls[0].fee, [10n]);
  assert.deepEqual(calls[0].created_at_time, [quote.created_at_time]);
  assert.ok('Err' in (await actor.pay_purchase(req.operation)));
  assert.equal((await fake.actor.calls()).length, 2);
  assert.equal(ok(await actor.account_balance()), 0n);
  actor.setPrincipal(other);
  assert.equal(ok(await actor.account_balance()), 1_000_000_000n);
  actor.setPrincipal(owner);
  await fake.actor.configure(0, 20n);
  const bad = await request(41);
  assert.equal(ok(await actor.quote_purchase(bad)).fee, 20n);
  await fake.actor.configure(1, 30n);
  assert.deepEqual(ok(await actor.pay_purchase(bad.operation)).status, {
    BadFee: 30n
  });
  for (const [id, mode, status] of [[42, 2, 'InsufficientAllowance'], [43, 3, 'InsufficientFunds']]) {
    await fake.actor.configure(mode, 30n);
    const req = await request(id);
    ok(await actor.quote_purchase(req));
    assert.ok(status in ok(await actor.pay_purchase(req.operation)).status);
  }
  actor.setPrincipal(other);
  assert.equal(ok(await actor.account_balance()), 1_000_000_000n);
  const reserved = ok(await actor.reserve_vault({
    vault: new Uint8Array(16).fill(7),
    operation: new Uint8Array(16).fill(8)
  }));
  assert.equal(reserved.epoch, 0n);
  actor.setPrincipal(owner);
  assert.ok('Err' in (await actor.get_vault_header(reserved.id)));
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], [])
  });
  actor.setPrincipal(other);
  assert.equal(ok(await actor.list_unfinished_vaults()).length, 1);
  actor.setPrincipal(owner);
  assert.ok('Paid' in ok(await actor.payment_status(req.operation))[0].status);
  console.log('PASS dedicated ICRC-2 API with fake ledger: caller source and explicit beneficiary, dynamic fee, ambiguous-to-Duplicate exact retry, one credit, allowance/balance/BadFee statuses, paid state and owner data survive upgrade. No real token transfer.');
  // Wiki's DID and binary expose no Vault API and remain independently upgradeable.
  const billing = IDL.Record({
    kinic_ledger_canister_id: IDL.Text,
    billing_authority_id: IDL.Text,
    iap_authority_id: IDL.Opt(IDL.Text),
    cycles_per_kinic: IDL.Nat64,
    min_update_cycles: IDL.Nat64,
    top_up: IDL.Record({
      enabled: IDL.Bool,
      threshold_cycles: IDL.Nat,
      launcher_principal: IDL.Text
    })
  });
  const wiki = await pic.setupCanister({
    sender: owner,
    idlFactory: wikiIDL,
    wasm: resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'),
    arg: IDL.encode([billing], [{
      kinic_ledger_canister_id: 'aaaaa-aa',
      billing_authority_id: owner.toText(),
      iap_authority_id: [],
      cycles_per_kinic: 1000n,
      min_update_cycles: 1000000n,
      top_up: {
        enabled: false,
        threshold_cycles: 1000000000n,
        launcher_principal: 'aaaaa-aa'
      }
    }]),
    cycles: 100_000_000_000_000n
  });
  wiki.actor.setPrincipal(owner);
  const db = ok(await wiki.actor.create_database({
    name: 'independent Wiki'
  })).database_id;
  ok(await wiki.actor.write_node({
    database_id: db,
    path: '/marker.md',
    kind: {
      File: null
    },
    content: 'Wiki independently survives',
    metadata_json: '{}',
    expected_etag: []
  }));
  await pic.upgradeCanister({
    sender: owner,
    canisterId: wiki.canisterId,
    wasm: resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'),
    arg: IDL.encode([], [])
  });
  assert.equal(ok(await wiki.actor.read_node(db, '/marker.md'))[0].content, 'Wiki independently survives');
  assert.deepEqual(ok(await actor.get_config()), [config]);
  assert.ok(!Object.keys(wiki.actor).some(name => name.startsWith('vault_')));
  console.log('PASS actual dedicated Vault/Wiki Wasm: separate init/upgrade, no free account, controller config, certified own SPA/config/II origins, no embedding, unchanged Wiki marker. Only synthetic ledger transfers executed.');
} finally {
  if (pic) await pic.tearDown();
  await server.stop();
}
