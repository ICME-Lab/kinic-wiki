import { test, expect } from "vitest";
import {
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  generationAAD,
  recoveryVerifier,
  type Generation,
} from "../../vault-crypto/src/index.ts";
import {
  encryptDocument,
  pack,
  b64,
  rewrapManifest,
} from "../../vault-crypto/src/documents.ts";
import {
  makeArchive,
  openArchive,
  restoreRoot,
  type PortableHeader,
} from "../src/index.ts";
test("v2 portable recovery verifies transformed wrapper, keeps ciphertext and changes target commitment", async () => {
  const g: Generation = {
    version: 2,
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    owner: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    vault: new Uint8Array(16).fill(3),
    epoch: 1n,
    nonce: randomBytes(32),
    key_name: "key_1",
  };
  const raw = randomBytes(32),
    root = await importKey(raw),
    secret = randomBytes(32),
    object = new Uint8Array(16).fill(4);
  const d = await encryptDocument(
    root,
    g.vault,
    object,
    1n,
    { kind: "note", title: "v2" },
    new TextEncoder().encode("history"),
    g,
  );
  const recovery = await sealV2(
    await deriveKey(secret, "recovery"),
    raw,
    generationAAD(g, new Uint8Array(16), g.epoch, "recovery"),
  );
  const h = {
    version: 2,
    vault: b64(g.vault),
    epoch: "1",
    sequence: "1",
    key_name: g.key_name,
    generation: { ...g, vault: b64(g.vault), nonce: b64(g.nonce), epoch: "1" },
    recovery_verifier: b64(await recoveryVerifier(secret)),
    record_count: 1,
    chunk_count: 1,
    plain_bytes: "7",
    normal: pack(recovery),
    recovery: pack(recovery),
  } as PortableHeader;
  const records = [
    {
      vault: h.vault,
      object: b64(object),
      revision: "1",
      sequence: "1",
      plain_size: "7",
      manifest: b64(d.manifest),
      hashes: d.hashes.map(b64),
      deleted: false,
    },
  ];
  const archive = await makeArchive(h, records, async () => d.chunks[0], raw);
  expect(new TextDecoder().decode(archive.subarray(0, 8))).toBe("KVLT0002");
  const opened = await openArchive(archive, secret);
  expect(opened.records).toEqual(records);
  const next = { ...g, epoch: 2n, nonce: randomBytes(32) },
    nextRoot = await importKey(randomBytes(32));
  const transformed = await rewrapManifest(
    root,
    nextRoot,
    g.vault,
    object,
    1n,
    d.manifest,
    next,
    g,
  );
  expect(
    await restoreRoot([{ ...records[0], manifest: b64(transformed) }]),
  ).not.toEqual(await restoreRoot(records));
  await expect(openArchive(archive, randomBytes(32))).rejects.toThrow();
  opened.rootRaw.fill(0);
  raw.fill(0);
});

test("review: empty and tombstone-only transformed archives bind a distinct target identity", async () => {
  const { aad, seal } = await import("../../vault-crypto/src/index.ts");
  const { transformArchive } = await import("../src/index.ts");
  for (const tombstone of [false, true]) {
    const vault = randomBytes(16),
      raw = randomBytes(32),
      secret = randomBytes(32),
      root = await importKey(raw);
    const e = pack(
      await seal(
        await deriveKey(secret, "recovery"),
        raw,
        aad(vault, new Uint8Array(16), 0n, "recovery"),
      ),
    );
    const h: PortableHeader = {
      version: 1,
      vault: b64(vault),
      epoch: "0",
      sequence: tombstone ? "1" : "0",
      key_name: "key_1",
      record_count: tombstone ? 1 : 0,
      chunk_count: 0,
      plain_bytes: "0",
      normal: e,
      recovery: e,
    };
    const records = tombstone
      ? [
          {
            vault: h.vault,
            object: b64(randomBytes(16)),
            revision: "1",
            sequence: "1",
            plain_size: "0",
            manifest: "",
            hashes: [],
            deleted: true,
          },
        ]
      : [];
    const source = await makeArchive(
      h,
      records,
      async () => {
        throw Error("UnexpectedChunk");
      },
      raw,
    );
    const generation: Generation = {
      version: 2,
      canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      owner: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      vault,
      epoch: 1n,
      nonce: randomBytes(32),
      key_name: "key_1",
    };
    const a = await transformArchive(source, secret, generation, root);
    const b = await transformArchive(
      source,
      secret,
      { ...generation, nonce: randomBytes(32) },
      root,
    );
    expect(a.targetRestoreRoot).not.toEqual(a.sourceRestoreRoot);
    expect(a.targetRestoreRoot).not.toEqual(b.targetRestoreRoot);
    for (const t of [a, b]) {
      t.rootRaw.fill(0);
      t.recoverySecret.fill(0);
    }
    raw.fill(0);
    secret.fill(0);
  }
});

