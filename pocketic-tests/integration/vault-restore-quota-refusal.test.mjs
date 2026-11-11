import assert from "node:assert/strict";
import { join } from "node:path";
import {
  restoreFixture,
  ok,
  b,
  owner,
  IDL,
  root,
} from "../helpers/vault-restore-fixture.mjs";
import { prepare, resume } from "../helpers/vault-restore-pipeline.mjs";
import { externalArchive } from "../helpers/vault-restore-archive.mjs";
const f = await restoreFixture();
try {
  const source = await externalArchive(
    1,
    b(1),
    "legacy archive with larger encrypted metadata than the current retained data",
  );
  const r = await prepare(f, source, { currentSecret: f.sourceSecret });
  const before = ok(await f.actor.get_vault_header(b(1)));
  await f.pic.upgradeCanister({
    sender: owner,
    canisterId: f.canisterId,
    wasm: join(root, "target/vault-restore-quota-baseline.wasm"),
    arg: IDL.encode([], []),
  });
  await f.pic.advanceTime(421_000);
  r.grant = await resume(f, r);
  assert.equal(ok(await f.actor.global_capacity()).used, 209715200n);
  const result = (await f.send(r.grant, { RestorePreflight: r.preflight }))
    .result;
  assert.deepEqual(result, { Err: { QuotaExceeded: null } });
  assert.deepEqual(ok(await f.actor.get_vault_header(b(1))), before);
  assert.equal(
    ok(await f.actor.restore_admission_status())[0].pipeline[0].discard_started,
    false,
  );
  console.log(
    "PASS actual fully validated v1 archive with genuinely larger transformed data rejects at full quota before discard; current source remains intact",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await f.close();
}
