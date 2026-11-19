import assert from "node:assert/strict";
import test from "node:test";
import { validateDeployment } from "./shared-payment-preflight.mjs";
import { Principal } from "@icp-sdk/core/principal";

const ledger = Principal.fromUint8Array(Uint8Array.of(1));
const other = Principal.fromUint8Array(Uint8Array.of(2));
const expected = { wasmSha256: "01".repeat(32), ids: {ledger:ledger.toText()} };
const wiki = {Ok:{kinic_ledger_canister_id:ledger.toText()}};
const vault = {Ok:[{ledger}]};
test("checks both decoded ledger fields and the installed module", () => {
  const result = validateDeployment(expected, expected.wasmSha256, wiki, vault);
  assert.equal(result.liveModuleHash, expected.wasmSha256);
  assert.equal(result.wikiLedger, ledger.toText());
  assert.equal(result.vaultLedger, ledger.toText());
});
test("rejects wrong installed module independently of ledger configuration", () => {
  assert.throws(()=>validateDeployment(expected, "ab".repeat(32), wiki, vault));
});
test("ignores matching principal in the wrong config field on each canister", () => {
  assert.throws(()=>validateDeployment(expected, expected.wasmSha256, {Ok:{kinic_ledger_canister_id:other.toText(),authority:ledger.toText()}}, vault));
  assert.throws(()=>validateDeployment(expected, expected.wasmSha256, wiki, {Ok:[{ledger:other,recipient:ledger}]}));
});
test("requires successful configured replies", () => {
  assert.throws(()=>validateDeployment(expected, expected.wasmSha256, {Err:ledger.toText()}, vault));
  assert.throws(()=>validateDeployment(expected, expected.wasmSha256, wiki, {Ok:[]}));
});