test("restore from an older archive uses the separate current live epoch and preserves encrypted records", async () => {
  const { transformArchive } = await import("../src/index.ts");
  const source: Generation = {
    version: 2,
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    owner: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    vault: randomBytes(16),
    epoch: 2n,
    nonce: randomBytes(32),
    key_name: "key_1",
  };
  const raw = randomBytes(32),
    secret = randomBytes(32),
    root = await importKey(raw);
  const object = randomBytes(16);
  const doc = await encryptDocument(
    root,
    source.vault,
    object,
    3n,
    { kind: "note", title: "old snapshot" },
    new TextEncoder().encode("retained"),
    source,
  );
  const recovery = pack(
    await sealV2(
      await deriveKey(secret, "recovery"),
      raw,
      generationAAD(source, new Uint8Array(16), 2n, "recovery"),
    ),
  );
  const header: PortableHeader = {
    version: 2,
    vault: b64(source.vault),
    epoch: "2",
    sequence: "7",
    key_name: "key_1",
    generation: {
      ...source,
      vault: b64(source.vault),
      nonce: b64(source.nonce),
      epoch: "2",
    },
    recovery_verifier: b64(await recoveryVerifier(secret)),
    record_count: 1,
    chunk_count: 1,
    plain_bytes: "8",
    normal: recovery,
    recovery,
  };
  const records = [
    {
      vault: header.vault,
      object: b64(object),
      revision: "3",
      sequence: "7",
      plain_size: "8",
      manifest: b64(doc.manifest),
      hashes: doc.hashes.map(b64),
      deleted: false,
    },
  ];
  const archive = await makeArchive(
    header,
    records,
    async () => doc.chunks[0],
    raw,
  );
  const live = {
    ...source,
    owner: source.canister,
    canister: source.owner,
    epoch: 9n,
    nonce: randomBytes(32),
  };
  const target = { ...live, epoch: 10n, nonce: randomBytes(32) };
  const kek = await importKey(randomBytes(32));
  const restored = await transformArchive(archive, secret, target, kek, live);
  try {
    expect(restored.header.epoch).toBe("10");
    expect(restored.header.envelope_revision).toBe("0");
    expect(restored.records[0]).toEqual({
      ...records[0],
      manifest: expect.any(String),
    });
    expect(restored.records[0].manifest).not.toBe(records[0].manifest);
    expect(restored.chunks[0]).toEqual(doc.chunks);
    expect(restored.targetRestoreRoot).not.toEqual(restored.sourceRestoreRoot);
    const opened = await openArchive(restored.archive, restored.recoverySecret);
    opened.rootRaw.fill(0);
    await expect(openArchive(restored.archive, secret)).rejects.toThrow();
    for (const invalid of [
      { ...target, epoch: 3n },
      { ...target, epoch: 11n },
      { ...target, nonce: live.nonce },
      { ...target, owner: source.owner },
    ])
      await expect(
        transformArchive(archive, secret, invalid, kek, live),
      ).rejects.toThrow("InvalidTarget");
    await expect(
      transformArchive(
        archive,
        secret,
        { ...target, epoch: 9223372036854775808n },
        kek,
        { ...live, epoch: 9223372036854775807n },
      ),
    ).rejects.toThrow("InvalidTarget");
  } finally {
    restored.rootRaw.fill(0);
    restored.recoverySecret.fill(0);
    raw.fill(0);
    secret.fill(0);
  }
});
