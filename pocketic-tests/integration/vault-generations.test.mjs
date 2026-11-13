import { b, cat, hash, b64, key, ok, passkeys } from "../helpers/vault-passkeys.mjs";
import { verifyVaultBaseline } from "../helpers/vault-baseline.mjs";
import { fundedFixture, IDL, owner, other, root } from "../helpers/vault-restore-fixture.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { sign } from "node:crypto";
import { idlFactory as vaultIDL } from "../../packages/vault-candid/index.js";
import { idlFactory as mutationFactory } from "../../packages/vault-candid/mutation.js";
const { registration, assertion } = passkeys(owner, { monotonicCounter: false });
const mutationType = mutationFactory({ IDL })._fields.find(
  ([n]) => n === "encode",
)[1].argTypes[0];

verifyVaultBaseline("target/vault-v6-baseline.wasm");
const f = await fundedFixture("target/vault-v6-baseline.wasm", { credits: 2_000_000_000n });
const { pic, actor, canisterId, fake, wasm, paid, purchase } = f;
try {
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.equal(ok(await actor.account_balance()), paid);
  {
    // These compatibility entrypoints are intentionally unusable. The signed mutation
    // protocol is the sole write authority; rejection must not charge or create state.
    const emptyHeader = {
      id: b(1), epoch: 0n, key_name: "key_1", state: { Pending: null }, sequence: 0n,
      normal: [], recovery: [], recovery_verifier: [], generation: [],
      published_slot: [], backup_sequence: [], backup_at: [],
    };
    const envelope = { version: 1, nonce: b(1, 12), ciphertext: b(2, 48) };
    const activation = {
      vault: b(1), operation: b(2), attempt: [], normal: envelope, recovery: envelope,
      registration: [], assertion: [],
    };
    const emptyRevision = {
      vault: b(1), object: b(2), revision: 1n, sequence: 1n, deleted: false,
      manifest: b(0), chunk_hashes: [], plain_size: 0n,
    };
    for (const [method, args] of [
      ["activate_vault", [activation]],
      ["manage_unlock_credential", [{ vault: b(1), remove: [], registration: [], assertion: "" }]],
      ["prepare_unlock_credential", [b(1), ""]],
      ["begin_revision", [{ vault: b(1), object: b(2), expected_revision: 0n, operation: b(3), plain_size: 0n, manifest: b(0), chunk_hashes: [] }]],
      ["put_chunk", [b(1), 0, b(0)]],
      ["commit_revision", [b(1)]],
      ["delete_object", [b(1), b(2), 0n, b(3)]],
      ["purge_object", [b(1), b(2)]],
      ["collect_garbage", []],
      ["begin_restore", [{ header: emptyHeader, operation: b(2), count: 0n, root: b(0, 32), reserved_bytes: 0n }]],
      ["begin_restore_revision", [b(1), emptyRevision, []]],
      ["put_restore_chunk", [b(1), 0, b(0), []]],
      ["commit_restore_revision", [b(1), 0n, []]],
      ["commit_restore", [activation]],
    ]) {
      assert.deepEqual(await actor[method](...args), { Err: { Unauthorized: null } }, method);
    }
    assert.equal(ok(await actor.account_balance()), paid);
    assert.deepEqual(ok(await actor.list_vaults()), []);
    console.log("PASS all14 legacy write entrypoints deny without charging or creating state; Candid unchanged");
  }
  const ephemeral = key(),
    credential = { ...key(), id: b(41) };
  const first = ok(
    await actor.bootstrap({
      reserve: { vault: b(1), operation: b(2) },
      public_key: ephemeral.public,
    }),
  );
  const retry = ok(
    await actor.bootstrap({
      reserve: { vault: b(1), operation: b(2) },
      public_key: ephemeral.public,
    }),
  );
  assert.deepEqual(first.header.generation, retry.header.generation);
  ok(await actor.cancel_vault_setup(b(1), b(2)));
  const setup = ok(
    await actor.bootstrap({
      reserve: { vault: b(1), operation: b(3) },
      public_key: ephemeral.public,
    }),
  );
  assert.notDeepEqual(
    first.header.generation[0].nonce,
    setup.header.generation[0].nonce,
  );
  assert.ok(
    "Err" in
      (await actor.derive_vault_key({
        vault: b(1),
        attempt: [b(3)],
        epoch: 0n,
        transport: b(0, 48),
        assertion: [],
      })),
  );
  const grant = ok(
    await actor.register_bootstrap(
      b(3),
      registration(setup.challenge, credential),
    ),
  );
  const send = async (grant, counter, operation, principal = owner) => {
    const payload = new Uint8Array(
      IDL.encode(
        [mutationType],
        [
          {
            version: 2,
            owner: principal,
            canister: canisterId,
            grant: grant.id,
            counter,
            operation,
          },
        ],
      ),
    );
    const signature = sign(
      null,
      cat(Buffer.from("kinic-vault/mutation/v2\0"), payload),
      ephemeral.privateKey,
    );
    return {
      result: await actor.mutate(payload, signature),
      payload,
      signature,
    };
  };
  const envelope = (n) => ({
    version: 2,
    nonce: b(n, 12),
    ciphertext: b(n, 48),
  });
  const activation = await send(grant, 0n, {
    Activate: {
      request: {
        vault: b(1),
        attempt: [b(3)],
        operation: b(4),
        normal: envelope(5),
        recovery: envelope(6),
        registration: [],
        assertion: [],
      },
      recovery_verifier: credential.public,
    },
  });
  ok(activation.result);
  assert.deepEqual(
    await actor.mutate(activation.payload, activation.signature),
    activation.result,
  );
  actor.setPrincipal(other);
  assert.ok(
    "Err" in (await actor.mutate(activation.payload, activation.signature)),
  );
  actor.setPrincipal(owner);
  assert.ok(
    "Err" in (await actor.reserve_vault({ vault: b(7), operation: b(8) })),
  );
  const header = ok(await actor.get_vault_header(b(1)));
  const generations = header.generation;
  const newGrant = async (n, purpose = { Normal: null }) => {
    const r = {
      operation: b(n),
      public_key: ephemeral.public,
      credential: credential.id,
      purpose,
      generations,
    };
    const ch = ok(await actor.begin_grant(r));
    return ok(await actor.finish_grant(r.operation, assertion(ch, credential)));
  };
  // Stop a second creation between durable admission and the random reply.
  const createGrant = await newGrant(30, { Create: null });
  const pendingPayload = new Uint8Array(
    IDL.encode(
      [mutationType],
      [
        {
          version: 2,
          owner,
          canister: canisterId,
          grant: createGrant.id,
          counter: 0n,
          operation: { Create: { vault: b(31), operation: b(32) } },
        },
      ],
    ),
  );
  const pendingSignature = sign(
    null,
    cat(Buffer.from("kinic-vault/mutation/v2\0"), pendingPayload),
    ephemeral.privateKey,
  );
  const deferred = pic.createDeferredActor(vaultIDL, canisterId);
  deferred.setPrincipal(owner);
  const completeCreation = await deferred.mutate(
    pendingPayload,
    pendingSignature,
  );
  await pic.tick(1);
  await pic.advanceTime(121_000);
  await pic.tick(2);
  const failedCreation = ok(await completeCreation());
  const unfinished = ok(await actor.list_unfinished_vaults()).find((x) =>
    Buffer.from(x.vault).equals(b(31)),
  );
  assert.ok(unfinished);
  assert.ok(
    "Err" in
      (
        await send(createGrant, 1n, {
          KeyResult: { handle: failedCreation.Handle },
        })
      ).result,
    "expired creation must not release a generation",
  );
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.ok("Err" in (await actor.cancel_vault_setup(b(31), b(32))));
  const cancelReq = {
    operation: b(33),
    public_key: ephemeral.public,
    credential: credential.id,
    purpose: {
      CancelCreation: {
        job: b(34),
        target: {
          namespace: unfinished.namespace[0],
          vault: b(31),
          attempt: b(32),
        },
      },
    },
    generations: [],
  };
  // Reach zero synthetic credit before the narrow cancellation ceremony.
  for (let n = 0; n < 120 && ok(await actor.account_balance()) > 0n; n++)
    ok(await actor.list_vaults());
  assert.equal(ok(await actor.account_balance()), 0n);
  const cancelChallenge = ok(await actor.begin_cleanup(cancelReq));
  const cancelGrant = ok(
    await actor.finish_cleanup(b(33), assertion(cancelChallenge, credential)),
  );
  const cancelled = await send(cancelGrant, 0n, {
    Cleanup: {
      job: b(34),
      cursor: 0n,
      action: { CancelSetup: { attempt: b(32) } },
    },
  });
  assert.equal(ok(cancelled.result).Cleanup.complete, true);
  assert.deepEqual(
    await actor.mutate(cancelled.payload, cancelled.signature),
    cancelled.result,
  );
  assert.ok("Err" in (await actor.get_vault_header(b(31))));
  assert.equal(ok(await actor.list_vaults()).length, 1);
  // Replenish only fixture credit to verify ordinary grant admission remains bounded.
  const refill = {
    ...purchase,
    operation: b(81),
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
  };
  ok(await actor.quote_purchase(refill));
  ok(await actor.pay_purchase(refill.operation));
  await pic.advanceTime(301_000);
  await pic.tick(2);
  const generatedGrant = await newGrant(35, { Create: null });
  const generatedWork = ok(
    (
      await send(generatedGrant, 0n, {
        Create: { vault: b(36), operation: b(37) },
      })
    ).result,
  );
  const generatedResult = await send(generatedGrant, 1n, {
    KeyResult: { handle: generatedWork.Handle },
  });
  assert.equal(ok(generatedResult.result).Header.generation.length, 1);
  const generatedPending = ok(await actor.list_unfinished_vaults()).find((x) =>
    Buffer.from(x.vault).equals(b(36)),
  );
  for (let n = 0; n < 120 && ok(await actor.account_balance()) > 0n; n++)
    ok(await actor.list_vaults());
  assert.equal(ok(await actor.account_balance()), 0n);
  const generatedCancelReq = {
    operation: b(38),
    public_key: ephemeral.public,
    credential: credential.id,
    purpose: {
      CancelCreation: {
        job: b(39),
        target: {
          namespace: generatedPending.namespace[0],
          vault: b(36),
          attempt: b(37),
        },
      },
    },
    generations: [],
  };
  const generatedChallenge = ok(await actor.begin_cleanup(generatedCancelReq));
  const generatedCancel = ok(
    await actor.finish_cleanup(
      b(38),
      assertion(generatedChallenge, credential),
    ),
  );
  const generatedCancelled = await send(generatedCancel, 0n, {
    Cleanup: {
      job: b(39),
      cursor: 0n,
      action: { CancelSetup: { attempt: b(37) } },
    },
  });
  assert.equal(ok(generatedCancelled.result).Cleanup.complete, true);
  const secondRefill = {
    ...purchase,
    operation: b(82),
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
  };
  ok(await actor.quote_purchase(secondRefill));
  ok(await actor.pay_purchase(secondRefill.operation));
  const uploadGrant = await newGrant(10);
  const interrupted = {
    vault: b(1),
    object: b(118),
    operation: b(119),
    expected_revision: 0n,
    plain_size: 1n,
    manifest: new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        dek: { version: 2, nonce: b64(b(4, 12)), ciphertext: b64(b(5, 48)) },
        metadata: {
          version: 1,
          nonce: b64(b(6, 12)),
          ciphertext: b64(b(7, 16)),
        },
        nonces: [b64(b(8, 12))],
      }),
    ),
    chunk_hashes: [hash(b(7, 17))],
  };
  ok((await send(uploadGrant, 0n, { BeginRevision: interrupted })).result);
  ok(
    (
      await send(uploadGrant, 1n, {
        PutChunk: {
          vault: b(1),
          upload: interrupted.operation,
          index: 0,
          data: b(7, 17),
        },
      })
    ).result,
  );
  assert.equal(
    ok(await actor.list_pending_uploads(new Uint8Array())).entries.length,
    1,
  );
  actor.setPrincipal(other);
  const foreignUpload = await actor.get_upload_status(interrupted.operation);
  assert.ok("Err" in foreignUpload || "Absent" in foreignUpload.Ok);
  actor.setPrincipal(owner);
  await newGrant(11);
  assert.ok(
    "Err" in
      (await actor.begin_grant({
        operation: b(12),
        public_key: ephemeral.public,
        credential: credential.id,
        purpose: { Normal: null },
        generations,
      })),
  );
  // Spend only synthetic credit through bounded owner reads, then fresh cleanup remains possible.
  for (let n = 0; n < 120 && ok(await actor.account_balance()) > 0n; n++)
    ok(await actor.list_vaults());
  assert.equal(ok(await actor.account_balance()), 0n);
  const cleanupReq = {
    operation: b(20),
    public_key: ephemeral.public,
    credential: credential.id,
    purpose: { Cleanup: { job: b(21) } },
    generations,
  };
  const ch = ok(await actor.begin_cleanup(cleanupReq));
  const cleanupGrant = ok(
    await actor.finish_cleanup(b(20), assertion(ch, credential)),
  );
  const cancelAction = { CancelUpload: { upload: interrupted.operation } };
  const firstCancel = await send(cleanupGrant, 0n, {
    Cleanup: { job: b(21), cursor: 0n, action: cancelAction },
  });
  assert.equal(ok(firstCancel.result).Cleanup.complete, false);
  const cancelling = ok(
    await actor.get_upload_status(interrupted.operation),
  ).Pending;
  assert.deepEqual(cancelling.cancel_job, [b(21)]);
  assert.equal(cancelling.received.length, 0);
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.ok(
    "Err" in
      (
        await send(cleanupGrant, 1n, {
          Cleanup: { job: b(21), cursor: 1n, action: cancelAction },
        })
      ).result,
  );
  const ch2 = ok(await actor.begin_cleanup(cleanupReq));
  const cleanup2 = ok(
    await actor.finish_cleanup(b(20), assertion(ch2, credential)),
  );
  assert.notDeepEqual(cleanupGrant.id, cleanup2.id);
  const finalCancel = await send(cleanup2, 0n, {
    Cleanup: { job: b(21), cursor: 1n, action: cancelAction },
  });
  assert.equal(ok(finalCancel.result).Cleanup.complete, true);
  assert.deepEqual(ok(await actor.get_upload_status(interrupted.operation)), {
    Cancelled: null,
  });
  assert.equal(
    ok(await actor.list_pending_uploads(new Uint8Array())).entries.length,
    0,
  );
  assert.deepEqual(
    await actor.mutate(finalCancel.payload, finalCancel.signature),
    finalCancel.result,
  );
  assert.equal(
    ok(await actor.get_vault_header(b(1))).sequence,
    header.sequence,
  );
  assert.equal(ok(await actor.account_balance()), 0n);
  console.log(
    "PASS actual Wasm: owner-only encrypted upload status/list, zero-balance signed cancellation, per-chunk fencing, upgrade during cancellation, fresh proof resumes same job/cursor, terminal receipt and unchanged Vault sequence",
  );
  const purgeReq = {
    ...cleanupReq,
    operation: b(122),
    purpose: { Cleanup: { job: b(123) } },
  };
  const purgeChallenge = ok(await actor.begin_cleanup(purgeReq));
  const purgeGrant = ok(
    await actor.finish_cleanup(
      purgeReq.operation,
      assertion(purgeChallenge, credential),
    ),
  );
  const purge = await send(purgeGrant, 0n, {
    Cleanup: { job: b(123), cursor: 0n, action: { Purge: null } },
  });
  assert.equal(ok(purge.result).Cleanup.complete, true);
  assert.deepEqual(
    await actor.mutate(purge.payload, purge.signature),
    purge.result,
  );
  assert.equal(ok(await actor.list_vaults()).length, 0);
  assert.equal(ok(await actor.cleanup_status())[0].complete, true);
  assert.equal(ok(await actor.account_balance()), 0n);
  // Current v6 namespace: preserve the prepaid transition slot without
  // changing the durable creation identity or manufacturing fresh authority.
  const previous = await pic.setupCanister({
    sender: owner,
    idlFactory: vaultIDL,
    wasm: resolve(root, "target/vault-v6-baseline.wasm"),
    arg: IDL.encode([], []),
    cycles: 100_000_000_000_000n,
  });
  previous.actor.setPrincipal(owner);
  const config = {
    origin: "https://vault.kinic.xyz",
    rp_id: "vault.kinic.xyz",
    key_name: "key_1",
    minimum_cycles: 100_000_000_000n,
  };
  ok(await previous.actor.set_config([config]));
  ok(
    await previous.actor.set_funding_config([
      {
        ledger: fake.canisterId,
        recipient: previous.canisterId,
        cycles_per_kinic: 2_000_000_000n,
      },
    ]),
  );
  const funded = {
    ...purchase,
    operation: b(60),
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
  };
  ok(await previous.actor.quote_purchase(funded));
  ok(await previous.actor.pay_purchase(funded.operation));
  const pending = ok(
    await previous.actor.bootstrap({
      reserve: { vault: b(61), operation: b(62) },
      public_key: ephemeral.public,
    }),
  );
  assert.equal(pending.header.published_slot.length, 0);
  const beforeUpgrade = ok(await previous.actor.global_capacity());
  const unfinishedBefore = ok(await previous.actor.list_unfinished_vaults());
  await pic.upgradeCanister({
    sender: owner,
    canisterId: previous.canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  const afterUpgrade = ok(await previous.actor.global_capacity());
  assert.equal(afterUpgrade.used - beforeUpgrade.used, 0n);
  assert.deepEqual(
    ok(await previous.actor.list_unfinished_vaults()),
    unfinishedBefore,
  );
  assert.ok(
    "Conflict" in
      (await previous.actor.set_config([{ ...config, key_name: "other_key" }]))
        .Err,
  );
  assert.ok("Conflict" in (await previous.actor.set_config([])).Err);
  ok(
    await previous.actor.set_config([
      { ...config, minimum_cycles: 100_000_000_001n },
    ]),
  );
  await pic.upgradeCanister({
    sender: owner,
    canisterId: previous.canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.equal(
    ok(await previous.actor.global_capacity()).used,
    afterUpgrade.used,
  );
  ok(await previous.actor.cancel_vault_setup(b(61), b(62)));
  assert.equal(ok(await previous.actor.list_unfinished_vaults()).length, 0);
  ok(await previous.actor.set_config([]));
  console.log(
    "PASS actual Wasm: current v6 namespace keeps its prepaid reservations, repeated upgrade preserves it and the pending identity; incompatible configure/removal is rejected until cancellation completes.",
  );
  console.log(
    "PASS actual Wasm: v6-funded account survives upgrade; independent fresh generation, exact bootstrap retry, legacy key/write denial, fresh passkey grant, signed replay/cross-owner, bounded normal grants, expired pre-nonce second creation survives upgrade and cancels at zero balance, generated Pending creation cancels at zero balance, zero-balance cleanup, upgrade fence and final purge receipt.",
  );
} finally {
  await f.close();
}
