import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
import { verifyVaultBaseline } from "../helpers/vault-baseline.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
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
verifyVaultBaseline("target/vault-v6-baseline.wasm");
const cryptoLib = await import(
  new URL("../../packages/vault-crypto/src/index.ts", import.meta.url)
);
const {
  TransportSecretKey,
  verifiedGenerationKEK,
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  openV2,
  generationAAD,
  recoveryVerifier,
} = cryptoLib;
const server = await startVaultPocketIc(PocketIcServer.getBinPath());
let pic;
try {
  pic = await PocketIc.create(server.getUrl(), {
    fiduciary: { state: { type: "new" } },
    icpConfig: { betaFeatures: "Enabled" },
  });
  const wasm = resolve(
    root,
    "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  );
  const fixture = await pic.setupCanister({
    sender: owner,
    idlFactory: vaultIDL,
    wasm: resolve(root, "target/vault-v6-baseline.wasm"),
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
        cycles_per_kinic: 2_000_000_000_000n,
      },
    ]),
  );
  const purchase = {
    operation: b(80),
    beneficiary: owner,
    amount_e8s: 100_000_000n,
    min_credits: 2_000_000_000_000n,
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
    credential = { ...key(), id: b(41) },
    lost = { ...key(), id: b(42) };
  const setup = ok(
    await actor.bootstrap({
      reserve: { vault: b(1), operation: b(2) },
      public_key: ephemeral.public,
    }),
  );
  const bootstrap = ok(
    await actor.register_bootstrap(
      b(2),
      registration(setup.challenge, credential),
    ),
  );
  const counters = new Map();
  async function send(grant, operation) {
    const id = Buffer.from(grant.id).toString("hex"),
      counter = counters.get(id) ?? 0n;
    const payload = new Uint8Array(
      IDL.encode(
        [mutationType],
        [
          {
            version: 2,
            owner,
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
    const result = await actor.mutate(payload, signature);
    if ("Ok" in result) counters.set(id, counter + 1n);
    return { result, payload, signature };
  }
  const cryptoG = (g) => ({
    ...g,
    version: 2,
    canister: g.canister.toText(),
    owner: g.owner.toText(),
    vault: new Uint8Array(g.vault),
    nonce: new Uint8Array(g.nonce),
  });
  async function derive(grant, g, job, attempt, role) {
    const transport = TransportSecretKey.random();
    const op = job
      ? {
          IncidentDerive: {
            job,
            attempt,
            role,
            generation: g,
            transport: transport.publicKeyBytes(),
          },
        }
      : {
          Derive: {
            vault: g.vault,
            epoch: g.epoch,
            attempt: [b(2)],
            assertion: [],
            transport: transport.publicKeyBytes(),
          },
        };
    const handle = ok((await send(grant, op)).result).Handle;
    const key = ok((await send(grant, { KeyResult: { handle } })).result).Key;
    return verifiedGenerationKEK(
      new Uint8Array(key.encrypted_key),
      transport,
      cryptoG(g),
      true,
    );
  }
  const sourceG = setup.header.generation[0];
  const sourceKEK = await derive(bootstrap, sourceG);
  const sourceRaw = randomBytes(32),
    sourceSecret = randomBytes(32);
  const normal = await sealV2(
    sourceKEK,
    sourceRaw,
    generationAAD(cryptoG(sourceG), b(0), 0n, "normal"),
  );
  const recovery = await sealV2(
    await deriveKey(sourceSecret, "recovery"),
    sourceRaw,
    generationAAD(cryptoG(sourceG), b(0), 0n, "recovery"),
  );
  ok(
    (
      await send(bootstrap, {
        Activate: {
          request: {
            vault: b(1),
            attempt: [b(2)],
            operation: b(3),
            normal,
            recovery,
            registration: [],
            assertion: [],
          },
          recovery_verifier: await recoveryVerifier(sourceSecret),
        },
      })
    ).result,
  );
  let operation = 50;
  async function fresh(purpose, generations = [sourceG], passkey = credential) {
    const request = {
      operation: b(operation++),
      public_key: ephemeral.public,
      credential: passkey.id,
      purpose,
      generations,
    };
    const cleanup = "Cleanup" in purpose;
    const ch = ok(
      await (cleanup ? actor.begin_cleanup : actor.begin_grant)(request),
    );
    return ok(
      await (cleanup ? actor.finish_cleanup : actor.finish_grant)(
        request.operation,
        assertion(ch, passkey),
      ),
    );
  }
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
  await pic?.tearDown();
  await server.stop();
}
