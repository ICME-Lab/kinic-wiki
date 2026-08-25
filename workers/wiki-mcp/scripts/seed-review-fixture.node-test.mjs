import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompleteInventory,
  exactNodeContent,
  fixtureWritePlan,
  missingReviewFolders
} from "./seed-review-fixture.mjs";
import { REVIEW_FILES } from "./review-fixture.mjs";

function readResult(content) {
  const fixture = REVIEW_FILES.find((candidate) => candidate.content === content) ?? REVIEW_FILES[0];
  return {
    content: [{ type: "text", text: `Path: /Knowledge/review/example.md\nTitle: example\nContent:\n${content}` }],
    structuredContent: { metadata: { etag: "etag", metadata_json: fixture.metadata_json } }
  };
}

function missingResult() {
  return { content: [{ type: "text", text: JSON.stringify({ error: "node not found" }) }], isError: true };
}

test("finds only missing review folders in parent-first order", () => {
  assert.deepEqual(
    missingReviewFolders([{ path: "/Knowledge" }, { path: "/Knowledge/review" }]),
    ["/OpenAIReview", "/OpenAIReview/scratch"]
  );
});

test("accepts only a complete non-truncated inventory", () => {
  const entries = [{ path: "/Knowledge" }];
  assert.equal(assertCompleteInventory({
    structuredContent: { entries, metadata: { truncated: false } }
  }), entries);
  assert.throws(() => assertCompleteInventory({
    structuredContent: { entries, metadata: { truncated: true } }
  }), /truncated/u);
});

test("extracts exact model-facing node content", () => {
  assert.equal(exactNodeContent(readResult("fixture content")), "fixture content");
});

test("creates only missing fixture files", () => {
  const plan = fixtureWritePlan([readResult(REVIEW_FILES[0].content), missingResult()]);
  assert.deepEqual(plan.map((node) => node.path), [REVIEW_FILES[1].path]);
});

test("accepts matching fixture content and metadata without rewrites", () => {
  assert.deepEqual(
    fixtureWritePlan(REVIEW_FILES.map((fixture) => readResult(fixture.content))),
    []
  );
});

test("refuses to overwrite unexpected fixture content", () => {
  assert.throws(
    () => fixtureWritePlan([readResult("unexpected"), readResult(REVIEW_FILES[1].content)]),
    /Refusing to overwrite/u
  );
});

test("refuses to accept unexpected fixture metadata", () => {
  const first = readResult(REVIEW_FILES[0].content);
  first.structuredContent.metadata.metadata_json = JSON.stringify({ title: "unexpected" });
  assert.throws(
    () => fixtureWritePlan([first, readResult(REVIEW_FILES[1].content)]),
    /unexpected fixture metadata/u
  );
});
