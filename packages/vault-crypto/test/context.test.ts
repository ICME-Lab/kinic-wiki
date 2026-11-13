import { describe, expect, it } from "vitest";
import { contextInput, copyVaultContext, documentAAD } from "../src/context.ts";

const context = () => ({
  canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  owner: "2vxsx-fae",
  vault: new Uint8Array(16).fill(2),
  nonce: new Uint8Array(32).fill(3),
  key_name: "test_key_1",
});

describe("II-only context", () => {
  it("rejects anonymous owner", () =>
    expect(() => contextInput(context())).toThrow());
  it("encodes backend length-prefixed fields and snapshots mutable bytes", () => {
    const input = { ...context(), owner: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
    const saved = copyVaultContext(input);
    const before = contextInput(saved);
    input.vault[0] = 9;
    input.nonce[0] = 9;
    expect(contextInput(saved)).toEqual(before);
    expect(contextInput(input)).not.toEqual(before);
    expect(Buffer.from(before).toString("hex")).toContain(
      "00000010" + "02".repeat(16) + "00000020" + "03".repeat(32),
    );
  });
  it("binds AAD to the entire context and use", () => {
    const c = { ...context(), owner: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
    const id = new Uint8Array(16);
    const aad = documentAAD(c, id, 1n, "chunk", 0);
    expect(
      documentAAD(
        { ...c, nonce: new Uint8Array(32).fill(4) },
        id,
        1n,
        "chunk",
        0,
      ),
    ).not.toEqual(aad);
    expect(documentAAD(c, id, 1n, "metadata", 0)).not.toEqual(aad);
    expect(documentAAD(c, id, 1n, "chunk", 1)).not.toEqual(aad);
  });
});
it("uses the exact published v3 input and AAD vectors", () => {
  const c = { ...context(), owner: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
  expect(Buffer.from(contextInput(c)).toString("hex")).toBe(
    "0000000a000000000000000101010000000a0000000000000001010100000010020202020202020202020202020202020000002003030303030303030303030303030303030303030303030303030303030303030000000a746573745f6b65795f31",
  );
  expect(
    Buffer.from(
      documentAAD(c, new Uint8Array(16).fill(4), 1n, "chunk", 0),
    ).toString("hex"),
  ).toBe(
    "000000176b696e69632d7661756c742f646f63756d656e742f7633000000620000000a000000000000000101010000000a0000000000000001010100000010020202020202020202020202020202020000002003030303030303030303030303030303030303030303030303030303030303030000000a746573745f6b65795f310000001004040404040404040404040404040404000000080000000000000001000000056368756e6b0000000400000000",
  );
});
it("rejects an unanchored header and altered key input before decrypting", async () => {
  const { verifiedRoot } = await import("../src/context.ts");
  const { TransportSecretKey } = await import("../src/index.ts");
  const c = { ...context(), owner: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
  await expect(
    verifiedRoot(
      c,
      new Uint8Array(96),
      {
        input: contextInput(c),
        public_key: new Uint8Array(96),
        encrypted_key: new Uint8Array(192),
      },
      TransportSecretKey.random(),
      true,
    ),
  ).rejects.toThrow("InvalidKeyContext");
});
