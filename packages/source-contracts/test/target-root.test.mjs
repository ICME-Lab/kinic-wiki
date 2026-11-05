import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../index.js";

test("generation folders normalize trailing slash and preserve Unicode", () => {
  assert.equal(contracts.normalizeKnowledgeTargetRoot(" /Knowledge/調査/web/// "), "/Knowledge/調査/web");
});
test("generation folders reject paths outside Knowledge and ambiguous segments", () => {
  for (const value of [undefined, "", "/Knowledge", "/Sources/web", "/Knowledge/../private", "/Knowledge/./web", "/Knowledge//web", "/Knowledge/web\\x", "/Knowledge/web\n", "/Knowledge/web?x"]) {
    assert.throws(() => contracts.normalizeKnowledgeTargetRoot(value));
  }
});
