import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import {
  fixture,
  ok,
  err,
  owner,
  other,
  out,
  IDL,
  b,
  operation,
  VaultClient,
  cryptoLib,
} from "../helpers/vault-current.mjs";
import { idlFactory as wikiIDL } from "../../packages/vfs-candid/index.ts";
const f = await fixture();
let client;
try {
  client = new VaultClient({
    actor: f.actor,
    identity: { getPrincipal: () => owner },
    canister: f.canisterId.toText(),
    local: true,
  });
  const header = await client.create();
  await client.open(header);
  const measure = async () => ({
    physical: (
      await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner })
    ).memorySize,
    logical: ok(await f.actor.global_capacity()).used,
  });
  const before = await measure(),
    plain = cryptoLib.randomBytes(2 * 1024 * 1024);
  const revision = await client.save(
      {
        kind: "attachment",
        title: "physical separation",
        filename: "memory.bin",
      },
      plain,
    ),
    after = await measure();
  assert.ok(after.physical > before.physical);
  assert.ok(after.logical > before.logical);
  const h = ok(await f.actor.get_vault_header(header.id)),
    manifest = ok(await f.actor.get_manifest(header.id, revision.object, 1n)),
    module = (
      await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner })
    ).moduleHash;
  const billing = IDL.Record({
    kinic_ledger_canister_id: IDL.Text,
    billing_authority_id: IDL.Text,
    iap_authority_id: IDL.Opt(IDL.Text),
    cycles_per_kinic: IDL.Nat64,
    min_update_cycles: IDL.Nat64,
    top_up: IDL.Record({
      enabled: IDL.Bool,
      threshold_cycles: IDL.Nat,
      launcher_principal: IDL.Text,
    }),
  });
  const wiki = await f.pic.setupCanister({
    sender: owner,
    idlFactory: wikiIDL,
    wasm: resolve(out, "vfs_canister.wasm"),
    cycles: 100_000_000_000_000n,
    arg: IDL.encode(
      [billing],
      [
        {
          kinic_ledger_canister_id: f.fake.canisterId.toText(),
          billing_authority_id: owner.toText(),
          iap_authority_id: [],
          cycles_per_kinic: 1000n,
          min_update_cycles: 1000000n,
          top_up: {
            enabled: false,
            threshold_cycles: 1000000000n,
            launcher_principal: "aaaaa-aa",
          },
        },
      ],
    ),
  });
  wiki.actor.setPrincipal(owner);
  const database_id = ok(
    await wiki.actor.create_database({ name: "separate Wiki" }),
  ).database_id;
  ok(
    await wiki.actor.write_node({
      database_id,
      path: "/marker.md",
      kind: { File: null },
      content: "Wiki-only marker",
      metadata_json: "{}",
      expected_etag: [],
    }),
  );
  await f.pic.tick(150);
  await f.pic.upgradeCanister({
    sender: owner,
    canisterId: wiki.canisterId,
    wasm: resolve(out, "vfs_canister.wasm"),
    arg: IDL.encode([], []),
  });
  assert.equal(
    ok(await wiki.actor.read_node(database_id, "/marker.md"))[0].content,
    "Wiki-only marker",
  );
  ok(await wiki.actor.delete_database({ database_id }));
  assert.ok("Err" in (await wiki.actor.read_node(database_id, "/marker.md")));
  assert.deepEqual(ok(await f.actor.get_vault_header(header.id)), h);
  assert.deepEqual(
    ok(await f.actor.get_manifest(header.id, revision.object, 1n)),
    manifest,
  );
  assert.deepEqual(
    (await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner }))
      .moduleHash,
    module,
  );
  client.session.lock();
  await client.open(h);
  assert.deepEqual((await client.read(revision)).plaintext, plain);
  err(
    await f.actorFor(other).get_manifest(header.id, revision.object, 1n),
    "NotFound",
  );
  writeFileSync(
    resolve(out, "physical-memory.json"),
    JSON.stringify(
      {
        before,
        after,
        payload_bytes: plain.length,
        meaning:
          "Total canister memory, not exact heap attribution; logical limit is independent.",
      },
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
  );
  console.log(
    "PASS real 2MiB ciphertext grows physical/logical memory; Wiki create/write/upgrade/delete leaves independent Vault header, ciphertext, module and freshly derived root unchanged",
  );
} finally {
  client?.destroy();
  await f.close();
}
const production = await fixture({
  wasm: resolve(out, "vault_canister.wasm"),
  fund: false,
});
try {
  const config = {
    ledger: production.fake.canisterId,
    recipient: production.canisterId,
    cycles_per_kinic: 1000000000n,
  };
  ok(await production.actor.set_funding_config([config]));
  assert.ok(
    "Err" in
      (await production.actor.quote_purchase({
        operation: operation(),
        beneficiary: owner,
        amount_e8s: 100000000n,
        min_credits: 1n,
        created_at_time: BigInt(await production.pic.getTime()) * 1000000n,
      })),
  );
  assert.ok("Err" in (await production.actor.pay_purchase(operation())));
  assert.equal(ok(await production.actor.account_balance()), 0n);
  await assert.rejects(
    production.controls.fixture_execute("SELECT 1"),
    /method|Method/,
  );
  await assert.rejects(
    production.controls.fixture_read("SELECT 'test'"),
    /method|Method/,
  );
  assert.ok(
    "Err" in
      (await production.actor.create_vault({
        vault: b(1),
        operation: operation(),
      })),
  );
  console.log(
    "PASS dedicated production Wasm funding compiled unavailable, no test control exports, unfunded content admission denied",
  );
} finally {
  await production.close();
}
