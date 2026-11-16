import { describe, expect, it, vi } from "vitest";
import { encryptDocumentV3, decryptDocumentV3 } from "../src/documents-v3.ts";
import { importKey } from "../src/index.ts";
const context = {
  canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  owner: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  vault: new Uint8Array(16).fill(1),
  nonce: new Uint8Array(32).fill(2),
  key_name: "test_key_1",
};
describe("v3 document encryption", () => {
  it("round trips content and rejects context swaps and old formats", async () => {
    const root = await importKey(new Uint8Array(32).fill(9));
    const object = new Uint8Array(16).fill(4);
    const doc = await encryptDocumentV3(
      root,
      context,
      object,
      1n,
      { kind: "credential", title: "example" },
      new TextEncoder().encode("secret"),
    );
    expect(JSON.parse(new TextDecoder().decode(doc.manifest)).version).toBe(3);
    const read = await decryptDocumentV3(
      root,
      context,
      object,
      1n,
      doc.manifest,
      doc.chunks,
      doc.hashes,
    );
    expect(new TextDecoder().decode(read.plaintext)).toBe("secret");
    await expect(
      decryptDocumentV3(
        root,
        { ...context, nonce: new Uint8Array(32).fill(3) },
        object,
        1n,
        doc.manifest,
        doc.chunks,
        doc.hashes,
      ),
    ).rejects.toThrow();
    const old = new TextEncoder().encode(
      JSON.stringify({
        ...JSON.parse(new TextDecoder().decode(doc.manifest)),
        version: 2,
      }),
    );
    await expect(
      decryptDocumentV3(root, context, object, 1n, old, doc.chunks, doc.hashes),
    ).rejects.toThrow();
  });
});
it("rejects tampered chunks and a different object or revision", async () => {
  const root = await importKey(new Uint8Array(32).fill(9));
  const object = new Uint8Array(16).fill(4);
  const doc = await encryptDocumentV3(
    root,
    context,
    object,
    2n,
    {
      kind: "attachment",
      title: "file",
      filename: "a.bin",
      mime: "application/octet-stream",
    },
    new Uint8Array([1, 2, 3]),
  );
  const damaged = doc.chunks.map((x) => new Uint8Array(x));
  damaged[0][0] ^= 1;
  await expect(
    decryptDocumentV3(
      root,
      context,
      object,
      2n,
      doc.manifest,
      damaged,
      doc.hashes,
    ),
  ).rejects.toThrow("CorruptChunk");
  await expect(
    decryptDocumentV3(
      root,
      context,
      new Uint8Array(16),
      2n,
      doc.manifest,
      doc.chunks,
      doc.hashes,
    ),
  ).rejects.toThrow();
  await expect(
    decryptDocumentV3(
      root,
      context,
      object,
      3n,
      doc.manifest,
      doc.chunks,
      doc.hashes,
    ),
  ).rejects.toThrow();
});

