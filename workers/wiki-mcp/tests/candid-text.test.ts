import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { IDL } from "@icp-sdk/core/candid";
const require = createRequire(import.meta.url);
const cjs = require("@icp-sdk/core/candid") as typeof import("@icp-sdk/core/candid");
const legacyRequire = createRequire(new URL("../../../packages/vfs-candid/package.json", import.meta.url));
const legacy = legacyRequire("@icp-sdk/core/candid") as typeof import("@icp-sdk/core/candid");
describe.each([["6.0 ESM", IDL], ["6.0 CommonJS", cjs.IDL], ["5.4 CommonJS", legacy.IDL]])("Candid Text fidelity (%s)", (_name, idl) => {
  it.each(["\uFEFF日本語\0😀", "\uFEFF\uFEFFdouble BOM", "ordinary", "", "inside\uFEFFBOM"])("preserves %j exactly", (text) => {
    expect(idl.decode([idl.Text], idl.encode([idl.Text], [text]))).toEqual([text]);
  });
  it("still rejects invalid UTF-8", () => {
    const bytes = new Uint8Array(idl.encode([idl.Text], ["x"]));
    bytes[bytes.length - 1] = 0xff;
    expect(() => idl.decode([idl.Text], bytes)).toThrow();
  });
});
