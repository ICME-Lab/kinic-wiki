// Where: workers/wiki-generator/tests/jobs.test.ts
// What: Job idempotency tests.
// Why: Retries must not reprocess an unchanged completed source.
import assert from "node:assert/strict";
import test from "node:test";
import { shouldSkipJob } from "../src/jobs.js";
import type { SourceJob } from "../src/types.js";

const completedJob: SourceJob = {
  database_id: "db_1",
  source_path: "/Sources/raw/a/a.md",
  source_etag: "etag-1",
  status: "completed",
  target_path: "/Wiki/conversations/a.md",
  attempts: 1,
  last_error: null,
  updated_at: "2026-05-12T00:00:00.000Z"
};

test("same completed etag is skipped", () => {
  assert.equal(shouldSkipJob(completedJob, "etag-1"), true);
});

test("changed etag or failed status is not skipped", () => {
  assert.equal(shouldSkipJob(completedJob, "etag-2"), false);
  assert.equal(shouldSkipJob({ ...completedJob, status: "failed" }, "etag-1"), false);
});
