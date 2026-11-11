import { expect, it, vi } from "vitest";
import { register, assertCredential } from "../src/webauthn";
vi.mock("../src/webauthn", () => ({
  register: vi.fn(),
  assertCredential: vi.fn(),
}));
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
  return {
    client,
    actor,
    j,
    archive,
    secret,
    next,
    kek,
    send,
    calls,
    uploaded,
    d,
  };
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
  expect(restoreReservation(cost)).toBe(cost.revision_bytes + 4096n);
  expect(cost.peak_pending_bytes).toBeGreaterThan(0n);
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

it("reuses the exact existing key without registration and still requires the independent current kit", async () => {
  const f = await fixture(),
    credential = new Uint8Array([41]);
  const ch = {
    bytes: randomBytes(32),
    expires: 9999999999n,
    registration: false,
    credential_ids: [credential],
  };
  const begin = vi.fn(async (request) => {
    f.j.request = request;
    return { Ok: ch };
  });
  const prove = vi.fn(async () => ({
    Ok: { ...f.j, current_live: [f.next], recovery_message: randomBytes(80) },
  }));
  const current = vi.fn(
    async (_job: Uint8Array | number[], _signature: Uint8Array | number[]) => ({
      Ok: f.j,
    }),
  );
  Object.assign(f.actor, {
    begin_restore_admission: begin,
    prove_restore_candidate: prove,
    prove_restore_current: current,
    register_restore_candidate: vi.fn(),
  });
  vi.mocked(assertCredential).mockResolvedValue("fresh-uv");
  vi.mocked(register).mockClear();
  const saved = vi.fn(async () => {});
  await expect(
    f.client.admit(
      randomBytes(32),
      f.archive,
      f.secret,
      saved,
      undefined,
      credential,
    ),
  ).rejects.toThrow("CurrentLiveKitRequired");
  expect(begin.mock.calls[0][0].candidate_mode).toEqual([
    { ExistingInstances: credential },
  ]);
  expect(saved).toHaveBeenCalledWith(f.archive);
  expect(assertCredential).toHaveBeenCalledWith(
    ch,
    "localhost",
    expect.any(AbortSignal),
  );
  expect(register).not.toHaveBeenCalled();
  expect(f.actor.register_restore_candidate).not.toHaveBeenCalled();
  expect(current).not.toHaveBeenCalled();
  await f.client.admit(
    randomBytes(32),
    f.archive,
    f.secret,
    saved,
    randomBytes(32),
    credential,
  );
  expect(current).toHaveBeenCalledOnce();
  expect(current.mock.calls[0][1]).toHaveLength(64);
});
it("rejects substituted existing credential challenge before possession", async () => {
  const f = await fixture();
  Object.assign(f.actor, {
    begin_restore_admission: async () => ({
      Ok: {
        bytes: randomBytes(32),
        expires: 9999999999n,
        registration: false,
        credential_ids: [new Uint8Array([42])],
      },
    }),
  });
  vi.mocked(assertCredential).mockClear();
  await expect(
    f.client.admit(
      randomBytes(32),
      f.archive,
      f.secret,
      async () => {},
      undefined,
      new Uint8Array([41]),
    ),
  ).rejects.toThrow("RestoreCandidateChanged");
  expect(assertCredential).not.toHaveBeenCalled();
});

it("rejects noncanonical tombstones before reserving their flat restore charge", () => {
  const canonical: Revision = {
    vault: new Uint8Array(16),
    object: new Uint8Array(16),
    revision: 1n,
    sequence: 1n,
    plain_size: 0n,
    manifest: new Uint8Array(),
    chunk_hashes: [],
    deleted: true,
  };
  expect(restoreRecordCost(canonical).charge).toBe(4096n);
  for (const change of [
    { plain_size: 1n },
    { manifest: new Uint8Array([1]) },
    { chunk_hashes: [new Uint8Array(32)] },
  ])
    expect(() => restoreRecordCost({ ...canonical, ...change })).toThrow(
      "InvalidBackup",
    );
});

