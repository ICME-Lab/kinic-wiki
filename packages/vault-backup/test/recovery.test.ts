import { it, expect } from "vitest";
import {
  makeArchive,
  openArchive,
  type PortableHeader,
  type PortableRecord,
} from "../src/index.ts";
import {
  aad,
  deriveKey,
  importKey,
  randomBytes,
  seal,
} from "../../vault-crypto/src/index.ts";
import { b64, pack, encryptDocument } from "../../vault-crypto/src/documents.ts";
it("recovers offline and rejects wrong secret, missing records, truncation and tampering", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("NetworkForbidden");
  };
  try {
    const vault = randomBytes(16),
      object = randomBytes(16),
      raw = randomBytes(32),
      secret = randomBytes(32),
      root = await importKey(raw),
      epoch = 0n;
    const d = await encryptDocument(
      root,
      vault,
      object,
      1n,
      { kind: "note", title: "Synthetic fixture" },
      new TextEncoder().encode("synthetic body"),
    );
    const h: PortableHeader = {
      version: 1,
      vault: b64(vault),
      epoch: "0",
      sequence: "2",
      key_name: "test_key_1",
      record_count: 1,
      chunk_count: 1,
      plain_bytes: "14",
      normal: pack(
        await seal(
          await importKey(randomBytes(32)),
          raw,
          aad(vault, new Uint8Array(16), epoch, "normal"),
        ),
      ),
      recovery: pack(
        await seal(
          await deriveKey(secret, "recovery"),
          raw,
          aad(vault, new Uint8Array(16), epoch, "recovery"),
        ),
      ),
    };
    const r: PortableRecord = {
      vault: h.vault,
      object: b64(object),
      revision: "1",
      sequence: "2",
      plain_size: "14",
      manifest: b64(d.manifest),
      hashes: d.hashes.map(b64),
      deleted: false,
    };
    for (const invalid of ["01", "0x1", "9223372036854775808"]) {
      await expect(
        makeArchive(
          h,
          [{ ...r, revision: invalid }],
          async (_, i) => d.chunks[i],
          raw,
        ),
      ).rejects.toThrow();
    }
    await expect(
      makeArchive(
        { ...h, sequence: "9223372036854775808" },
        [r],
        async (_, i) => d.chunks[i],
        raw,
      ),
    ).rejects.toThrow();
    const archive = await makeArchive(h, [r], async (_, i) => d.chunks[i], raw);
    const opened = await openArchive(archive, secret);
    expect(opened.rootRaw).toEqual(raw);
    expect(opened.records).toEqual([r]);
    opened.rootRaw.fill(0);
    await expect(openArchive(archive, randomBytes(32))).rejects.toThrow();
    await expect(
      openArchive(archive.subarray(0, archive.length - 10), secret),
    ).rejects.toThrow();
    const bad = new Uint8Array(archive);
    bad[bad.length - 50] ^= 1;
    await expect(openArchive(bad, secret)).rejects.toThrow();
    await expect(
      makeArchive(h, [r, r], async (_, i) => d.chunks[i], raw),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = previous;
  }
});
