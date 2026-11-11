import assert from "node:assert/strict";
import {
  restoreFixture,
  b,
  ok,
  owner,
  other,
  assertion,
} from "../helpers/vault-restore-fixture.mjs";
import {
  sourceArchive,
  prepare,
  importAndActivate,
  currentProof,
  offline,
} from "../helpers/vault-restore-pipeline.mjs";
for (const tiny of [false, true]) {
  const f = await restoreFixture(undefined, { credits: 100_000_000_000n });
  const cancelled = new Error("expected terminal cancellation");
  try {
    const source = await sourceArchive(f),
      r = await prepare(f, source);
    await assert.rejects(
      importAndActivate(f, r, {
        afterRecordStage: async (n) => {
          if (n !== 0) return;
          await f.pic.advanceTime(40 * 365 * 24 * 60 * 60 * 1000);
          await f.pic.tick(3);
          assert.equal(ok(await f.actor.account_balance()), 0n);
          assert.ok(
            "Importing" in
              ok(await f.actor.restore_admission_status())[0].pipeline[0].phase,
          );
          assert.equal(
            ok(await f.actor.restore_target_index(r.request.job, r.target, 0n))
              .entries.length,
            1,
          );
          if (tiny) {
            ok(
              await f.actor.set_funding_config([
                {
                  ledger: f.fake.canisterId,
                  recipient: f.canisterId,
                  cycles_per_kinic: 20_000_000n,
                },
              ]),
            );
            f.actor.setPrincipal(other);
            const p = {
              operation: b(201),
              beneficiary: owner,
              amount_e8s: 100_000_000n,
              min_credits: 20_000_000n,
              created_at_time: BigInt(await f.pic.getTime()) * 1_000_000n,
            };
            ok(await f.actor.quote_purchase(p));
            ok(await f.actor.pay_purchase(p.operation));
            f.actor.setPrincipal(owner);
            assert.equal(ok(await f.actor.account_balance()), 20_000_000n);
          }
          const ch = ok(await f.actor.resume_restore_admission(r.request.job));
          const j = ok(
            await f.actor.prove_restore_candidate(
              r.request.job,
              assertion(ch, r.candidate),
            ),
          );
          ok(await currentProof(f, j, r.currentSecret));
          await assert.rejects(
            f.fresh(
              { RestoreTarget: { job: r.request.job, generation: r.target } },
              [],
              r.candidate,
            ),
            /Insufficient|QuotaExceeded/,
          );
          const clean = await f.fresh(
            {
              RestoreCleanup: { job: r.request.job, target: r.request.target },
            },
            [],
            r.candidate,
          );
          for (let n = 0; n < 10; n++) {
            const status = ok(await f.actor.restore_admission_status())[0];
            if (status.cancel_complete) break;
            ok(
              (
                await f.send(clean, {
                  RestoreCancel: { cursor: status.pipeline[0].cleanup_cursor },
                })
              ).result,
            );
          }
          assert.ok(
            ok(await f.actor.restore_admission_status())[0].cancel_complete,
          );
          assert.ok("Err" in (await f.actor.get_vault_header(r.target.vault)));
          await offline(r.transformed.archive, r.transformed.recoverySecret);
          throw cancelled;
        },
      }),
      (e) => e === cancelled,
    );
    console.log(
      `PASS actual expired partial-record import remains pinned; ${tiny ? "20-million-cycle minimum top-up" : "zero"} balance denies target spending and permits fresh exact cleanup; independently saved target remains recoverable`,
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await f.close();
  }
}
