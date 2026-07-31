import assert from "node:assert/strict";
import test from "node:test";
import { checkCandidSubset } from "../subset-check.mjs";

test("rejectUnexpectedMethods detects a zero-result IDL method", () => {
  const failures = checkCandidSubset({
    didSource: "service : () -> {\n}",
    idlSource: `export const idlFactory = ({ IDL: idl }) => {
  return idl.Service({
    noop: idl.Func([], [], [])
  });
};`,
    expectedTypes: {},
    expectedMethods: {},
    rejectUnexpectedMethods: true
  });

  assert.deepEqual(failures, ["unexpected hand-written IDL method: noop"]);
});
