import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { idlFactory as vaultIDL } from "../../packages/vault-candid/index.js";
import { idlFactory as mutationFactory } from "../../packages/vault-candid/mutation.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const local = createRequire(new URL("../package.json", import.meta.url));
const req = createRequire(realpathSync(local.resolve("@dfinity/pic")));
const { PocketIc, PocketIcServer } = req("@dfinity/pic"),
  { IDL } = req("@icp-sdk/core/candid"),
  { Principal } = req("@icp-sdk/core/principal");
if (process.env.POCKET_IC_BIN)
  PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const b = (n, len = 16) => new Uint8Array(len).fill(n),
  cat = (...x) => Buffer.concat(x.map((v) => Buffer.from(v))),
  hash = (x) => createHash("sha256").update(x).digest(),
  b64 = (x) => Buffer.from(x).toString("base64url");
const key = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    ...pair,
    public: Buffer.from(
      pair.publicKey.export({ format: "jwk" }).x,
      "base64url",
    ),
  };
};
const owner = Principal.selfAuthenticating(b(90, 32)),
  other = Principal.selfAuthenticating(b(91, 32));
const ok = (x) => {
  assert.ok(
    "Ok" in x,
    JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  return x.Ok;
};
const mutationType = mutationFactory({ IDL })._fields.find(
  ([n]) => n === "encode",
)[1].argTypes[0];
// Tiny deterministic CBOR encoder for the standard WebAuthn none attestation fixture.
const cb = (major, n) =>
  n < 24
    ? Buffer.from([major * 32 + n])
    : n < 256
      ? Buffer.from([major * 32 + 24, n])
      : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
const cbor = (x) =>
  typeof x === "string"
    ? cat(cb(3, Buffer.byteLength(x)), Buffer.from(x))
    : Buffer.isBuffer(x)
      ? cat(cb(2, x.length), x)
      : cat(
          cb(5, Object.keys(x).length),
          ...Object.entries(x).flatMap(([k, v]) => [cbor(k), cbor(v)]),
        );
function registration(ch, credential) {
  const cose = cat(
    Buffer.from([0xa4, 1, 1, 3, 0x27, 0x20, 6, 0x21, 0x58, 0x20]),
    credential.public,
  );
  const auth = cat(
    hash("vault.kinic.xyz"),
    [0x45],
    [0, 0, 0, 0],
    b(0),
    [0, 16],
    credential.id,
    cose,
  );
  const client = JSON.stringify({
    type: "webauthn.create",
    challenge: b64(ch.bytes),
    origin: "https://vault.kinic.xyz",
    crossOrigin: false,
  });
  return JSON.stringify({
    id: b64(credential.id),
    transports: ["internal"],
    clientDataJSON: b64(Buffer.from(client)),
    attestationObject: b64(cbor({ fmt: "none", attStmt: {}, authData: auth })),
  });
}
function assertion(ch, credential) {
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: b64(ch.bytes),
      origin: "https://vault.kinic.xyz",
      crossOrigin: false,
    }),
  );
  const auth = cat(hash("vault.kinic.xyz"), [5], [0, 0, 0, 0]);
  return JSON.stringify({
    id: b64(credential.id),
    clientDataJSON: b64(client),
    authenticatorData: b64(auth),
    signature: b64(sign(null, cat(auth, hash(client)), credential.privateKey)),
    userHandle: b64(owner.toUint8Array()),
  });
}
const server = await startVaultPocketIc(PocketIcServer.getBinPath());
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  const wasm = resolve(
    root,
    "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  );
  const fixture = await pic.setupCanister({
    sender: owner,
    idlFactory: vaultIDL,
    wasm: resolve(root, "target/vault-dedicated-task4.wasm"),
    arg: IDL.encode([], []),
    cycles: 100_000_000_000_000n,
  });
  const { actor, canisterId } = fixture;
  actor.setPrincipal(owner);
  ok(
    await actor.set_config([
      {
        origin: "https://vault.kinic.xyz",
        rp_id: "vault.kinic.xyz",
        key_name: "key_1",
        minimum_cycles: 100_000_000_000n,
      },
    ]),
  );
  const fake = await pic.setupCanister({
    sender: owner,
    idlFactory: () =>
      IDL.Service({ configure: IDL.Func([IDL.Nat8, IDL.Nat64], [], []) }),
    wasm: resolve(
      root,
      "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
    ),
    arg: IDL.encode([], []),
    cycles: 10_000_000_000_000n,
  });
  fake.actor.setPrincipal(owner);
  await fake.actor.configure(0, 10n);
  ok(
    await actor.set_funding_config([
      {
        ledger: fake.canisterId,
        recipient: canisterId,
        cycles_per_kinic: 2_000_000_000n,
      },
    ]),
  );
  const purchase = {
    operation: b(80),
    beneficiary: owner,
    amount_e8s: 100_000_000n,
    min_credits: 2_000_000_000n,
    created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
  };
  ok(await actor.quote_purchase(purchase));
  ok(await actor.pay_purchase(purchase.operation));
  const paid = ok(await actor.account_balance());
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.equal(ok(await actor.account_balance()), paid);
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
  const uploadGrant=await newGrant(10);
  const interrupted={vault:b(1),object:b(118),operation:b(119),expected_revision:0n,plain_size:1n,manifest:b(99,1),chunk_hashes:[hash(b(7,17))]};
  ok((await send(uploadGrant,0n,{BeginRevision:interrupted})).result);
  ok((await send(uploadGrant,1n,{PutChunk:{vault:b(1),upload:interrupted.operation,index:0,data:b(7,17)}})).result);
  assert.equal(ok(await actor.list_pending_uploads(new Uint8Array())).entries.length,1);
  actor.setPrincipal(other);
  const foreignUpload=await actor.get_upload_status(interrupted.operation);
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
  const cancelAction={CancelUpload:{upload:interrupted.operation}};
  const firstCancel=await send(cleanupGrant,0n,{Cleanup:{job:b(21),cursor:0n,action:cancelAction}});
  assert.equal(ok(firstCancel.result).Cleanup.complete,false);
  const cancelling=ok(await actor.get_upload_status(interrupted.operation)).Pending;
  assert.deepEqual(cancelling.cancel_job,[b(21)]);
  assert.equal(cancelling.received.length,0);
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
  const finalCancel=await send(cleanup2,0n,{Cleanup:{job:b(21),cursor:1n,action:cancelAction}});
  assert.equal(ok(finalCancel.result).Cleanup.complete,true);
  assert.deepEqual(ok(await actor.get_upload_status(interrupted.operation)),{Cancelled:null});
  assert.equal(ok(await actor.list_pending_uploads(new Uint8Array())).entries.length,0);
  assert.deepEqual(await actor.mutate(finalCancel.payload,finalCancel.signature),finalCancel.result);
  assert.equal(ok(await actor.get_vault_header(b(1))).sequence,header.sequence);
  assert.equal(ok(await actor.account_balance()),0n);
  console.log("PASS actual Wasm: owner-only encrypted upload status/list, zero-balance signed cancellation, per-chunk fencing, upgrade during cancellation, fresh proof resumes same job/cursor, terminal receipt and unchanged Vault sequence");
  const purgeReq={...cleanupReq,operation:b(122),purpose:{Cleanup:{job:b(123)}}};
  const purgeChallenge=ok(await actor.begin_cleanup(purgeReq));
  const purgeGrant=ok(await actor.finish_cleanup(purgeReq.operation,assertion(purgeChallenge,credential)));
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
  // Frozen Task6/v3 namespace: migrate the prepaid transition slot without
  // changing the durable creation identity or manufacturing fresh authority.
  const previous = await pic.setupCanister({
    sender: owner,
    idlFactory: vaultIDL,
    wasm: resolve(root, "target/vault-dedicated-task6.wasm"),
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
  assert.equal(afterUpgrade.used - beforeUpgrade.used, 65_536n + 524_288n);
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
    "PASS actual Wasm: frozen Task6 namespace gains one 64 KiB transition reservation plus 512 KiB namespace control reservation, repeated upgrade preserves it and the pending identity; incompatible configure/removal is rejected until cancellation completes.",
  );
  console.log(
    "PASS actual Wasm: Task4-funded account survives upgrade; independent fresh generation, exact bootstrap retry, legacy key/write denial, fresh passkey grant, signed replay/cross-owner, bounded normal grants, expired pre-nonce second creation survives upgrade and cancels at zero balance, generated Pending creation cancels at zero balance, zero-balance cleanup, upgrade fence and final purge receipt.",
  );
} finally {
  if (pic) await pic.tearDown();
  await server.stop();
}
