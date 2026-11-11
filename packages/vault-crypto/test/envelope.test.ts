import { describe, it, expect } from "vitest";
import {
  aad,
  seal,
  open,
  importKey,
  randomBytes,
  keyInput,
} from "../src/index.ts";
describe("vault envelope", () => {
  it("authenticates every identity field and rejects corruption", async () => {
    const key = await importKey(randomBytes(32)),
      v = new Uint8Array(16).fill(1),
      o = new Uint8Array(16).fill(2);
    const binding = aad(v, o, 1n, "chunk", 0);
    const e = await seal(
      key,
      new TextEncoder().encode("synthetic only"),
      binding,
    );
    expect(new TextDecoder().decode(await open(key, e, binding))).toBe(
      "synthetic only",
    );
    for (const bad of [
      aad(v, o, 2n, "chunk", 0),
      aad(v, o, 1n, "metadata", 0),
      aad(v, o, 1n, "chunk", 1),
      aad(v, new Uint8Array(16), 1n, "chunk", 0),
    ])
      await expect(open(key, e, bad)).rejects.toThrow();
    e.ciphertext[0] ^= 1;
    await expect(open(key, e, binding)).rejects.toThrow();
  });
  it("uses strict versions, sizes and uint64 boundaries", () => {
    expect(keyInput(new Uint8Array(16), 1n)).toHaveLength(24);
    expect(() => keyInput(new Uint8Array(15), 1n)).toThrow();
    expect(() => keyInput(new Uint8Array(16), -1n)).toThrow();
    expect(() => keyInput(new Uint8Array(16), 1n << 64n)).toThrow();
  });
});
it("matches the fixed WebCrypto/Rust vector", async () => {
  const { default: v } = await import("./vector.json");
  const b = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
  const key = await importKey(b(v.key));
  expect(
    Buffer.from(
      await open(
        key,
        { version: 1, nonce: b(v.nonce), ciphertext: b(v.ciphertext) },
        b(v.aad),
      ),
    ).toString("hex"),
  ).toBe(v.plaintext);
  expect(
    Buffer.from(
      aad(
        new Uint8Array(16).fill(1),
        new Uint8Array(16).fill(2),
        7n,
        "chunk",
        2,
      ),
    ).toString("hex"),
  ).toBe(v.aad);
});

it("rejects base64url aliases with nonzero trailing bits", async () => {
  const { unb64 } = await import("../src/documents.ts");
  expect(unb64("AA")).toEqual(new Uint8Array([0]));
  expect(() => unb64("AB")).toThrow("InvalidEncoding");
});
