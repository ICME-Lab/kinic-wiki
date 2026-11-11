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
assert.equal(
  hash(
    readFileSync(resolve(root, "target/vault-dedicated-task8-fix2.wasm")),
  ).toString("hex"),
  "0caa897e55b373bcb70e7e8c153e9eaf7fb12ed950d4bc7a6f277b12fc719f6d",
);
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
const server = await PocketIcServer.start();
let pic;
try {
  pic = await PocketIc.create(server.getUrl(), {
    fiduciary: { state: { type: "new" } },
    icpConfig: { betaFeatures: "Enabled" },
  });
  const wasm = resolve(
    root,
    "target/wasm32-unknown-unknown/release/vault_canister.wasm",
  );
  const fixture = await pic.setupCanister({
    sender: owner,
    idlFactory: vaultIDL,
    wasm: resolve(root, "target/vault-dedicated-task8-fix2.wasm"),
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
      wasm: resolve(root, "target/vault-incident-quota.wasm"),
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

  const sourceExport = ok(await actor.begin_export(b(1), b(95)));
  const targetRoot = await importKey(targetRaw);
  const sourcePage = ok(
    await actor.incident_source_index(j.job, b(1), b(71), 0n),
  );
  assert.equal(sourcePage.entries.length, 2);
  assert.equal(sourcePage.entries[1].deleted, true);
  const rows = [];
  for (const r of sourcePage.entries) {
    let wrapper = new Uint8Array();
    if (!r.deleted) {
      const manifest = await rewrapManifest(
        sourceRoot,
        targetRoot,
        b(1),
        new Uint8Array(r.object),
        r.revision,
        new Uint8Array(r.manifest),
        cryptoG(targetG),
        cryptoG(sourceG),
      );
      wrapper = new TextEncoder().encode(
        JSON.stringify(JSON.parse(new TextDecoder().decode(manifest)).dek),
      );
    }
    rows.push({
      object: r.object,
      revision: r.revision,
      sequence: r.sequence,
      source_digest: hash(r.manifest),
      wrapper,
    });
  }
  const wrapped = await send(resumed, {
    IncidentWrap: { vault: b(1), attempt: b(71), after: 0n, rows },
  });
  ok(wrapped.result);
  assert.deepEqual(
    await actor.mutate(wrapped.payload, wrapped.signature),
    wrapped.result,
  );
  const read = {
    descriptor_digest: b(0, 32),
    job: j.job,
    vault: b(1),
    attempt: b(71),
    export: b(96),
  };
  assert.ok("Err" in (await actor.incident_staged_export(read)));
  ok(
    (
      await send(resumed, {
        IncidentPrepareExport: { vault: b(1), attempt: b(71), export: b(96) },
      })
    ).result,
  );
  read.descriptor_digest = ok(
    await actor.incident_status(),
  )[0].targets[0].staged_export[0].descriptor_digest;
  const descriptor = ok(await actor.incident_staged_export(read));
  const stateBefore = ok(await actor.incident_status())[0],
    balanceBefore = ok(await actor.account_balance());
  const staged = ok(await actor.incident_staged_index(read, 0n));
  assert.deepEqual(ok(await actor.incident_status())[0], stateBefore);
  assert.equal(ok(await actor.account_balance()), balanceBefore);
  actor.setPrincipal(other);
  assert.ok("Err" in (await actor.incident_staged_export(read)));
  actor.setPrincipal(owner);
  const records = staged.entries.map((r) => ({
    vault: b64(r.vault),
    object: b64(r.object),
    revision: String(r.revision),
    sequence: String(r.sequence),
    plain_size: String(r.plain_size),
    manifest: b64(r.manifest),
    hashes: r.chunk_hashes.map(b64),
    deleted: r.deleted,
  }));
  const header = {
    version: 2,
    envelope_revision: "0",
    vault: b64(b(1)),
    epoch: String(targetG.epoch),
    sequence: String(descriptor.export.sequence),
    key_name: targetG.key_name,
    generation: {
      ...cryptoG(targetG),
      vault: b64(targetG.vault),
      nonce: b64(targetG.nonce),
      epoch: String(targetG.epoch),
    },
    recovery_verifier: b64(await recoveryVerifier(targetSecret)),
    normal: pack(targetNormal),
    recovery: pack(targetRecovery),
    record_count: 2,
    chunk_count: 1,
    plain_bytes: "26",
  };
  const archive = await makeArchive(
    header,
    records,
    async (r, i) =>
      new Uint8Array(
        ok(
          await actor.incident_staged_chunk(
            read,
            new Uint8Array(Buffer.from(r.object, "base64url")),
            BigInt(r.revision),
            i,
          ),
        ),
      ),
    targetRaw,
  );
  const dir = await mkdtemp(join(tmpdir(), "vault-task9-staged-"));
  try {
    await writeFile(join(dir, "staged.kvlt"), archive);
    await writeFile(join(dir, "secret"), b64(targetSecret));
    const reselected = new Uint8Array(await readFile(join(dir, "staged.kvlt")));
    const opened = await openArchive(reselected, targetSecret);
    assert.deepEqual(opened.rootRaw, targetRaw);
    assert.equal(b64(opened.restoreRoot), b64(descriptor.commitment));
    opened.rootRaw.fill(0);
    const cli = spawnSync(
      process.execPath,
      [
        resolve(root, "tools/vault-recovery/src/main.mjs"),
        "--backup",
        join(dir, "staged.kvlt"),
        "--secret-file",
        join(dir, "secret"),
        "--output",
        join(dir, "recovered"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(!cli.stdout.includes(b64(targetSecret)));
    console.log(
      "PASS saved staged archive opens in independent network-disabled CLI before publication",
    );
    ok(
      (
        await send(resumed, {
          IncidentConfirmBackup: {
            vault: b(1),
            attempt: b(71),
            ack: {
              descriptor_digest: descriptor.descriptor_digest,
              commitment: descriptor.commitment,
              archive_hash: hash(reselected),
              archive_length: BigInt(reselected.length),
              recovery_verifier: descriptor.export.header.recovery_verifier,
              sequence: descriptor.export.sequence,
            },
          },
        })
      ).result,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const verified = ok(await actor.incident_status())[0];
  await pic.upgradeCanister({
    sender: owner,
    canisterId,
    wasm,
    arg: IDL.encode([], []),
  });
  assert.deepEqual(ok(await actor.incident_status())[0], verified);
  await pic.advanceTime(500_000);
  await pic.tick(2);
  const digest = ok(await actor.incident_cutover_digest());
  const finalGrant = await fresh({ IncidentCutover: { job: j.job, digest } });
  const final = await send(finalGrant, { IncidentCutover: { digest } });
  ok(final.result);
  const completed = ok(await actor.incident_status())[0];
  assert.equal(completed.complete, true);
  assert.equal(b64(completed.completed_digest[0]), b64(digest));
  const published = ok(await actor.get_vault_header(b(1)));
  assert.deepEqual(published.generation, [targetG]);
  assert.equal(published.backup_sequence[0], descriptor.export.sequence);
  assert.ok("Active" in published.state);
  assert.ok("Err" in (await actor.incident_staged_index(read, 0n)));
  assert.ok("Err" in (await actor.export_index(sourceExport.id, 0n)));
  assert.ok("Err" in (await send(resumed, { IncidentCancel: null })).result);
  const normalAfter = await fresh({ Normal: null }, [targetG]);
  assert.equal(
    ok((await send(normalAfter, { ClearInactive: { vault: b(1) } })).result)
      .InactiveCleanup.complete,
    true,
  );
  const live = ok(await actor.begin_export(b(1), b(97)));
  const livePage = ok(await actor.export_index(live.id, 0n));
  assert.deepEqual(livePage.entries, staged.entries);
  const future = await encryptDocument(
    targetRoot,
    b(1),
    b(30),
    1n,
    { kind: "note", title: "future" },
    new TextEncoder().encode("future"),
    cryptoG(targetG),
  );
  await assert.rejects(
    decryptDocument(
      sourceRoot,
      b(1),
      b(30),
      1n,
      future.manifest,
      future.chunks,
      future.hashes,
      cryptoG(targetG),
    ),
  );
  if (process.env.VAULT_INCIDENT_FULL_QUOTA)
    assert.equal(ok(await actor.global_capacity()).used, 200n * 1024n * 1024n);
  console.log(
    "PASS Task8 baseline upgrade, actual vetKD, retained deleted-object history, bounded wrapper upload, exact readonly staged pages/chunks, saved/reopened full archive, upgrade/resume, fresh UV atomic cutover, completed receipt, old descriptor/grant denial and old-root future-DEK denial",
  );
} finally {
  await pic?.tearDown();
  await server.stop();
}
