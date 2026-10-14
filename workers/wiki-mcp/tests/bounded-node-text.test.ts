import { describe, expect, it, vi } from "vitest";
import { IDL, PipeArrayBuffer, lebEncode } from "@icp-sdk/core/candid";
import { boundedNodeText } from "../src/bounded-node-text.js";
import { clipText } from "../src/text.js";

const type = boundedNodeText(IDL.Text);
const decode = (text: string) => IDL.decode([type], IDL.encode([IDL.Text], [text]))[0] as string;
function textPipe(bytes: Uint8Array, declaredLength = bytes.length) {
  const length = lebEncode(declaredLength);
  const message = new Uint8Array(length.length + bytes.length);
  message.set(length); message.set(bytes, length.length);
  return new PipeArrayBuffer(message);
}

describe("bounded MCP Candid node text", () => {
  it.each(["", "\uFEFF日本語\0😀", "a".repeat(39_999), "a".repeat(40_000),
    "a".repeat(40_001), "😀".repeat(20_001), "日".repeat(40_000) + "😀abc", "日".repeat(40_001) + "😀x", "a".repeat(16_383) + "😀\uFEFF日本語",
    "\uFEFF" + "😀日本語\0 ".repeat(70_000)])("preserves the existing visible body and truncation decision (%#)", original => {
    const result = decode(original);
    expect(result.length).toBeLessThanOrEqual(40_002);
    expect(clipText(result, 40_000)).toBe(clipText(original, 40_000));
    expect(result.length > 40_000).toBe(original.length > 40_000);
    if (original.length <= 40_000) expect(result).toBe(original);
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("keeps the wire type, encoding and adjacent fields unchanged", () => {
    const normal = IDL.Record({ content: IDL.Text, etag: IDL.Text });
    const bounded = IDL.Record({ content: type, etag: IDL.Text });
    const value = { content: "日本語😀".repeat(80_000), etag: "etag-after-body" };
    const bytes = IDL.encode([normal], [value]);
    expect(IDL.encode([bounded], [value])).toEqual(bytes);
    expect(IDL.decode([bounded], bytes)).toEqual([{ content: decode(value.content), etag: value.etag }]);
    expect(IDL.Text.decodeValue).not.toBe(type.decodeValue);
  });

  it("does not copy the full text bytes or materialize the full string", () => {
    const pipe = textPipe(new Uint8Array(1_000_000).fill(97));
    const read = vi.spyOn(pipe, "read");
    Object.defineProperty(pipe, "buffer", { get() { throw new Error("full buffer copy"); } });
    expect(type.decodeValue(pipe, IDL.Text)).toBe("a".repeat(40_001));
    expect(pipe.byteLength).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([16_383, 60_000, 99_999])("rejects invalid UTF-8 even in the discarded tail at byte %i", offset => {
    const bytes = new Uint8Array(100_000).fill(97); bytes[offset] = 255;
    expect(() => type.decodeValue(textPipe(bytes), IDL.Text)).toThrow();
  });

  it.each([[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]])(
    "rejects noncanonical UTF-8 or invalid Unicode scalars in the omitted tail (%j)", (...invalid) => {
      const bytes = new Uint8Array(200_000).fill(97); bytes.set(invalid, 150_000);
      expect(() => type.decodeValue(textPipe(bytes), IDL.Text)).toThrow();
    }
  );

  it("rejects truncated UTF-8, incomplete fields and wrong wire types", () => {
    const bytes = new Uint8Array(100_000).fill(97); bytes[bytes.length - 1] = 0xf0;
    expect(() => type.decodeValue(textPipe(bytes), IDL.Text)).toThrow();
    expect(() => type.decodeValue(textPipe(Uint8Array.of(97), 100_000), IDL.Text)).toThrow("unexpected end of buffer");
    expect(() => IDL.decode([type], IDL.encode([IDL.Nat], [0n]))).toThrow();
  });
});
