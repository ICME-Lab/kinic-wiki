import assert from "node:assert/strict";
import {
  restoreFixture,
  b,
  b64,
  ok,
  other,
  owner,
  IDL,
  root,
} from "../helpers/vault-restore-fixture.mjs";
import {
  sourceArchive,
  prepare,
  importAndActivate,
  resume,
} from "../helpers/vault-restore-pipeline.mjs";
import { join } from "node:path";
const f = await restoreFixture();
try {
  const source = await sourceArchive(f);
  const r = await prepare(f, source);
  if (process.env.VAULT_RESTORE_FULL_QUOTA === "1") {
    await f.pic.upgradeCanister({
      sender: owner,
      canisterId: f.canisterId,
      wasm: join(root, "target/vault-restore-quota-baseline.wasm"),
      arg: IDL.encode([], []),
    });
    assert.equal(
      ok(await f.actor.global_capacity()).used,
      200n * 1024n * 1024n,
    );
    await f.pic.advanceTime(421_000);
    r.grant = await resume(f, r);
    console.log(
      "Exact 200 MiB global quota seeded on unrelated owner; original target charges unchanged",
    );
  }
  const restored = await importAndActivate(f, r);
  f.actor.setPrincipal(other);
  assert.ok("Err" in (await f.actor.get_vault_header(r.target.vault)));
  assert.ok("Err" in (await f.actor.get_manifest(r.target.vault, b(20), 1n)));
  f.actor.setPrincipal(owner);
  const first = r.target;
  const second = await prepare(f, restored, {
    id: 110,
    candidate: r.candidate,
    existing: true,
  });
  await importAndActivate(f, second);
  assert.notEqual(b64(first.nonce), b64(second.target.nonce));
  console.log(
    "PASS actual Wasm two current-v2 imports/activations, retained encrypted history + tombstone + chunk, real vetKD, passkey/current proof, independent offline source/new targets, fresh nonce twice, scoped-key reuse and other-owner ciphertext denial",
  );
} finally {
  await f.close();
}
