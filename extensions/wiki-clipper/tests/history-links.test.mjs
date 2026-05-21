// Where: extensions/wiki-clipper/tests/history-links.test.mjs
// What: Unit tests for recent export limit normalization.
// Why: Direct API export must keep user-supplied counts bounded.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExportLimit } from "../src/history-links.js";

test("normalizeExportLimit clamps invalid and overlarge input", () => {
  assert.equal(normalizeExportLimit(""), 10);
  assert.equal(normalizeExportLimit("-5"), 1);
  assert.equal(normalizeExportLimit("0"), 1);
  assert.equal(normalizeExportLimit("500"), 100);
  assert.equal(normalizeExportLimit("17"), 17);
});
