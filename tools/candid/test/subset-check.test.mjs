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

test("structured result aliases compare both Ok and Err types", () => {
  const didSource = `type MutationError = record { message : text };
type ResultFoo = variant { Ok : text; Err : MutationError };
service : () -> {
  foo : () -> (ResultFoo);
}`;
  const expectedTypes = {};
  const expectedMethods = {
    foo: { input: [], output: "ResultFoo", mode: "update" }
  };
  const idlResultAliases = {
    "text|MutationError": "ResultFoo"
  };
  const correctIdl = `export const idlFactory = ({ IDL: idl }) => {
  const MutationError = idl.Record({ message: idl.Text });
  return idl.Service({
    foo: idl.Func([], [idl.Variant({ Ok: idl.Text, Err: MutationError })], [])
  });
};`;

  assert.deepEqual(checkCandidSubset({
    didSource,
    idlSource: correctIdl,
    expectedTypes,
    expectedMethods,
    idlResultAliases
  }), []);

  const staleIdl = correctIdl.replace("Err: MutationError", "Err: idl.Text");
  assert.deepEqual(checkCandidSubset({
    didSource,
    idlSource: staleIdl,
    expectedTypes,
    expectedMethods,
    idlResultAliases
  }), ["hand-written IDL method foo output mismatch: Variant({ Ok: idl.Text, Err: idl.Text }) != ResultFoo"]);
});

test("normalizes aliases inside a vector of results", () => {
  assert.deepEqual(checkCandidSubset({
    didSource: `type Result_1 = variant { Ok : text; Err : text };
type Result_2 = variant { Ok : vec Result_1; Err : text };
service : () -> {\n}`,
    idlSource: `const ResultItem = idl.Variant({ Ok: idl.Text, Err: idl.Text });
const ResultBatch = idl.Variant({ Ok: idl.Vec(ResultItem), Err: idl.Text });`,
    didTypeAliases: { ResultItem: "Result_1", ResultBatch: "Result_2" },
    expectedTypes: {
      ResultItem: { kind: "variant", cases: { Ok: "text", Err: "text" } },
      ResultBatch: { kind: "variant", cases: { Ok: "vec ResultItem", Err: "text" } },
    }, expectedMethods: {},
  }), []);
});
