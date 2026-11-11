import assert from "node:assert/strict";
import {
  restoreFixture,
  ok,
  owner,
  IDL,
  assertion,
  cryptoLib,
} from "../helpers/vault-restore-fixture.mjs";
import {
  sourceArchive,
  prepare,
  currentProof,
} from "../helpers/vault-restore-pipeline.mjs";
async function renew(f, r) {
  const ch = ok(await f.actor.resume_restore_admission(r.request.job));
  const j = ok(
    await f.actor.prove_restore_candidate(
      r.request.job,
      assertion(ch, r.candidate),
    ),
  );
  if (j.current_live.length) ok(await currentProof(f, j, r.currentSecret));
}
{
  const f = await restoreFixture(undefined, { credits: 100_000_000_000n });
  try {
    const source = await sourceArchive(f);
    const r = await prepare(f, source, { afterAdmission: (r) => r });
    const grant = await f.fresh(
      { RestorePrepare: { job: r.request.job, target: r.request.target } },
      [],
      r.candidate,
    );
    const flight = await f.send(
      grant,
      { RestoreAllocate: null },
      { deferred: true },
    );
    await f.pic.tick(1);
    const inFlight = ok(await f.actor.restore_admission_status())[0];
    assert.equal(inFlight.pipeline.length, 0);
    assert.equal(inFlight.allocation_token.length, 1);
    await f.pic.advanceTime(121_000);
    await f.pic.tick(3);
    const handle = ok((await flight.complete()).result).Handle;
    assert.ok("Err" in (await f.send(grant, { KeyResult: { handle } })).result);
    assert.equal(
      ok(await f.actor.restore_admission_status())[0].pipeline.length,
      0,
    );
    // Bill retained storage forward until the synthetic account reaches zero.
    await f.pic.advanceTime(40 * 365 * 24 * 60 * 60 * 1000);
    await f.pic.tick(3);
    assert.equal(ok(await f.actor.account_balance()), 0n);
    await renew(f, r);
    const clean = await f.fresh(
      { RestoreCleanup: { job: r.request.job, target: r.request.target } },
      [],
      r.candidate,
    );
    ok((await f.send(clean, { RestoreCancel: { cursor: 0n } })).result);
    assert.ok(ok(await f.actor.restore_admission_status())[0].cancel_complete);
    assert.ok(
      "Active" in ok(await f.actor.get_vault_header(f.sourceG.vault)).state,
    );
    console.log(
      "PASS actual expired raw_rand publication fence, exact retained allocation identity, zero-balance fresh proof and terminal cancellation preserve original source",
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await f.close();
  }
}
for (const rounds of [1, 3]) {
  const f = await restoreFixture();
  try {
    const source = await sourceArchive(f),
      r = await prepare(f, source);
    const transport = cryptoLib.TransportSecretKey.random();
    const balance = ok(await f.actor.account_balance());
    const pending = await f.send(
      r.grant,
      {
        RestoreDerive: {
          job: r.request.job,
          attempt: r.request.target.attempt,
          role: { Target: null },
          generation: r.target,
          transport: transport.publicKeyBytes(),
        },
      },
      { deferred: true },
    );
    await f.pic.tick(rounds);
    await f.pic.advanceTime(121_000);
    await f.pic.tick(5);
    const handle = ok((await pending.complete()).result).Handle;
    assert.ok(
      "Err" in (await f.send(r.grant, { KeyResult: { handle } })).result,
    );
    const spent = balance - ok(await f.actor.account_balance());
    if (rounds === 1)
      assert.ok(
        spent < 1_000_000_000n,
        `public-key fence submitted a paid derive: ${spent}`,
      );
    else
      assert.ok(
        spent > 1_000_000_000n,
        `encrypted-key await was not reached: ${spent}`,
      );
    await f.pic.upgradeCanister({
      sender: owner,
      canisterId: f.canisterId,
      wasm: f.wasm,
      arg: IDL.encode([], []),
    });
    await f.pic.advanceTime(421_000);
    await renew(f, r);
    const clean = await f.fresh(
      { RestoreCleanup: { job: r.request.job, target: r.request.target } },
      [],
      r.candidate,
    );
    ok((await f.send(clean, { RestoreCancel: { cursor: 0n } })).result);
    assert.ok(ok(await f.actor.restore_admission_status())[0].cancel_complete);
    assert.ok(
      "Active" in ok(await f.actor.get_vault_header(f.sourceG.vault)).state,
    );
    console.log(
      `PASS actual ${rounds === 1 ? "public-key" : "encrypted-key"} await expiry fence, settlement ${spent} synthetic cycles, upgrade and fresh-proof exact cancel`,
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await f.close();
  }
}
