import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Principal } from "@icp-sdk/core/principal";
import { RestoreClient, sameRestoreGeneration } from "../src/restore";
import {
  restoreRecordCost,
  restorePreflight,
  restoreRevision,
  restoreReservation,
} from "../src/restore-cost";
import { cryptoGeneration, encodeIncidentKit } from "../src/incident";
import { portableRecord } from "../src/incident-backup";
import type { MutationOperation } from "../src/mutation-contracts";
import type {
  Generation,
  RestoreAdmissionStatus,
  VaultActor,
  Revision,
} from "../src/contracts";
import {
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  generationAAD,
  recoveryVerifier,
} from "../../vault-crypto/src/index";
import {
  encryptDocument,
  b64,
  unb64,
  hash,
  pack,
} from "../../vault-crypto/src/documents";
import {
  makeArchive,
  openArchive,
  type PortableHeader,
} from "../../vault-backup/src/index";
it("matches Rust charge and peak temporary-byte vectors without rounding large sequences", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL(
        "../../vault-backup/test/fixtures/restore-cost-vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const v of vectors) {
    const r = {
      ...v.record,
      revision: BigInt(v.record.revision),
      sequence: BigInt(v.record.sequence),
      plain_size: BigInt(v.record.plain_size),
    } as Revision;
    expect(restoreRecordCost(r)).toEqual({
      charge: BigInt(v.charge),
      pending: BigInt(v.pending),
    });
  }
});
async function fixture() {
  const g: Generation = {
    version: 2,
    canister: Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
    owner: Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"),
    vault: new Uint8Array(16).fill(3),
    epoch: 2n,
    nonce: randomBytes(32),
    key_name: "key_1",
  };
  const cg = cryptoGeneration(g),
    raw = randomBytes(32),
    secret = randomBytes(32),
    root = await importKey(raw),
    kek = await importKey(randomBytes(32));
  const d = await encryptDocument(
    root,
    cg.vault,
    new Uint8Array(16).fill(4),
    1n,
    { kind: "note", title: "history" },
    new TextEncoder().encode("history"),
    cg,
  );
  const recovery = await sealV2(
    await deriveKey(secret, "recovery"),
    raw,
    generationAAD(cg, new Uint8Array(16), cg.epoch, "recovery"),
  );
  const h: PortableHeader = {
    version: 2,
    vault: b64(cg.vault),
    epoch: "2",
    sequence: "7",
    key_name: g.key_name,
    generation: {
      ...cg,
      vault: b64(cg.vault),
      nonce: b64(cg.nonce),
      epoch: "2",
    },
    recovery_verifier: b64(await recoveryVerifier(secret)),
    record_count: 1,
    chunk_count: 1,
    plain_bytes: "7",
    normal: pack(recovery),
    recovery: pack(recovery),
  };
  const record = {
    vault: h.vault,
    object: b64(new Uint8Array(16).fill(4)),
    revision: "1",
    sequence: "7",
    plain_size: "7",
    manifest: b64(d.manifest),
    hashes: d.hashes.map(b64),
    deleted: false,
  };
  const archive = await makeArchive(h, [record], async () => d.chunks[0], raw),
    opened = await openArchive(archive, secret),
    next = { ...g, epoch: 3n, nonce: randomBytes(32) };
  const j = {
    request: {
      job: randomBytes(16),
      target: {
        namespace: randomBytes(32),
        vault: g.vault,
        attempt: randomBytes(16),
      },
      archive_digest: await hash(archive),
      source_commitment: opened.restoreRoot,
      source_epoch: 2n,
      source_generation: [g],
      archive_length: BigInt(archive.length),
      records: 1n,
      reserved_bytes: 0n,
    },
    current_live: [],
    pipeline: [
      {
        target: next,
        phase: { Allocated: null },
        normal: [],
        recovery: [],
        recovery_verifier: new Uint8Array(),
        envelope_digest: randomBytes(32),
        kit_ack: [],
        preflight: [],
        old_removed: false,
        discard_started: false,
        cleanup_cursor: 0n,
        backup_ack: [],
      },
    ],
  } as unknown as RestoreAdmissionStatus;
  opened.rootRaw.fill(0);
  raw.fill(0);
  const calls: MutationOperation[] = [],
    uploaded: Revision[] = [];
  let chunks: Uint8Array[] = [];
  const send = vi.fn(async (op: MutationOperation) => {
    calls.push(op);
    const p = j.pipeline[0]!;
    if ("RestoreStage" in op) {
      p.normal = [op.RestoreStage.normal];
      p.recovery = [op.RestoreStage.recovery];
      p.recovery_verifier = op.RestoreStage.recovery_verifier;
      p.phase = { EnvelopesStaged: null };
    }
    if ("RestoreConfirmKit" in op) {
      p.kit_ack = [op.RestoreConfirmKit.envelope_digest];
      p.phase = { KitConfirmed: null };
    }
    if ("RestorePreflight" in op) p.preflight = [op.RestorePreflight];
    if ("RestoreBeginImport" in op) p.phase = { Importing: null };
    if ("RestoreRecord" in op) uploaded.push(op.RestoreRecord);
    if ("RestoreChunk" in op) chunks.push(new Uint8Array(op.RestoreChunk.data));
    if ("RestoreConfirmBackup" in op) {
      p.backup_ack = [op.RestoreConfirmBackup];
      p.phase = { BackupVerified: null };
    }
    return { Unit: null };
  });
  const actor = {
    restore_admission_status: async () => ({ Ok: [j] }),
    restore_target_progress: async () => ({
      Ok: { count: 0n, sequence: 0n, root: new Uint8Array(32) },
    }),
    restore_target_index: async () => ({ Ok: { entries: uploaded, next: [] } }),
    restore_target_chunk: async () => ({ Ok: chunks[0] }),
    restore_target_descriptor: async () => {
      const p = j.pipeline[0]!,
        f = p.preflight[0]!;
      return {
        Ok: {
          commitment: f.target_commitment,
          descriptor_digest: new Uint8Array(32).fill(9),
          export: {
            id: j.request.target.attempt,
            vault: next.vault,
            sequence: 7n,
            expires: 9999999999n,
            state: "Restore",
            record_count: 1n,
            chunk_count: 1n,
            plain_bytes: 7n,
            header: {
              id: next.vault,
              epoch: 3n,
              generation: [next],
              normal: p.normal,
              recovery: p.recovery,
              recovery_verifier: p.recovery_verifier,
              state: { Restoring: null },
              sequence: 7n,
              backup_sequence: [],
              backup_at: [],
              key_name: next.key_name,
              published_slot: [],
            },
          },
        },
      };
    },
  } as unknown as VaultActor;
  const client = new RestoreClient(
    actor,
    g.owner,
    g.canister,
    "localhost",
    true,
  );
  Object.assign(client, { signer: { send, destroy: vi.fn() } });
  vi.spyOn(client, "deriveTarget").mockResolvedValue(kek);
  return { client, j, archive, secret, next, kek, send, calls, uploaded, d };
}
it("requires new kit and exact saved prepared backup, preserves encrypted content, verifies server backup before acknowledgment", async () => {
  const f = await fixture();
  let kit = new Uint8Array(),
    prepared = new Uint8Array();
  const bytes = await f.client.prepare(
    f.archive,
    f.secret,
    async (x) => {
      kit = x.slice();
    },
    async () => kit.slice(),
    async (x) => {
      prepared = x.slice();
    },
    async () => prepared.slice(),
  );
  expect(f.calls.map((x) => Object.keys(x)[0])).toEqual([
    "RestoreStage",
    "RestoreConfirmKit",
    "RestorePreflight",
  ]);
  const secret = unb64(JSON.parse(new TextDecoder().decode(kit)).secret),
    o = await openArchive(bytes, secret);
  expect(o.header.envelope_revision).toBe("0");
  expect(o.chunks[0][0]).toEqual(f.d.chunks[0]);
  expect(o.records[0].sequence).toBe("7");
  expect(o.records[0].manifest).not.toBe(b64(f.d.manifest));
  const cost = restorePreflight(f.j, o.records, o.restoreRoot, 7n);
  expect(restoreReservation(cost)).toBeGreaterThan(cost.revision_bytes);
  o.rootRaw.fill(0);
  await expect(
    f.client.importPrepared(
      f.archive,
      f.secret,
      prepared,
      encodeIncidentKit(f.next, randomBytes(32)),
    ),
  ).rejects.toThrow();
  expect(f.uploaded).toHaveLength(0);
  await f.client.importPrepared(f.archive, f.secret, prepared, kit);
  expect(f.uploaded.map(portableRecord)[0].hashes).toEqual(f.d.hashes.map(b64));
  const original = f.uploaded[0].manifest;
  f.uploaded[0].manifest = new TextEncoder().encode("{}");
  await expect(
    f.client.saveAndVerifyBackup(
      kit,
      async () => {},
      async () => prepared.slice(),
    ),
  ).rejects.toThrow("ServerContentMismatch");
  f.uploaded[0].manifest = original;
  // The original valid target backup can be reselected despite footer randomness/key ordering.
  await f.client.saveAndVerifyBackup(
    kit,
    async () => {},
    async () => prepared.slice(),
  );
  let saved = new Uint8Array();
  await f.client.saveAndVerifyBackup(
    kit,
    async (x) => {
      saved = x.slice();
    },
    async () => saved.slice(),
  );
  expect(f.calls.at(-1)).toHaveProperty("RestoreConfirmBackup");
  const verified = await openArchive(saved, secret);
  expect(verified.restoreRoot).toEqual(
    f.j.pipeline[0]!.preflight[0]!.target_commitment,
  );
  verified.rootRaw.fill(0);
  secret.fill(0);
  kit.fill(0);
});
it("rejects corrupt source before any staged mutation and locks out late kit acknowledgment", async () => {
  const f = await fixture(),
    bad = f.archive.slice();
  bad[bad.length - 1] ^= 1;
  await expect(
    f.client.prepare(
      bad,
      f.secret,
      async () => {},
      async () => new Uint8Array(),
      async () => {},
      async () => new Uint8Array(),
    ),
  ).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
  let kit = new Uint8Array();
  await expect(
    f.client.prepare(
      f.archive,
      f.secret,
      async (x) => {
        kit = x.slice();
        f.client.session.lock();
      },
      async () => kit,
      async () => {},
      async () => new Uint8Array(),
    ),
  ).rejects.toThrow("Locked");
  expect(f.calls.some((x) => "RestoreConfirmKit" in x)).toBe(false);
  expect(f.calls.some((x) => "RestorePreflight" in x)).toBe(false);
  kit.fill(0);
});
it("distinguishes same VaultID across complete generation identities", async () => {
  const f = await fixture();
  expect(sameRestoreGeneration(f.next, { ...f.next })).toBe(true);
  for (const changed of [
    { ...f.next, nonce: randomBytes(32) },
    { ...f.next, epoch: f.next.epoch + 1n },
    { ...f.next, owner: Principal.anonymous() },
    { ...f.next, key_name: "another" },
  ])
    expect(sameRestoreGeneration(f.next, changed)).toBe(false);
});