it.each(["before-confirm", "before-preflight", "after-preflight"])(
  "resumes saved randomized target files after %s without staging new roots",
  async (point) => {
    const f = await fixture();
    let kit = new Uint8Array(),
      prepared = new Uint8Array();
    const send = f.send;
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (op) => {
      if (point === "before-confirm" && "RestoreConfirmKit" in op)
        throw Error("interrupted");
      if (point === "before-preflight" && "RestorePreflight" in op)
        throw Error("interrupted");
      const result = await implementation(op);
      if (point === "after-preflight" && "RestorePreflight" in op)
        throw Error("interrupted");
      return result;
    });
    await expect(
      f.client.prepare(
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
      ),
    ).rejects.toThrow("interrupted");
    const envelopes = JSON.stringify(f.j.pipeline[0]!.normal);
    send.mockImplementation(implementation);
    f.calls.length = 0;
    await f.client.resumePrepared(f.archive, f.secret, prepared, kit);
    expect(f.j.pipeline[0]!.preflight).toHaveLength(1);
    expect(JSON.stringify(f.j.pipeline[0]!.normal)).toBe(envelopes);
    expect(f.calls.some((x) => "RestoreStage" in x)).toBe(false);
    expect(f.calls.filter((x) => "RestoreConfirmKit" in x)).toHaveLength(
      point === "before-confirm" ? 1 : 0,
    );
    expect(f.calls.filter((x) => "RestorePreflight" in x)).toHaveLength(
      point === "after-preflight" ? 0 : 1,
    );
  },
);

it.each(["missing", "persisted", "existing", "lock"])(
  "resumes %s admission registration with fresh possession and no extra physical key",
  async (mode) => {
    const f = await fixture(),
      id = new Uint8Array([41]);
    const fresh = {
      bytes: randomBytes(32),
      expires: 9999999999n,
      registration: false,
      credential_ids: [id],
    };
    if (mode === "existing")
      f.j.request.candidate_mode = [{ ExistingInstances: id }];
    const reg = vi.fn(async () => ({ Ok: fresh }));
    Object.assign(f.actor, {
      resume_restore_admission: async () => ({
        Ok: { ...fresh, registration: mode === "missing" || mode === "lock" },
      }),
      register_restore_candidate: reg,
      prove_restore_candidate: async () => ({ Ok: f.j }),
    });
    vi.mocked(register)
      .mockReset()
      .mockImplementation(async () => {
        if (mode === "lock") f.client.session.lock();
        return "new-public-registration";
      });
    vi.mocked(assertCredential).mockReset().mockResolvedValue("fresh-uv");
    if (mode === "lock")
      await expect(f.client.resume(f.archive, f.secret)).rejects.toThrow(
        "Locked",
      );
    else await f.client.resume(f.archive, f.secret);
    expect(register).toHaveBeenCalledTimes(
      mode === "missing" || mode === "lock" ? 1 : 0,
    );
    expect(reg).toHaveBeenCalledTimes(mode === "missing" ? 1 : 0);
    expect(assertCredential).toHaveBeenCalledTimes(mode === "lock" ? 0 : 1);
  },
);

it.each(["source", "target", "kit", "header", "preflight", "lock"])(
  "saved prepared resume rejects %s mismatch without confirmation or import",
  async (mode) => {
    const f = await fixture();
    let kit = new Uint8Array(),
      prepared = new Uint8Array();
    await f.client.prepare(
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
    f.calls.length = 0;
    const source = f.archive.slice();
    if (mode === "source") source[source.length - 1] ^= 1;
    if (mode === "target")
      f.j.pipeline[0]!.target = { ...f.next, nonce: randomBytes(32) };
    if (mode === "kit") kit = encodeIncidentKit(f.next, randomBytes(32));
    if (mode === "header") {
      const secret = unb64(JSON.parse(new TextDecoder().decode(kit)).secret),
        o = await openArchive(prepared, secret);
      prepared = await makeArchive(
        { ...o.header, sequence: "8" },
        o.records,
        async (r, i) => o.chunks[o.records.indexOf(r)][i],
        o.rootRaw,
      );
      o.rootRaw.fill(0);
      secret.fill(0);
    }
    if (mode === "preflight") f.j.pipeline[0]!.preflight[0]!.sequence = 8n;
    if (mode === "lock")
      vi.mocked(f.client.deriveTarget).mockImplementation(async () => {
        f.client.session.lock();
        return f.kek;
      });
    await expect(
      f.client.resumePrepared(source, f.secret, prepared, kit),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
it("existing scoped admission refuses a substituted registration challenge without enrolling another key", async () => {
  const f = await fixture();
  f.j.request.candidate_mode = [{ ExistingInstances: new Uint8Array([41]) }];
  Object.assign(f.actor, {
    resume_restore_admission: async () => ({
      Ok: {
        bytes: randomBytes(32),
        expires: 9999999999n,
        registration: true,
        credential_ids: [new Uint8Array([42])],
      },
    }),
  });
  vi.mocked(register).mockClear();
  vi.mocked(assertCredential).mockClear();
  await expect(f.client.resume(f.archive, f.secret)).rejects.toThrow(
    "RestoreCandidateChanged",
  );
  expect(register).not.toHaveBeenCalled();
  expect(assertCredential).not.toHaveBeenCalled();
});
