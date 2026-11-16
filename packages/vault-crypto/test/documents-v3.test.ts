import { describe, expect, it } from "vitest";
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
