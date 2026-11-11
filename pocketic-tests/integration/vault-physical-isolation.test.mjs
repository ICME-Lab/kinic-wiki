// Empirical physical memory versus logical quota, with actual encrypted bytes.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { encryptDocument } from "../../packages/vault-crypto/src/documents.ts";
import { idlFactory as wikiIDL } from "../../packages/vfs-candid/index.ts";
import {
  restoreFixture,
  ok,
  b,
  owner,
  other,
  IDL,
  cryptoLib,
  root,
} from "../helpers/vault-restore-fixture.mjs";
const f = await restoreFixture();
try {
  const measure = async () => ({
    physical: (
      await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner })
    ).memorySize,
    logical: ok(await f.actor.global_capacity()).used,
  });
  const before = await measure();
  await f.pic.advanceTime(421_000);
  const grant = await f.fresh({ Normal: null });
  const payload = cryptoLib.randomBytes(2 * 1024 * 1024);
  const encrypted = await encryptDocument(
    f.sourceRoot,
    f.sourceG.vault,
    b(211),
    1n,
    {
      kind: "attachment",
      title: "physical-memory-sample",
      filename: "sample.bin",
      mime: "application/octet-stream",
    },
    payload,
    f.cryptoG(f.sourceG),
  );
  const upload = ok(
    (
      await f.send(grant, {
        BeginRevision: {
          vault: f.sourceG.vault,
          object: b(211),
          expected_revision: 0n,
          operation: b(212),
          plain_size: BigInt(payload.length),
          manifest: encrypted.manifest,
          chunk_hashes: encrypted.hashes,
        },
      })
    ).result,
  ).Upload;
  for (const [index, data] of encrypted.chunks.entries())
    ok(
      (
        await f.send(grant, {
          PutChunk: { vault: f.sourceG.vault, upload: upload.id, index, data },
        })
      ).result,
    );
  ok(
    (
      await f.send(grant, {
        CommitRevision: { vault: f.sourceG.vault, upload: upload.id },
      })
    ).result,
  );
  const after = await measure();
  assert.ok(
    after.physical > before.physical,
    "Actual encrypted payload must grow physical canister memory",
  );
  assert.ok(
    after.logical > before.logical,
    "Actual payload must be billed logically",
  );
  const vaultModule = (
    await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner })
  ).moduleHash;
  const h = ok(await f.actor.get_vault_header(f.sourceG.vault));
  const manifest = ok(await f.actor.get_manifest(f.sourceG.vault, b(211), 1n));
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
    wasm: resolve(
      root,
      "target/wasm32-unknown-unknown/release/vfs_canister.wasm",
    ),
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
    cycles: 100_000_000_000_000n,
  });
  wiki.actor.setPrincipal(owner);
  const database_id = ok(
    await wiki.actor.create_database({ name: "independent lifecycle" }),
  ).database_id;
  ok(
    await wiki.actor.write_node({
      database_id,
      path: "/test.md",
      kind: { File: null },
      content: "Wiki test marker",
      metadata_json: "{}",
      expected_etag: [],
    }),
  );
  await f.pic.advanceTime(3_600_000);
  await f.pic.upgradeCanister({
    sender: owner,
    canisterId: wiki.canisterId,
    wasm: resolve(
      root,
      "target/wasm32-unknown-unknown/release/vfs_canister.wasm",
    ),
    arg: IDL.encode([], []),
  });
  assert.equal(
    ok(await wiki.actor.read_node(database_id, "/test.md"))[0].content,
    "Wiki test marker",
  );
  ok(await wiki.actor.delete_database({ database_id }));
  assert.ok("Err" in (await wiki.actor.read_node(database_id, "/test.md")));
  assert.deepEqual(ok(await f.actor.get_vault_header(f.sourceG.vault)), h);
  assert.deepEqual(
    ok(await f.actor.get_manifest(f.sourceG.vault, b(211), 1n)),
    manifest,
  );
  assert.deepEqual(
    (await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner }))
      .moduleHash,
    vaultModule,
  );
  const fresh = await f.fresh({ Normal: null });
  const transport = cryptoLib.TransportSecretKey.random();
  const handle = ok(
    (
      await f.send(fresh, {
        Derive: {
          vault: f.sourceG.vault,
          epoch: f.sourceG.epoch,
          attempt: [],
          assertion: [],
          transport: transport.publicKeyBytes(),
        },
      })
    ).result,
  ).Handle;
  const reply = ok((await f.send(fresh, { KeyResult: { handle } })).result).Key;
  const kek = await cryptoLib.verifiedGenerationKEK(
    new Uint8Array(reply.encrypted_key),
    transport,
    f.cryptoG(f.sourceG),
    true,
  );
  const opened = await cryptoLib.openV2(
    kek,
    h.normal[0],
    cryptoLib.generationAAD(f.cryptoG(f.sourceG), b(0), 0n, "normal"),
  );
  assert.deepEqual(new Uint8Array(opened), f.sourceRaw);
  f.actor.setPrincipal(other);
  assert.ok("Err" in (await f.actor.get_manifest(f.sourceG.vault, b(211), 1n)));
  f.actor.setPrincipal(owner);
  const report = {
    payload_bytes: payload.length,
    before,
    after,
    physical_growth: after.physical - before.physical,
    logical_growth: after.logical - before.logical,
    meaning:
      "Canister total memory, not per-DB or exact heap attribution; logical capacity does not cap this measurement.",
  };
  writeFileSync(
    resolve(root, "target/vault-physical-memory.json"),
    JSON.stringify(
      report,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
  );
  console.log(
    "PASS real 2 MiB ciphertext physical/logical memory sample; independent Wiki create/write/upgrade/delete leaves Vault header/ciphertext/vetKD root unchanged; other owner denied",
  );
  payload.fill(0);
  opened.fill(0);
} finally {
  await f.close();
}
