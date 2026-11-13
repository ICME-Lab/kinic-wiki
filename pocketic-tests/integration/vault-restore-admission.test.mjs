import { sign } from "node:crypto";
import {restoreFixture, owner, other, IDL, cryptoLib} from "../helpers/vault-restore-fixture.mjs";
import {b, key, ok, passkeys} from "../helpers/vault-passkeys.mjs";
import {verifyVaultBaseline} from "../helpers/vault-baseline.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import {idlFactory as vaultIDL} from "../../packages/vault-candid/index.js";
const reuseSmoke = process.env.VAULT_RESTORE_REUSE_SMOKE === "1";
const baseline = "target/vault-v6-baseline.wasm";
verifyVaultBaseline(baseline);
const {

} = cryptoLib;
const f = await restoreFixture("target/vault-v6-baseline.wasm", {
  monotonicCounter: true,
  upgradeBeforeBootstrap: false,
  sourceDocument: true,
});
const {
  pic, actor, canisterId, wasm, sourceG, sourceSecret, ephemeral, credential, lost, send, fresh, registration, assertion
} = f;
try {
  const credentials = await fresh({ Credentials: null });
  const ch = ok(
    (
      await send(credentials, {
        BeginRegistration: { vault: b(1), scope: { Global: null } },
      })
    ).result,
  ).Challenge;
  ok(
    (
      await send(credentials, {
        RegisterCredential: {
          vault: b(1),
          scope: { Global: null },
          registration: registration(ch, lost),
        },
      })
    ).result,
  );
  const scoped = { ...key(), id: b(44) };
  if (reuseSmoke) {
    const scope = {
      Instances: [{ vault: sourceG.vault, nonce: sourceG.nonce }],
    };
    const ch = ok(
      (await send(credentials, { BeginRegistration: { vault: b(1), scope } }))
        .result,
    ).Challenge;
    ok(
      (
        await send(credentials, {
          RegisterCredential: {
            vault: b(1),
            scope,
            registration: registration(ch, scoped),
          },
        })
      ).result,
    );
  }
  const context = ok(await actor.incident_context())[0];
  const selected = context.credentials.find((c) =>
    Buffer.from(c.credential).equals(Buffer.from(lost.id)),
  );
  const preparation = {
    job: b(70),
    namespace: context.namespace,
    compromised: [{ credential: lost.id, version: selected.version }],
    sources: [sourceG],
    targets: [{ namespace: context.namespace, vault: b(1), attempt: b(71) }],
  };
  const pre = await fresh({ IncidentPrepare: preparation });
  const start = await send(pre, { IncidentStart: null });
  ok(start.result);
  assert.deepEqual(
    await actor.mutate(start.payload, start.signature),
    start.result,
  );

  const parentBefore = ok(await actor.incident_status())[0];
  if (!reuseSmoke)
    await pic.upgradeCanister({
      sender: owner,
      canisterId,
      wasm,
      arg: IDL.encode([], []),
    });
  assert.deepEqual(ok(await actor.incident_status())[0], parentBefore);
  assert.ok(ok(await actor.account_balance()) > 0n);
  const candidate = { ...key(), id: b(43) };
  const request = {
    candidate_mode: [],
    job: b(92),
    target: { namespace: context.namespace, vault: b(1), attempt: b(93) },
    archive_digest: b(94, 32),
    source_commitment: b(95, 32),
    source_epoch: 0n,
    source_generation: [],
    archive_length: 1000n,
    records: 0n,
    reserved_bytes: 0n,
  };
  // The frozen server rejects unknown request fields; encode its exact historical input.
  let admissionActor = actor;
  if (reuseSmoke) {
    admissionActor = pic.createActor(({ IDL }) => {
      const method = vaultIDL({ IDL })._fields.find(
        ([name]) => name === "begin_restore_admission",
      )[1];
      const legacyRequest = IDL.Record(
        Object.fromEntries(
          method.argTypes[0]._fields.filter(
            ([name]) => name !== "candidate_mode",
          ),
        ),
      );
      return IDL.Service({
        begin_restore_admission: IDL.Func([legacyRequest], method.retTypes, []),
      });
    }, canisterId);
    admissionActor.setPrincipal(owner);
  }
  const registrationChallenge = ok(
    await admissionActor.begin_restore_admission(request),
  );
  const possessionChallenge = ok(
    await actor.register_restore_candidate(
      request.job,
      registration(registrationChallenge, candidate),
    ),
  );
  assert.ok(
    "Err" in
      (await actor.prove_restore_candidate(
        request.job,
        assertion(possessionChallenge, lost),
      )),
  );
  const proofStatus = ok(
    await actor.prove_restore_candidate(
      request.job,
      assertion(possessionChallenge, candidate),
    ),
  );
  assert.ok("CurrentProof" in proofStatus.phase);
  assert.deepEqual(ok(await actor.incident_status())[0], parentBefore);
  assert.ok(
    "Err" in
      (await actor.prove_restore_current(
        request.job,
        sign(null, proofStatus.recovery_message, candidate.privateKey),
      )),
  );
  const recoveryKey = await cryptoLib.recoverySigningKey(sourceSecret);
  const proof = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      recoveryKey,
      new Uint8Array(proofStatus.recovery_message),
    ),
  );
  const admitted = ok(await actor.prove_restore_current(request.job, proof));
  assert.ok("Admitted" in admitted.phase);
  assert.deepEqual(admitted.current_live[0], sourceG);
  assert.equal(admitted.next_epoch, 1n);
  assert.ok(
    "Err" in
      (await actor.begin_grant({
        operation: b(96),
        public_key: ephemeral.public,
        credential: candidate.id,
        purpose: { Create: null },
        generations: [],
      })),
  );
  assert.ok("Err" in (await actor.set_config([])));
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.deepEqual(ok(await actor.restore_admission_status())[0], admitted);
  assert.ok("Err" in (await actor.prove_restore_current(request.job, proof)));
  const resume = ok(await actor.resume_restore_admission(request.job));
  const resumed = ok(
    await actor.prove_restore_candidate(
      request.job,
      assertion(resume, candidate),
    ),
  );
  const freshProof = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      recoveryKey,
      new Uint8Array(resumed.recovery_message),
    ),
  );
  ok(await actor.prove_restore_current(request.job, freshProof));
  assert.deepEqual(ok(await actor.incident_status())[0], parentBefore);
  if (reuseSmoke) {
    // The new-candidate child was written by the frozen fix1 Wasm, then resumed above.
    const cancel = await fresh(
      { RestoreCleanup: { job: request.job, target: request.target } },
      [],
      candidate,
    );
    ok((await send(cancel, { RestoreCancel: { cursor: 0n } })).result);
    assert.ok(ok(await actor.restore_admission_status())[0].cancel_complete);
    const reuse = {
      ...request,
      job: b(103),
      target: { ...request.target, attempt: b(104) },
      candidate_mode: [{ ExistingInstances: scoped.id }],
    };
    const ch = ok(await actor.begin_restore_admission(reuse));
    assert.equal(ch.registration, false);
    assert.deepEqual(ch.credential_ids, [scoped.id]);
    assert.ok(
      "Err" in
        (await actor.register_restore_candidate(
          reuse.job,
          registration(ch, scoped),
        )),
    );
    const possession = ok(
      await actor.prove_restore_candidate(reuse.job, assertion(ch, scoped)),
    );
    assert.ok("CurrentProof" in possession.phase);
    const signCurrent = async (j) =>
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          recoveryKey,
          new Uint8Array(j.recovery_message),
        ),
      );
    const currentProof = await signCurrent(possession);
    const admittedReuse = ok(
      await actor.prove_restore_current(reuse.job, currentProof),
    );
    assert.equal(admittedReuse.existing_candidate.length, 1);
    const old = await fresh(
      { RestorePrepare: { job: reuse.job, target: reuse.target } },
      [],
      scoped,
    );
    const counterBefore = scoped.counter;
    const authoritiesBefore = ok(await actor.incident_context())[0].credentials;
    await pic.upgradeCanister({
      sender: owner,
      canisterId,
      wasm,
      arg: IDL.encode([], []),
    });
    const persisted = ok(await actor.restore_admission_status())[0];
    assert.deepEqual(
      persisted.existing_candidate,
      admittedReuse.existing_candidate,
    );
    assert.deepEqual(persisted.request, reuse);
    assert.ok(
      "Err" in (await actor.prove_restore_current(reuse.job, currentProof)),
    );
    assert.ok("Err" in (await send(old, { RestoreAllocate: null })).result);
    const resumedChallenge = ok(
      await actor.resume_restore_admission(reuse.job),
    );
    assert.ok(
      "Err" in
        (await actor.prove_restore_candidate(
          reuse.job,
          assertion(resumedChallenge, scoped, counterBefore),
        )),
    );
    const resumedReuse = ok(
      await actor.prove_restore_candidate(
        reuse.job,
        assertion(resumedChallenge, scoped),
      ),
    );
    ok(
      await actor.prove_restore_current(
        reuse.job,
        await signCurrent(resumedReuse),
      ),
    );
    const clean = await fresh(
      { RestoreCleanup: { job: reuse.job, target: reuse.target } },
      [],
      scoped,
    );
    ok((await send(clean, { RestoreCancel: { cursor: 0n } })).result);
    assert.ok(ok(await actor.restore_admission_status())[0].cancel_complete);
    assert.deepEqual(
      ok(await actor.incident_context())[0].credentials,
      authoritiesBefore,
    );
    assert.deepEqual(ok(await actor.incident_status())[0], parentBefore);
    console.log(
      "PASS current v6 upgrade: new-candidate child resumes, existing Instances UV without registration, physical shared counter survives upgrade and rejects replay, current proof and old grants fenced, fresh resume and exact cancel preserve scoped authority and frozen parent",
    );
  }
  actor.setPrincipal(other);
  assert.deepEqual(ok(await actor.restore_admission_status()), []);
  actor.setPrincipal(owner);
  if (!reuseSmoke)
    console.log(
      "PASS current v6 frozen incident upgrade, retained parent, candidate UV possession, current-verifier proof, no candidate Global grant, config guard, persisted child and fresh-proof resume after upgrade",
    );
} finally {
  await f.close();
}
