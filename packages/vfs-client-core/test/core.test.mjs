import assert from "node:assert/strict";
import test from "node:test";
import {
  candidOptional,
  isLocalReplicaHost,
  unwrapCandidResult,
  variantName
} from "../index.js";

test("unwrapCandidResult preserves values and delegates error construction", () => {
  assert.equal(unwrapCandidResult({ Ok: 3 }), 3);
  assert.throws(
    () => unwrapCandidResult({ Err: "denied" }, (message) => new TypeError(message)),
    TypeError
  );
  assert.throws(() => unwrapCandidResult({}), /invalid Candid result/);
});

test("candidOptional preserves falsey values other than nullish absence", () => {
  assert.deepEqual(candidOptional(null), []);
  assert.deepEqual(candidOptional(undefined), []);
  assert.deepEqual(candidOptional(""), [""]);
  assert.deepEqual(candidOptional(0), [0]);
});

test("variantName returns only the Candid variant tag", () => {
  assert.equal(variantName({ Active: null }), "Active");
  assert.equal(variantName({}), undefined);
  assert.equal(variantName(null), undefined);
});

test("isLocalReplicaHost requires an exact parsed loopback hostname", () => {
  for (const value of [
    "http://localhost:8000",
    "https://id.ai.localhost",
    "http://127.0.0.1:8000",
    "http://[::1]:8000",
    "http://0.0.0.0:8000"
  ]) {
    assert.equal(isLocalReplicaHost(value), true, value);
  }
  for (const value of [
    "localhost:8000",
    "https://localhost.evil.test",
    "https://example.com/?next=127.0.0.1"
  ]) {
    assert.equal(isLocalReplicaHost(value), false, value);
  }
});
