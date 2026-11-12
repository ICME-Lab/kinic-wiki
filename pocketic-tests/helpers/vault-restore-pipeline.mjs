// Actual Candid/passkey/vetKD restore operations; no actor or crypto stubs.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  b,
  b64,
  hash,
  key,
  ok,
  registration,
  assertion,
  cryptoLib,
  root,
  Principal,
} from "./vault-restore-fixture.mjs";
import { pack, unpack } from "../../packages/vault-crypto/src/documents.ts";
import {
  makeArchive,
  openArchive,
  transformArchive,
  headerGeneration,
} from "../../packages/vault-backup/src/index.ts";
const bytes = (x) => new Uint8Array(x);
const unb64 = (x) => bytes(Buffer.from(x, "base64url"));
export function record(r) {
  return {
    vault: b64(r.vault),
    object: b64(r.object),
    revision: String(r.revision),
    sequence: String(r.sequence),
    plain_size: String(r.plain_size),
    manifest: b64(r.manifest),
    hashes: r.chunk_hashes.map(b64),
    deleted: r.deleted,
  };
}
export function revision(r) {
  return {
    vault: unb64(r.vault),
    object: unb64(r.object),
    revision: BigInt(r.revision),
    sequence: BigInt(r.sequence),
    plain_size: BigInt(r.plain_size),
    manifest: unb64(r.manifest),
    chunk_hashes: r.hashes.map(unb64),
    deleted: r.deleted,
  };
}
export async function sourceArchive(f) {
  const h = ok(await f.actor.get_vault_header(f.sourceG.vault));
  const records = [];
  for (const n of [1n, 2n])
    records.push(record(ok(await f.actor.get_manifest(h.id, b(20), n))));
  const header = {
    version: 2,
    envelope_revision: "0",
    vault: b64(h.id),
    epoch: String(h.epoch),
    sequence: String(h.sequence),
    key_name: h.key_name,
    generation: {
      ...f.cryptoG(f.sourceG),
      vault: b64(h.id),
      nonce: b64(f.sourceG.nonce),
      epoch: String(h.epoch),
    },
    recovery_verifier: b64(h.recovery_verifier),
    normal: pack({
      ...h.normal[0],
      nonce: bytes(h.normal[0].nonce),
      ciphertext: bytes(h.normal[0].ciphertext),
    }),
    recovery: pack({
      ...h.recovery[0],
      nonce: bytes(h.recovery[0].nonce),
      ciphertext: bytes(h.recovery[0].ciphertext),
    }),
    record_count: 2,
    chunk_count: 1,
    plain_bytes: "26",
  };
  const archive = await makeArchive(
    header,
    records,
    async (r, i) =>
      bytes(
        ok(
          await f.actor.get_chunk(h.id, unb64(r.object), BigInt(r.revision), i),
        ),
      ),
    f.sourceRaw,
  );
  await offline(archive, f.sourceSecret);
  return { archive, secret: f.sourceSecret };
}
export async function offline(archive, secret) {
  const dir = await mkdtemp(join(tmpdir(), "vault-actual-restore-"));
  try {
    await writeFile(join(dir, "backup"), archive);
    await writeFile(join(dir, "secret"), b64(secret));
    const run = spawnSync(
      process.execPath,
      [
        "tools/vault-recovery/src/main.mjs",
        "--backup",
        join(dir, "backup"),
        "--secret-file",
        join(dir, "secret"),
        "--output",
        join(dir, "out"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      await readFile(
        join(dir, "out", Buffer.from(b(20)).toString("hex") + "-1.bin"),
        "utf8",
      ),
      "retained encrypted history",
    );
    assert.ok(!(run.stdout + run.stderr).includes(b64(secret)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function currentProof(f, j, secret) {
  const signing = await cryptoLib.recoverySigningKey(secret);
  return f.actor.prove_restore_current(
    j.request.job,
    bytes(
      await crypto.subtle.sign("Ed25519", signing, bytes(j.recovery_message)),
    ),
  );
}
export async function resume(f, r) {
  const ch = ok(await f.actor.resume_restore_admission(r.request.job));
  const j = ok(
    await f.actor.prove_restore_candidate(
      r.request.job,
      assertion(ch, r.candidate),
    ),
  );
  if (j.current_live.length) ok(await currentProof(f, j, r.currentSecret));
  return f.fresh(
    { RestoreTarget: { job: r.request.job, generation: r.target } },
    [],
    r.candidate,
  );
}
export async function prepare(
  f,
  source,
  {
    id = 100,
    candidate = { ...key(), id: b(43) },
    existing = false,
    currentSecret = source.secret,
    afterAdmission,
  } = {},
) {
  const opened = await openArchive(source.archive, source.secret);
  const context = ok(await f.actor.incident_context())[0];
  const sg = headerGeneration(opened.header);
  const request = {
    candidate_mode: existing ? [{ ExistingInstances: candidate.id }] : [],
    job: b(id),
    target: {
      namespace: context.namespace,
      vault: unb64(opened.header.vault),
      attempt: b(id + 1),
    },
    archive_digest: hash(source.archive),
    source_commitment: opened.restoreRoot,
    source_epoch: BigInt(opened.header.epoch),
    source_generation: sg
      ? [
          {
            ...sg,
            canister: Principal.fromText(sg.canister),
            owner: Principal.fromText(sg.owner),
          },
        ]
      : [],
    archive_length: BigInt(source.archive.length),
    records: BigInt(opened.records.length),
    reserved_bytes: 0n,
  };
  let ch = ok(await f.actor.begin_restore_admission(request));
  if (!existing)
    ch = ok(
      await f.actor.register_restore_candidate(
        request.job,
        registration(ch, candidate),
      ),
    );
  const j = ok(
    await f.actor.prove_restore_candidate(
      request.job,
      assertion(ch, candidate),
    ),
  );
  if (j.current_live.length) {
    assert.ok("Err" in (await currentProof(f, j, cryptoLib.randomBytes(32))));
    if (b64(source.secret) !== b64(currentSecret))
      assert.ok("Err" in (await currentProof(f, j, source.secret)));
    ok(await currentProof(f, j, currentSecret));
  }
  if (afterAdmission) {
    opened.rootRaw.fill(0);
    return afterAdmission({ request, candidate, currentSecret, admission: j });
  }
  const prep = await f.fresh(
    { RestorePrepare: { job: request.job, target: request.target } },
    [],
    candidate,
  );
  ok((await f.send(prep, { RestoreAllocate: null })).result);
  const target = ok(await f.actor.restore_admission_status())[0].pipeline[0]
    .target;
  assert.equal(
    target.epoch,
    (sg && sg.epoch > j.current_live[0]?.epoch
      ? sg.epoch
      : (j.current_live[0]?.epoch ?? BigInt(opened.header.epoch))) + 1n,
  );
  const grant = await f.fresh(
    { RestoreTarget: { job: request.job, generation: target } },
    [],
    candidate,
  );
  const transport = cryptoLib.TransportSecretKey.random();
  const handle = ok(
    (
      await f.send(grant, {
        RestoreDerive: {
          job: request.job,
          attempt: request.target.attempt,
          role: { Target: null },
          generation: target,
          transport: transport.publicKeyBytes(),
        },
      })
    ).result,
  ).Handle;
  const derived = ok(
    (await f.send(grant, { KeyResult: { handle } })).result,
  ).Key;
  const kek = await cryptoLib.verifiedGenerationKEK(
    bytes(derived.encrypted_key),
    transport,
    f.cryptoG(target),
    true,
  );
  if (sg)
    await assert.rejects(
      cryptoLib.openV2(
        kek,
        unpack(opened.header.normal),
        cryptoLib.generationAAD(
          sg,
          b(0),
          BigInt(opened.header.envelope_revision ?? opened.header.epoch),
          "normal",
        ),
      ),
    );
  const transformed = await transformArchive(
    source.archive,
    source.secret,
    f.cryptoG(target),
    kek,
    j.current_live[0] && f.cryptoG(j.current_live[0]),
  );
  assert.deepEqual(transformed.chunks, opened.chunks);
  for (let i = 0; i < opened.records.length; i++) {
    const a = opened.records[i],
      c = transformed.records[i];
    assert.deepEqual({ ...a, manifest: "" }, { ...c, manifest: "" });
    if (!a.deleted) {
      const old = JSON.parse(Buffer.from(unb64(a.manifest)).toString("utf8"));
      const fresh = JSON.parse(Buffer.from(unb64(c.manifest)).toString("utf8"));
      assert.deepEqual(fresh.metadata, old.metadata);
      assert.deepEqual(fresh.nonces, old.nonces);
    }
  }
  await offline(transformed.archive, transformed.recoverySecret);
  const normal = unpack(transformed.header.normal),
    recovery = unpack(transformed.header.recovery);
  ok(
    (
      await f.send(grant, {
        RestoreStage: {
          normal,
          recovery,
          recovery_verifier: unb64(transformed.header.recovery_verifier),
        },
      })
    ).result,
  );
  assert.ok(
    "Err" in (await f.send(grant, { RestoreBeginImport: null })).result,
  );
  const p = ok(await f.actor.restore_admission_status())[0].pipeline[0];
  assert.deepEqual(
    (
      await f.send(grant, {
        RestoreConfirmKit: { envelope_digest: b(255, 32) },
      })
    ).result,
    { Err: { Unauthorized: null } },
  );
  ok(
    (
      await f.send(grant, {
        RestoreConfirmKit: { envelope_digest: p.envelope_digest },
      })
    ).result,
  );
  const preflight = summary(request, transformed);
  opened.rootRaw.fill(0);
  return {
    request,
    candidate,
    currentSecret,
    target,
    grant,
    transformed,
    preflight,
    current: j.current_live[0],
  };
}
// Independently encoded canonical Rust Revision JSON, including numeric u64 fields.
export function summary(request, t) {
  let revision_bytes = 0n,
    peak_pending_bytes = 0n,
    plain_bytes = 0n,
    chunks = 0n;
  const heads = new Map();
  for (const portable of t.records) {
    const r = revision(portable),
      hashes = JSON.stringify(r.chunk_hashes.map((x) => [...x]));
    revision_bytes += r.deleted
      ? 4096n
      : 4096n +
        r.plain_size +
        BigInt(r.chunk_hashes.length) * 4112n +
        BigInt(r.manifest.length + hashes.length) +
        4096n;
    const pending = `{"vault":${JSON.stringify([...r.vault])},"object":${JSON.stringify([...r.object])},"revision":${r.revision},"plain_size":${r.plain_size},"manifest":${JSON.stringify([...r.manifest])},"chunk_hashes":${hashes},"deleted":${r.deleted},"sequence":${r.sequence}}`;
    peak_pending_bytes =
      peak_pending_bytes > BigInt(pending.length)
        ? peak_pending_bytes
        : BigInt(pending.length);
    heads.set(portable.object, r);
    plain_bytes += r.plain_size;
    chunks += BigInt(r.chunk_hashes.length);
  }
  return {
    archive_digest: request.archive_digest,
    archive_length: request.archive_length,
    source_commitment: request.source_commitment,
    target_commitment: t.targetRestoreRoot,
    sequence: BigInt(t.header.sequence),
    records: BigInt(t.records.length),
    objects: BigInt(heads.size),
    chunks,
    revision_bytes,
    peak_pending_bytes,
    current_plain_bytes: [...heads.values()].reduce(
      (n, r) => n + (r.deleted ? 0n : r.plain_size),
      0n,
    ),
    plain_bytes,
    source_saved: true,
    source_fully_verified: true,
  };
}
export async function importAndActivate(
  f,
  r,
  { beforeActivate, afterRecordStage } = {},
) {
  ok((await f.send(r.grant, { RestorePreflight: r.preflight })).result);
  if (r.current) {
    const clean = await f.fresh(
      { RestoreCleanup: { job: r.request.job, target: r.request.target } },
      [],
      r.candidate,
    );
    for (
      let cursor = 0n;
      !ok(await f.actor.restore_admission_status())[0].pipeline[0].old_removed;
      cursor++
    )
      ok(
        (
          await f.send(clean, {
            RestoreDiscard: { current: r.current, cursor },
          })
        ).result,
      );
  }
  ok((await f.send(r.grant, { RestoreBeginImport: null })).result);
  assert.ok("Err" in (await f.send(r.grant, { RestoreActivate: null })).result);
  for (const [n, portable] of r.transformed.records.entries()) {
    ok((await f.send(r.grant, { RestoreRecord: revision(portable) })).result);
    await afterRecordStage?.(n);
    for (const [index, data] of r.transformed.chunks[n].entries())
      ok((await f.send(r.grant, { RestoreChunk: { index, data } })).result);
    ok(
      (
        await f.send(r.grant, {
          RestoreCommitRecord: { sequence: BigInt(portable.sequence) },
        })
      ).result,
    );
  }
  const d = ok(
    await f.actor.restore_target_descriptor(r.request.job, r.target),
  );
  const page = ok(
    await f.actor.restore_target_index(r.request.job, r.target, 0n),
  );
  assert.deepEqual(page.entries.map(record), r.transformed.records);
  assert.equal(b64(d.commitment), b64(r.transformed.targetRestoreRoot));
  for (const [n, p] of r.transformed.records.entries())
    for (let i = 0; i < p.hashes.length; i++)
      assert.equal(
        b64(
          ok(
            await f.actor.restore_target_chunk(
              r.request.job,
              r.target,
              unb64(p.object),
              BigInt(p.revision),
              i,
            ),
          ),
        ),
        b64(r.transformed.chunks[n][i]),
      );
  await offline(r.transformed.archive, r.transformed.recoverySecret);
  assert.ok("Err" in (await f.send(r.grant, { RestoreActivate: null })).result);
  assert.ok(
    "Err" in
      (
        await f.send(r.grant, {
          RestoreConfirmBackup: {
            descriptor_digest: d.descriptor_digest,
            commitment: r.request.source_commitment,
            archive_hash: hash(r.transformed.archive),
            archive_length: BigInt(r.transformed.archive.length),
            recovery_verifier: d.export.header.recovery_verifier,
            sequence: d.export.sequence,
          },
        })
      ).result,
  );
  ok(
    (
      await f.send(r.grant, {
        RestoreConfirmBackup: {
          descriptor_digest: d.descriptor_digest,
          commitment: d.commitment,
          archive_hash: hash(r.transformed.archive),
          archive_length: BigInt(r.transformed.archive.length),
          recovery_verifier: d.export.header.recovery_verifier,
          sequence: d.export.sequence,
        },
      })
    ).result,
  );
  await beforeActivate?.();
  ok((await f.send(r.grant, { RestoreActivate: null })).result);
  assert.deepEqual(
    ok(await f.actor.get_vault_header(r.target.vault)).generation,
    [r.target],
  );
  return {
    archive: r.transformed.archive,
    secret: r.transformed.recoverySecret,
  };
}
export async function rejectInvalidPreflight(f, r) {
  const before = ok(await f.actor.get_vault_header(r.current.vault));
  for (const change of [
    { peak_pending_bytes: 400001n },
    { objects: 3n },
    { chunks: 21n },
    { current_plain_bytes: 104857601n, plain_bytes: 104857601n },
    { plain_bytes: 209715201n },
    { revision_bytes: 209715201n },
    { sequence: 9223372036854775808n },
    { source_saved: false },
    { source_fully_verified: false },
    { target_commitment: b(1, 31) },
  ]) {
    assert.ok(
      "Err" in
        (
          await f.send(r.grant, {
            RestorePreflight: { ...r.preflight, ...change },
          })
        ).result,
    );
    assert.deepEqual(
      ok(await f.actor.get_vault_header(r.current.vault)),
      before,
    );
    assert.deepEqual(
      ok(await f.actor.restore_admission_status())[0].pipeline[0].preflight,
      [],
    );
  }
}
