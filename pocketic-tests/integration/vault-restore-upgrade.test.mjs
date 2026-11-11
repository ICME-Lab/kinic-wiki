import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  restoreFixture,
  ok,
  b64,
  hash,
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
const baseline = "target/vault-dedicated-task12.wasm";
assert.equal(
  hash(readFileSync(join(root, baseline))).toString("hex"),
  "2514eedbcd717fd8befe9fa5987b403b7f230e59455a999851982cbf3dff5c01",
);
const f = await restoreFixture(baseline);
try {
  const source = await sourceArchive(f);
  const r = await prepare(f, source, { legacyCharges: true });
  await importAndActivate(f, r, {
    afterRecordStage: async (n) => {
      if (n !== 0) return;
      const before = ok(await f.actor.restore_admission_status())[0];
      const progress = ok(
        await f.actor.restore_target_progress(r.request.job, r.target),
      );
      await f.pic.upgradeCanister({
        sender: owner,
        canisterId: f.canisterId,
        wasm: f.wasm,
        arg: IDL.encode([], []),
      });
      assert.deepEqual(ok(await f.actor.restore_admission_status())[0], before);
      assert.deepEqual(
        ok(await f.actor.restore_target_progress(r.request.job, r.target)),
        progress,
      );
      assert.ok(
        "Err" in
          (await f.send(r.grant, { RestoreCommitRecord: { sequence: 1n } }))
            .result,
      );
      await f.pic.advanceTime(421_000);
      r.grant = await resume(f, r);
    },
  });
  console.log(
    "PASS frozen Task12→current upgrade retains staged encrypted record, old reservation/commitment, source+prepared-target identity, runtime/expiry grant fences and fresh current-proof resume through activation",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await f.close();
}