// Re-seal deliberately malformed authenticated payloads with real WebCrypto.
import { readManifestV3, pack, unpack, hash } from "../src/documents-v3.ts";
import { open, seal, utf8 } from "../src/index.ts";
import { documentAAD } from "../src/context.ts";
const object = new Uint8Array(16).fill(4);
async function fixture(length = 3) {
  const root = await importKey(new Uint8Array(32).fill(9));
  const doc = await encryptDocumentV3(
    root,
    context,
    object,
    1n,
    { kind: "attachment", title: "file" },
    new Uint8Array(length).fill(7),
  );
  return { root, doc };
}
async function replacePayload(
  root: CryptoKey,
  doc: Awaited<ReturnType<typeof encryptDocumentV3>>,
  payload: unknown,
) {
  const parsed = await readManifestV3(root, context, object, 1n, doc.manifest);
  const m = JSON.parse(new TextDecoder().decode(doc.manifest));
  m.metadata = pack(
    await seal(
      parsed.key,
      utf8.encode(JSON.stringify(payload)),
      documentAAD(context, object, 1n, "metadata"),
    ),
  );
  return utf8.encode(JSON.stringify(m));
}
it("rejects coordinated manifest, ciphertext and hash tail truncation", async () => {
  const { root, doc } = await fixture(1048577);
  const m = JSON.parse(new TextDecoder().decode(doc.manifest));
  m.nonces.pop();
  await expect(
    decryptDocumentV3(
      root,
      context,
      object,
      1n,
      utf8.encode(JSON.stringify(m)),
      doc.chunks.slice(0, 1),
      doc.hashes.slice(0, 1),
    ),
  ).rejects.toThrow();
});
it("authenticates document extent while preserving caller metadata", async () => {
  const { root, doc } = await fixture();
  const parsed = await readManifestV3(root, context, object, 1n, doc.manifest);
  const m = JSON.parse(new TextDecoder().decode(doc.manifest));
  const payload = JSON.parse(
    new TextDecoder().decode(
      await open(
        parsed.key,
        unpack(m.metadata),
        documentAAD(context, object, 1n, "metadata"),
      ),
    ),
  );
  expect(payload).toEqual({
    metadata: { kind: "attachment", title: "file" },
    plaintext_length: 3,
    chunk_count: 1,
  });
  expect(parsed.metadata).toEqual({ kind: "attachment", title: "file" });
});
it.each([
  {
    metadata: { kind: "attachment", title: "file" },
    plaintext_length: 4,
    chunk_count: 1,
  },
  {
    metadata: { kind: "attachment", title: "file" },
    plaintext_length: 3,
    chunk_count: 2,
  },
  {
    metadata: { kind: "attachment", title: "file" },
    plaintext_length: -1,
    chunk_count: 1,
  },
  {
    metadata: { kind: "attachment", title: "file" },
    plaintext_length: 1.5,
    chunk_count: 1,
  },
  {
    metadata: { kind: "attachment", title: "file" },
    plaintext_length: 10485761,
    chunk_count: 11,
  },
  {
    metadata: { kind: "note", title: "file" },
    plaintext_length: 262145,
    chunk_count: 1,
  },
  {
    metadata: { kind: "attachment", title: "x".repeat(513) },
    plaintext_length: 3,
    chunk_count: 1,
  },
  {
    metadata: { kind: "attachment", title: "file", filename: 1 },
    plaintext_length: 3,
    chunk_count: 1,
  },
  {
    metadata: { kind: "attachment", title: "file", mime: null },
    plaintext_length: 3,
    chunk_count: 1,
  },
  { kind: "attachment", title: "legacy" },
  null,
])("rejects malformed authenticated extent or metadata %#", async (payload) => {
  const { root, doc } = await fixture();
  const manifest = await replacePayload(root, doc, payload);
  await expect(
    decryptDocumentV3(
      root,
      context,
      object,
      1n,
      manifest,
      doc.chunks,
      doc.hashes,
    ),
  ).rejects.toThrow();
});
it.each([0, 1048576, 1048577, 10485760])(
  "round trips attachment extent %i including one empty chunk",
  async (length) => {
    const { root, doc } = await fixture(length);
    expect(doc.chunks.length).toBe(Math.max(1, Math.ceil(length / 1048576)));
    const result = await decryptDocumentV3(
      root,
      context,
      object,
      1n,
      doc.manifest,
      doc.chunks,
      doc.hashes,
    );
    expect(result.plaintext.length).toBe(length);
    expect(result.plaintext.every((x) => x === 7)).toBe(true);
  },
);
it.each([
  [{ kind: "note", title: "a" }, 262145],
  [{ kind: "credential", title: "a" }, 262145],
  [{ kind: "attachment", title: "a" }, 10485761],
  [{ kind: "note", title: "x".repeat(513) }, 0],
  [{ kind: "attachment", title: "a", filename: "x".repeat(8192) }, 0],
  [{ kind: "attachment", title: "a", mime: 3 }, 0],
] as const)(
  "rejects invalid writer metadata or size %#",
  async (metadata, length) => {
    const root = await importKey(new Uint8Array(32));
    await expect(
      encryptDocumentV3(
        root,
        context,
        object,
        1n,
        metadata as any,
        new Uint8Array(length),
      ),
    ).rejects.toThrow();
  },
);
it("rejects authenticated chunks whose actual final plaintext length is wrong", async () => {
  const { root, doc } = await fixture();
  const parsed = await readManifestV3(root, context, object, 1n, doc.manifest);
  const m = JSON.parse(new TextDecoder().decode(doc.manifest));
  const chunk = await seal(
    parsed.key,
    new Uint8Array([7, 7]),
    documentAAD(context, object, 1n, "chunk", 0),
  );
  m.nonces[0] = pack(chunk).nonce;
  await expect(
    decryptDocumentV3(
      root,
      context,
      object,
      1n,
      utf8.encode(JSON.stringify(m)),
      [chunk.ciphertext],
      [await hash(chunk.ciphertext)],
    ),
  ).rejects.toThrow();
});
it("wipes decrypted metadata and earlier chunks after a later chunk fails", async () => {
  const { root, doc } = await fixture(1048577);
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  const decrypted: ArrayBuffer[] = [];
  const spy = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      decrypted.push(result);
      return result;
    });
  try {
    const hashes = doc.hashes.map((x) => new Uint8Array(x));
    hashes[1][0] ^= 1;
    await expect(
      decryptDocumentV3(
        root,
        context,
        object,
        1n,
        doc.manifest,
        doc.chunks,
        hashes,
      ),
    ).rejects.toThrow("CorruptChunk");
    expect(decrypted).toHaveLength(3); // DEK, metadata, first plaintext chunk.
    expect(
      decrypted.every((buffer) => new Uint8Array(buffer).every((x) => x === 0)),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
