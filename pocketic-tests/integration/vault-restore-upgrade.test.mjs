import { verifyVaultBaseline } from "../helpers/vault-baseline.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  restoreFixture,
  ok,
  b64,
  b,
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
  revision,
} from "../helpers/vault-restore-pipeline.mjs";
const baseline = "target/vault-dedicated-task12.wasm";
verifyVaultBaseline(baseline);
const quotaProvenance = JSON.parse(
  readFileSync(join(root, "target/vault-restore-task12-quota.json"), "utf8"),
);
assert.equal(
  quotaProvenance.source_commit,
  "97dc47e2280ea207139b6704d0333985ebf73a82",
);
assert.equal(
  hash(
    readFileSync(join(root, "target/vault-restore-task12-quota.wasm")),
  ).toString("hex"),
  quotaProvenance.wasm_sha256,
);
const f = await restoreFixture(baseline);
try {
  const physicalBefore = ok(await f.actor.list_credentials()).length;
  const source = await sourceArchive(f);
  const r = await prepare(f, source, { legacyCharges: true });
  await importAndActivate(f, r, {
    afterRecordStage: async (n) => {
      if (n !== 0) return;
      await f.pic.upgradeCanister({
        sender: owner,
        canisterId: f.canisterId,
        wasm: join(root, "target/vault-restore-task12-quota.wasm"),
        arg: IDL.encode([], []),
      });
      assert.equal(ok(await f.actor.global_capacity()).used, 209715200n);
      // Two upgrade installs need a real replica cooldown; expired import stays pinned.
      await f.pic.advanceTime(3_600_000);
      await f.pic.tick(2);
      // Issue live authority on the old full-cap server immediately before upgrade,
      // so its next rejection proves the runtime fence independently of TTL expiry.
      r.grant = await resume(f, r);
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
      const capacity = ok(await f.actor.global_capacity());
      assert.equal(capacity.used, 209715200n + 524288n);
      assert.equal(capacity.overage, 524288n);
      assert.ok(capacity.overcommitted);
      assert.deepEqual(ok(await f.actor.restore_admission_status())[0], before);
      assert.deepEqual(
        ok(await f.actor.restore_target_progress(r.request.job, r.target)),
        progress,
      );
      assert.ok(
        r.grant.expires > BigInt(Math.floor((await f.pic.getTime()) / 1000)),
      );
      assert.deepEqual(
        (await f.send(r.grant, { RestoreCommitRecord: { sequence: 1n } }))
          .result,
        { Err: { Expired: null } },
      );
      await f.pic.advanceTime(421_000);
      r.grant = await resume(f, r);
    },
  });
  assert.equal(ok(await f.actor.list_credentials()).length, physicalBefore + 1);
  assert.ok(ok(await f.actor.global_capacity()).overcommitted);
  assert.ok(ok(await f.actor.account_balance()) > 0n);
  const normal = await f.fresh({ Normal: null }, [r.target], r.candidate);
  const record = revision(r.transformed.records.find((x) => !x.deleted));
  const beforeGrowth = ok(await f.actor.global_capacity()).used;
  assert.deepEqual(
    (
      await f.send(normal, {
        BeginRevision: {
          vault: r.target.vault,
          object: b(239),
          expected_revision: 0n,
          operation: b(240),
          plain_size: record.plain_size,
          manifest: record.manifest,
          chunk_hashes: record.chunk_hashes,
        },
      })
    ).result,
    { Err: { QuotaExceeded: null } },
  );
  assert.equal(ok(await f.actor.global_capacity()).used, beforeGrowth);
  const exported = ok(await f.actor.begin_export(r.target.vault, b(241)));
  assert.equal(exported.record_count, 2n);
  assert.equal(ok(await f.actor.export_index(b(241), 0n)).entries.length, 2);
  assert.equal(
    b64(
      ok(
        await f.actor.get_export_chunk(
          b(241),
          record.object,
          record.revision,
          0,
        ),
      ),
    ),
    b64(r.transformed.chunks[0][0]),
  );
  const clean = await f.fresh(
    { Cleanup: { job: b(242) } },
    [r.target],
    r.candidate,
  );
  ok(
    (
      await f.send(clean, {
        Cleanup: {
          job: b(242),
          cursor: 0n,
          action: { AbortExport: { export: b(241) } },
        },
      })
    ).result,
  );
  assert.deepEqual(
    ok(await f.actor.get_vault_header(r.target.vault)).generation,
    [r.target],
  );
  assert.ok(ok(await f.actor.global_capacity()).overcommitted);
  console.log(
    "PASS exact old-cap Task12→current migration overcommit consumes prepaid grant and NEW credential slots; retains staged encrypted record, old reservation/commitment, source+prepared-target identity, runtime/expiry grant fences and fresh current-proof resume through activation; unreserved growth denied, read/export/prepaid cleanup allowed",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await f.close();
}
