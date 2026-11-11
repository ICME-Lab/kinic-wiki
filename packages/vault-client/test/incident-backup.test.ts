import { expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { saveAndVerify, portableRecord } from "../src/incident-backup";
import { encodeIncidentKit, cryptoGeneration } from "../src/incident";
import { Session } from "../src/session";
import {
  importKey,
  randomBytes,
  deriveKey,
  generationAAD,
  sealV2,
  recoveryVerifier,
} from "../../vault-crypto/src/index";
import {
  encryptDocument,
  b64,
  decryptDocument,
  rewrapManifest,
} from "../../vault-crypto/src/documents";
import {
  targetRestoreRoot,
  openArchive,
  rootEnvelopeRevision,
} from "../../vault-backup/src/index";
import type {
  IncidentTarget,
  IncidentStatus,
  Revision,
  StagedExport,
} from "../src/contracts";
it("staged archive reselect fully verifies new kit, footer, DEK, metadata and chunks before signed acknowledgment", async () => {
  const g = {
    version: 2,
    canister: Principal.selfAuthenticating(randomBytes(32)),
    owner: Principal.selfAuthenticating(randomBytes(32)),
    vault: randomBytes(16),
    nonce: randomBytes(32),
    epoch: 9n,
    key_name: "key_1",
  };
  const cg = cryptoGeneration(g),
    raw = randomBytes(32),
    secret = randomBytes(32),
    root = await importKey(raw),
    kek = await importKey(randomBytes(32));
  const normal = await sealV2(
    kek,
    raw,
    generationAAD(cg, new Uint8Array(16), 0n, "normal"),
  );
  const recovery = await sealV2(
    await deriveKey(secret, "recovery"),
    raw,
    generationAAD(cg, new Uint8Array(16), 0n, "recovery"),
  );
  // Object identity must match its cryptographic binding.
  const object = randomBytes(16),
    d = await encryptDocument(
      root,
      g.vault,
      object,
      1n,
      { kind: "note", title: "retained" },
      new TextEncoder().encode("history"),
      cg,
    );
  const record: Revision = {
    vault: g.vault,
    object,
    revision: 1n,
    sequence: 2n,
    plain_size: 7n,
    manifest: d.manifest,
    chunk_hashes: d.hashes,
    deleted: false,
  };
  const t = {
    target: [g],
    source: { id: g.vault },
    normal: [normal],
    recovery: [recovery],
    attempt: randomBytes(16),
    recovery_verifier: await recoveryVerifier(secret),
    staged_export: [],
  } as unknown as IncidentTarget;
  const descriptor = {
    export: {
      id: randomBytes(16),
      vault: g.vault,
      sequence: 3n,
      expires: 99999999999n,
      state: "Staged",
      record_count: 1n,
      chunk_count: 1n,
      plain_bytes: 7n,
      header: {
        id: g.vault,
        generation: [g],
        epoch: 9n,
        key_name: "key_1",
        normal: [normal],
        recovery: [recovery],
        recovery_verifier: t.recovery_verifier,
      },
    },
    descriptor_digest: randomBytes(32),
    commitment: await targetRestoreRoot(cg, [portableRecord(record)]),
  } as StagedExport;
  t.staged_export = [descriptor];
  const j = { job: randomBytes(16) } as IncidentStatus;
  for (const mode of [
    "good",
    "wrong-kit",
    "bad-footer",
    "truncated",
    "locked",
  ]) {
    const session = new Session(),
      send = vi.fn(async () => ({ Unit: null })),
      actor = {
        incident_status: async () => ({
          Ok: [
            { job: j.job, targets: [{ ...t, staged_export: [descriptor] }] },
          ],
        }),
        incident_staged_export: async () => ({ Ok: descriptor }),
        incident_staged_index: async () => ({
          Ok: { entries: [record], next: [] },
        }),
        incident_staged_chunk: async () => ({ Ok: d.chunks[0] }),
      };
    let saved: Uint8Array | undefined;
    const operation = saveAndVerify(
      actor as never,
      { send } as never,
      session,
      j,
      t,
      kek,
      async (a) => {
        saved = a.slice();
        if (mode === "locked") session.lock();
      },
      async () => {
        if (mode === "truncated") return saved!.slice(0, -1);
        if (mode === "bad-footer") {
          const bad = saved!.slice();
          bad[bad.length - 10] ^= 1;
          return bad;
        }
        return saved!.slice();
      },
      async () =>
        encodeIncidentKit(g, mode === "wrong-kit" ? randomBytes(32) : secret),
    );
    if (mode === "good") {
      await operation;
      expect(send.mock.calls.length).toBe(2);
      const changed = new Uint8Array(saved!);
      const marker = new TextEncoder().encode('"envelope_revision":"0"');
      const offset = Buffer.from(changed).indexOf(marker);
      expect(offset).toBeGreaterThan(0);
      changed[offset + marker.length - 2] = "9".charCodeAt(0);
      await expect(openArchive(changed, secret)).rejects.toThrow();
      const opened = await openArchive(saved!, secret);
      expect(opened.header.envelope_revision).toBe("0");
      expect(opened.header.sequence).toBe("3");
      expect(b64(opened.restoreRoot)).toBe(
        b64(descriptor.commitment as Uint8Array),
      );
      opened.rootRaw.fill(0);
    } else {
      await expect(operation).rejects.toThrow();
      expect(send.mock.calls.length).toBe(1);
    }
  }
  expect(rootEnvelopeRevision({ version: 2, epoch: "9" } as never)).toBe(9n);
  expect(
    rootEnvelopeRevision({
      version: 2,
      epoch: "9",
      envelope_revision: "0",
    } as never),
  ).toBe(0n);
  for (const value of ["00", "1", 9, null])
    expect(() =>
      rootEnvelopeRevision({
        version: 2,
        epoch: "9",
        envelope_revision: value,
      } as never),
    ).toThrow();
  expect(() =>
    rootEnvelopeRevision({
      version: 1,
      epoch: "0",
      envelope_revision: "0",
    } as never),
  ).toThrow();
});
it("new root opens retained history and old root cannot open future fresh DEKs", async () => {
  const old = await importKey(randomBytes(32)),
    newRoot = await importKey(randomBytes(32));
  const g = {
      version: 2 as const,
      canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      owner: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      vault: randomBytes(16),
      nonce: randomBytes(32),
      epoch: 4n,
      key_name: "key_1",
    },
    object = randomBytes(16);
  const d = await encryptDocument(
    old,
    g.vault,
    object,
    1n,
    { kind: "note", title: "old" },
    new TextEncoder().encode("old history"),
  );
  const wrapped = await rewrapManifest(
    old,
    newRoot,
    g.vault,
    object,
    1n,
    d.manifest,
    g,
  );
  expect(
    new TextDecoder().decode(
      (
        await decryptDocument(
          newRoot,
          g.vault,
          object,
          1n,
          wrapped,
          d.chunks,
          d.hashes,
          g,
        )
      ).plaintext,
    ),
  ).toBe("old history");
  const future = await encryptDocument(
    newRoot,
    g.vault,
    object,
    2n,
    { kind: "note", title: "future" },
    new TextEncoder().encode("future"),
    g,
  );
  await expect(
    decryptDocument(
      old,
      g.vault,
      object,
      2n,
      future.manifest,
      future.chunks,
      future.hashes,
      g,
    ),
  ).rejects.toThrow();
});
