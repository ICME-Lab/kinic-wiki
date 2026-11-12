import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
import { verifyVaultBaseline } from "../helpers/vault-baseline.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  encryptDocument,
  rewrapManifest,
  decryptDocument,
  pack,
} from "../../packages/vault-crypto/src/documents.ts";
import {
  makeArchive,
  openArchive,
  targetRestoreRoot,
} from "../../packages/vault-backup/src/index.ts";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { idlFactory as vaultIDL } from "../../packages/vault-candid/index.js";
import { idlFactory as mutationFactory } from "../../packages/vault-candid/mutation.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const reuseSmoke = process.env.VAULT_RESTORE_REUSE_SMOKE === "1";
const baseline = "target/vault-v6-baseline.wasm";
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
function assertion(ch, credential, explicitCounter) {
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: b64(ch.bytes),
      origin: "https://vault.kinic.xyz",
      crossOrigin: false,
    }),
  );
  const counter =
    explicitCounter ?? (credential.counter = (credential.counter ?? 0) + 1);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  const auth = cat(hash("vault.kinic.xyz"), [5], count);
  return JSON.stringify({
    id: b64(credential.id),
    clientDataJSON: b64(client),
    authenticatorData: b64(auth),
    signature: b64(sign(null, cat(auth, hash(client)), credential.privateKey)),
    userHandle: b64(owner.toUint8Array()),
  });
}
verifyVaultBaseline(baseline);
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
    wasm: resolve(root, baseline),
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

  const sourceRoot = await importKey(sourceRaw);
  const document = await encryptDocument(
    sourceRoot,
    b(1),
    b(20),
    1n,
    { kind: "note", title: "retained history" },
    new TextEncoder().encode("retained encrypted history"),
    cryptoG(sourceG),
  );
  const upload = ok(
    (
      await send(bootstrap, {
        BeginRevision: {
          vault: b(1),
          object: b(20),
          expected_revision: 0n,
          operation: b(21),
          plain_size: 26n,
          manifest: document.manifest,
          chunk_hashes: document.hashes,
        },
      })
    ).result,
  ).Upload;
  ok(
    (
      await send(bootstrap, {
        PutChunk: {
          vault: b(1),
          upload: upload.id,
          index: 0,
          data: document.chunks[0],
        },
      })
    ).result,
  );
  ok(
    (
      await send(bootstrap, {
        CommitRevision: { vault: b(1), upload: upload.id },
      })
    ).result,
  );
  ok(
    (
      await send(bootstrap, {
        DeleteObject: {
          vault: b(1),
          object: b(20),
          expected_revision: 1n,
          operation: b(22),
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
    if (
      "RestorePrepare" in purpose ||
      "RestoreTarget" in purpose ||
      "RestoreCleanup" in purpose
    ) {
      const ch = ok(await actor.begin_restore_grant(request));
      return ok(
        await actor.finish_restore_grant(
          request.operation,
          assertion(ch, passkey),
          "RestoreCleanup" in purpose,
        ),
      );
    }
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
  await pic?.tearDown();
  await server.stop();
}
