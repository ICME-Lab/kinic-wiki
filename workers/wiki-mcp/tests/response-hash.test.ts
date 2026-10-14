import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const legacyRequire = createRequire(new URL("../../../packages/vfs-candid/package.json", import.meta.url));
const legacy = legacyRequire(legacyRequire.resolve("@icp-sdk/core/agent").replace(/index\.js$/, "request_id.js"));
const agentPath = require.resolve("@icp-sdk/core/agent");
const cjs = require(agentPath.replace(/index\.js$/, "request_id.js"));
const esm = await import(pathToFileURL(agentPath.replace("/lib/cjs/", "/lib/esm/").replace(/index\.js$/, "request_id.js")).href);

describe.each([["ESM", esm], ["CommonJS", cjs]])("native SDK hashing (%s)", (_name, sdk) => {
  it.each([0, 16_383, 16_384, 1_000_000])("matches the independent JS SDK at %i bytes", async length => {
    const buffer = new Uint8Array(length + 32);
    for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
    const arg = buffer.subarray(16, 16 + length);
    const response = { status: "replied", reply: { arg }, timestamp: 1_234_567_890n, request_id: new Uint8Array(32), absent: undefined };
    expect(sdk.hashOfMap(response)).toEqual(legacy.hashOfMap(response));
    expect(sdk.hashValue(arg)).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", arg)));
  });

  it("preserves map ordering, arrays and synchronous request-ID hashing", () => {
    const arg = new Uint8Array(32_000).fill(255);
    const values = { arg, numbers: [0, 127, 128, -1n], label: "\uFEFF日本語\0😀" };
    // Negative integers are rejected by both implementations' LEB encoder.
    expect(() => sdk.hashOfMap(values)).toThrow();
    values.numbers.pop();
    expect(sdk.hashOfMap(values)).toEqual(legacy.hashOfMap(values));
    expect(sdk.requestIdOf({ label: values.label, numbers: values.numbers, arg })).toEqual(legacy.requestIdOf(values));
    expect(sdk.hashValue(new DataView(arg.buffer, 8, 20_000))).toEqual(legacy.hashValue(new DataView(arg.buffer, 8, 20_000)));
  });

  it("hashes the entire body including bytes beyond the displayed prefix", () => {
    const arg = new Uint8Array(1_000_000).fill(97);
    const original = sdk.hashOfMap({ reply: { arg } });
    arg[arg.length - 1] ^= 1;
    expect(sdk.hashOfMap({ reply: { arg } })).not.toEqual(original);
    expect(sdk.hashOfMap({ reply: { arg } })).toEqual(legacy.hashOfMap({ reply: { arg } }));
  });
});

// The query transport can release its input only while the pinned CBOR decoder
// returns owned byte strings. This fails if a dependency upgrade changes that.
const esmAgent = await import("@icp-sdk/core/agent");
const cjsAgent = require("@icp-sdk/core/agent");
describe.each([["ESM", esmAgent.Cbor], ["CommonJS", cjsAgent.Cbor]])("CBOR buffer ownership (%s)", (_name, cbor) => {
  it("keeps decoded reply bytes, signatures and nested fields after releasing the input", () => {
    for (let i = 0; i < 2; i++) {
      const original = { status: "replied", reply: { arg: new Uint8Array(1_000_000).fill(97 + i) },
        signatures: [{ timestamp: 123456789123456789n, signature: Uint8Array.of(1, 2, 3), identity: Uint8Array.of(4, 5) }] };
      const wire = cbor.encode(original);
      const decoded = cbor.decode(wire);
      const buffer = wire.buffer as ArrayBuffer & { transfer: (length: number) => ArrayBuffer };
      buffer.transfer(0);
      expect(buffer.byteLength).toBe(0);
      // Node compares typed-array bytes directly; Vitest's recursive comparison
      // of these megabyte arrays can exceed its timeout on shared CI runners.
      assert.deepStrictEqual(decoded, original);
    }
  });
});
