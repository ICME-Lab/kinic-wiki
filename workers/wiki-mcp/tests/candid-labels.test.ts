import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as esm from "@icp-sdk/core/candid";

const require = createRequire(import.meta.url);
const legacyRequire = createRequire(new URL("../../../packages/vfs-candid/package.json", import.meta.url));
const implementations: [string, typeof esm][] = [
  ["6.0 ESM", esm], ["6.0 CommonJS", require("@icp-sdk/core/candid")],
  ["5.4 CommonJS", legacyRequire("@icp-sdk/core/candid")]
];

// Independent, deliberately uncached reference to the Candid label rules.
function reference(label: string): number {
  if (/^_\d+_$/.test(label) || /^_0x[0-9a-fA-F]+_$/.test(label)) {
    const value = Number(label.slice(1, -1));
    if (Number.isSafeInteger(value) && value >= 0 && value < 2 ** 32) return value;
  }
  return new TextEncoder().encode(label).reduce((hash, byte) => (hash * 223 + byte) % 2 ** 32, 0);
}

describe.each(implementations)("Candid label compatibility (%s)", (_name, candid) => {
  it("preserves numeric labels, UTF-8, malformed surrogates and long labels across repeated calls", () => {
    const labels = ["", "path", "__proto__", "content", "\0", "\uFEFF日本語😀", "\ud800", "a\udc00b",
      "_0_", "_00001_", "_0xff_", "_4294967295_", "_4294967296_", "_9007199254740993_", "_0x100000000_",
      "x".repeat(129), "😀".repeat(200), ...Array.from({ length: 2048 }, (_, i) => `field_${i}_日本語`)];
    for (const label of [...labels, ...labels.slice().reverse(), ...labels]) {
      expect(candid.idlLabelToId(label)).toBe(reference(label));
    }
  });

  it("encodes the same record bytes as independently numbered fields", () => {
    const { IDL } = candid;
    const labels = ["path", "rerank_excerpt", "日本語", "\uFEFF", "😀", "_0xFF_"];
    const named = IDL.Record(Object.fromEntries(labels.map(name => [name, IDL.Text])));
    const numbered = IDL.Record(Object.fromEntries(labels.map(name => [`_${reference(name)}_`, IDL.Text])));
    const value = Object.fromEntries(labels.map(name => [name, `\uFEFF${name}\0😀`]));
    const numericValue = Object.fromEntries(labels.map(name => [`_${reference(name)}_`, value[name]]));
    const bytes = IDL.encode([named], [value]);
    expect(bytes).toEqual(IDL.encode([numbered], [numericValue]));
    expect(IDL.decode([named], bytes)).toEqual([value]);
  });
});

describe.each(implementations)("Candid signed integer compatibility (%s)", (_name, candid) => {
  it("decodes signed boundaries, large integers and noncanonical sign extensions", () => {
    const values = [0n, 1n, -1n, 63n, 64n, -64n, -65n, 127n, 128n, -128n,
      2n ** 64n - 1n, -(2n ** 64n), 2n ** 200n, -(2n ** 200n)];
    for (const value of values) {
      const encoded = candid.slebEncode(value);
      const pipe = new candid.PipeArrayBuffer(encoded);
      expect(candid.slebDecode(pipe)).toBe(value);
      expect(pipe.byteLength).toBe(0);
      const extended = Uint8Array.from([...encoded.slice(0, -1), encoded.at(-1)! | 128, value < 0 ? 127 : 0]);
      expect(candid.slebDecode(new candid.PipeArrayBuffer(extended))).toBe(value);
      expect(candid.IDL.decode([candid.IDL.Int], candid.IDL.encode([candid.IDL.Int], [value]))).toEqual([value]);
    }
    expect(candid.slebDecode(new candid.PipeArrayBuffer(Uint8Array.of(0x9b, 0xf1, 0x59)))).toBe(-624485n);
  });

  it("reads an integer without copying or consuming its large trailing payload", () => {
    const data = new Uint8Array(1_000_000).fill(127);
    const pipe = new candid.PipeArrayBuffer(data);
    // Accessing this getter materializes the whole remaining payload. Integer
    // decoding must not depend on it, even for one-byte type-table entries.
    Object.defineProperty(pipe, "buffer", { get() { throw new Error("bulk copy"); } });
    expect(candid.slebDecode(pipe)).toBe(-1n);
    expect(pipe.byteLength).toBe(data.length - 1);
    expect(pipe.readUint8()).toBe(127);
  });

  it("rejects unterminated integers and preserves the checkpoint", () => {
    for (const data of [[], [128], [255, 128, 128]]) {
      const pipe = new candid.PipeArrayBuffer(Uint8Array.from(data));
      expect(() => candid.slebDecode(pipe)).toThrow("unexpected end of buffer");
      expect([...pipe.buffer]).toEqual(data);
    }
  });
});
