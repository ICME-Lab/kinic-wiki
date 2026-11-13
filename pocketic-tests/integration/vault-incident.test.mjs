import {restoreFixture, owner, other, IDL, cryptoLib, root} from "../helpers/vault-restore-fixture.mjs";
import {b, key, ok, passkeys} from "../helpers/vault-passkeys.mjs";
import {verifyVaultBaseline} from "../helpers/vault-baseline.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import {resolve} from "node:path";
verifyVaultBaseline("target/vault-v6-baseline.wasm");
const {
  TransportSecretKey, randomBytes, deriveKey, sealV2, openV2, generationAAD, recoveryVerifier
} = cryptoLib;
const f = await restoreFixture("target/vault-v6-baseline.wasm", {
  monotonicCounter: false,
  upgradeBeforeBootstrap: true,
  sourceDocument: false,
});
const {
  pic, actor, canisterId, wasm, sourceG, sourceRaw, normal, recovery, credential, lost, bootstrap, send, fresh, derive, cryptoG, registration, assertion, paid, afterUpgrade
} = f;
try {
  assert.equal(afterUpgrade, paid);
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
  assert.ok("IncidentRequired" in ok(await actor.get_vault_header(b(1))).state);
  assert.ok(
    "Err" in
      (
        await send(bootstrap, {
          Derive: {
            vault: b(1),
            epoch: 0n,
            attempt: [],
            assertion: [],
            transport: TransportSecretKey.random().publicKeyBytes(),
          },
        })
      ).result,
  );
  actor.setPrincipal(other);
  assert.deepEqual(ok(await actor.incident_status()), []);
  assert.ok("Err" in (await actor.mutate(start.payload, start.signature)));
  actor.setPrincipal(owner);
  assert.ok("Err" in (await actor.set_config([])));
  ok(
    (await send(pre, { IncidentAllocate: { vault: b(1), attempt: b(71) } }))
      .result,
  );
  let j = ok(await actor.incident_status())[0];
  const targetG = j.targets[0].target[0];
  assert.notDeepEqual(sourceG.nonce, targetG.nonce);
  assert.equal(targetG.epoch, sourceG.epoch + 1n);
  if (process.env.VAULT_INCIDENT_FULL_QUOTA) {
    await pic.upgradeCanister({
      sender: owner,
      canisterId,
      wasm: resolve(root, "target/vault-restore-quota-baseline.wasm"),
      arg: IDL.encode([], []),
    });
    await pic.upgradeCanister({
      sender: owner,
      canisterId,
      wasm,
      arg: IDL.encode([], []),
    });
    assert.equal(ok(await actor.global_capacity()).used, 200n * 1024n * 1024n);
  }
  const post = await fresh({
    Incident: { job: j.job, vector_digest: j.vector_digest },
  });
  assert.ok(
    "Err" in
      (
        await send(post, {
          IncidentDerive: {
            job: j.job,
            attempt: b(71),
            role: { Source: null },
            generation: targetG,
            transport: TransportSecretKey.random().publicKeyBytes(),
          },
        })
      ).result,
  );
  const sourceAgain = await derive(post, sourceG, j.job, b(71), {
    Source: null,
  });
  assert.deepEqual(
    await openV2(
      sourceAgain,
      normal,
      generationAAD(cryptoG(sourceG), b(0), 0n, "normal"),
    ),
    sourceRaw,
  );
  const targetKEK = await derive(post, targetG, j.job, b(71), { Target: null });
  if (process.env.VAULT_INCIDENT_FULL_QUOTA) {
    assert.equal(ok(await actor.global_capacity()).used, 200n * 1024n * 1024n);
    console.log(
      "PASS actual source and target vetKD at exact full 200 MiB global quota with prepaid key rows",
    );
  }
  const targetRaw = randomBytes(32),
    targetSecret = randomBytes(32);
  const targetNormal = await sealV2(
    targetKEK,
    targetRaw,
    generationAAD(cryptoG(targetG), b(0), 0n, "normal"),
  );
  const targetRecovery = await sealV2(
    await deriveKey(targetSecret, "recovery"),
    targetRaw,
    generationAAD(cryptoG(targetG), b(0), 0n, "recovery"),
  );
  ok(
    (
      await send(post, {
        IncidentStage: {
          vault: b(1),
          attempt: b(71),
          normal: targetNormal,
          recovery: targetRecovery,
          recovery_verifier: await recoveryVerifier(targetSecret),
        },
      })
    ).result,
  );
  j = ok(await actor.incident_status())[0];
  const openedNormal = await openV2(
    targetKEK,
    j.targets[0].normal[0],
    generationAAD(cryptoG(targetG), b(0), 0n, "normal"),
  );
  const openedRecovery = await openV2(
    await deriveKey(targetSecret, "recovery"),
    j.targets[0].recovery[0],
    generationAAD(cryptoG(targetG), b(0), 0n, "recovery"),
  );
  assert.deepEqual(openedNormal, targetRaw);
  assert.deepEqual(openedRecovery, targetRaw);
  await assert.rejects(
    openV2(
      sourceAgain,
      targetNormal,
      generationAAD(cryptoG(targetG), b(0), 0n, "normal"),
    ),
  );
  ok(
    (
      await send(post, {
        IncidentConfirmKit: {
          vault: b(1),
          attempt: b(71),
          envelope_digest: j.targets[0].envelope_digest,
        },
      })
    ).result,
  );
  const confirmed = ok(await actor.incident_status())[0];
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.deepEqual(ok(await actor.incident_status())[0], confirmed);
  assert.ok("Err" in (await send(post, { IncidentCancel: null })).result);
  const resumed = await fresh({
    Incident: { job: j.job, vector_digest: j.vector_digest },
  });
  const restoredTarget = await derive(resumed, targetG, j.job, b(71), {
    Target: null,
  });
  assert.deepEqual(
    await openV2(
      restoredTarget,
      targetNormal,
      generationAAD(cryptoG(targetG), b(0), 0n, "normal"),
    ),
    targetRaw,
  );
  ok(
    (
      await send(resumed, {
        IncidentReset: { vault: b(1), attempt: b(71), next_attempt: b(72) },
      })
    ).result,
  );
  const reset = ok(await actor.incident_status())[0];
  assert.equal(reset.targets[0].target.length, 0);
  assert.equal(reset.targets[0].kit_ack.length, 0);
  assert.notDeepEqual(reset.vector_digest, j.vector_digest);
  assert.ok("IncidentRequired" in ok(await actor.get_vault_header(b(1))).state);
  assert.ok(
    "Err" in
      (
        await send(resumed, {
          IncidentConfirmKit: {
            vault: b(1),
            attempt: b(71),
            envelope_digest: j.targets[0].envelope_digest,
          },
        })
      ).result,
  );
  preparation.targets[0].attempt = b(72);
  await pic.advanceTime(500_000);
  await pic.tick(2);
  const retryPre = await fresh({ IncidentPrepare: preparation });
  ok(
    (
      await send(retryPre, {
        IncidentAllocate: { vault: b(1), attempt: b(72) },
      })
    ).result,
  );
  const replaced = ok(await actor.incident_status())[0];
  assert.notDeepEqual(replaced.targets[0].target[0].nonce, targetG.nonce);
  assert.ok(replaced.targets[0].target[0].epoch > targetG.epoch);
  const cancellation = await fresh({ Cleanup: { job: b(93) } });
  const cancelledRequest = await send(cancellation, {
    Cleanup: {
      job: b(93),
      cursor: 0n,
      action: {
        CancelIncident: {
          incident: replaced.job,
          vector_digest: replaced.vector_digest,
        },
      },
    },
  });
  assert.equal(ok(cancelledRequest.result).Cleanup.complete, true);
  const cancelled = ok(await actor.incident_status())[0];
  assert.ok("Cancelled" in cancelled.targets[0].phase);
  assert.equal(cancelled.targets[0].target.length, 0);
  assert.equal(cancelled.targets[0].kit_ack.length, 0);
  assert.notDeepEqual(cancelled.targets[0].attempt, b(72));
  assert.ok("IncidentRequired" in ok(await actor.get_vault_header(b(1))).state);
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.deepEqual(ok(await actor.incident_status())[0], cancelled);
  assert.ok(
    "Err" in
      (
        await send(retryPre, {
          IncidentAllocate: { vault: b(1), attempt: b(72) },
        })
      ).result,
  );
  preparation.targets[0].attempt = cancelled.targets[0].attempt;
  await pic.advanceTime(500_000);
  await pic.tick(2);
  const restart = await fresh({ IncidentPrepare: preparation });
  ok(
    (
      await send(restart, {
        IncidentReset: {
          vault: b(1),
          attempt: cancelled.targets[0].attempt,
          next_attempt: b(94),
        },
      })
    ).result,
  );
  preparation.targets[0].attempt = b(94);
  await pic.advanceTime(500_000);
  await pic.tick(2);
  const restarted = await fresh({ IncidentPrepare: preparation });
  ok(
    (
      await send(restarted, {
        IncidentAllocate: { vault: b(1), attempt: b(94) },
      })
    ).result,
  );
  const afterCancel = ok(await actor.incident_status())[0];
  assert.ok(
    afterCancel.targets[0].target[0].epoch >
      replaced.targets[0].target[0].epoch,
  );
  assert.notDeepEqual(
    afterCancel.targets[0].target[0].nonce,
    replaced.targets[0].target[0].nonce,
  );
  console.log(
    "PASS dedicated v6 upgrade, exact JS signatures, fresh UV, incident freeze, real vetKD Source/Target, encrypted preparation, kit ack, durable upgrade/resume, explicit reset, authenticated cancellation and fresh restart",
  );
} finally {
  await f.close();
}
