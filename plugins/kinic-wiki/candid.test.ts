import test from "node:test";
import assert from "node:assert/strict";

import {
  localReplicaHost,
  normalizeCommitResponse,
  normalizePageType,
  normalizeStatus
} from "./candid";

test("normalizePageType maps candid variants to plugin strings", () => {
  assert.equal(normalizePageType({ Entity: null }), "entity");
  assert.equal(normalizePageType({ QueryNote: null }), "query_note");
});

test("normalizeStatus converts bigint counts to numbers", () => {
  const status = normalizeStatus({
    page_count: 1n,
    source_count: 0n,
    system_page_count: 2n
  });
  assert.deepEqual(status, {
    page_count: 1,
    source_count: 0,
    system_page_count: 2
  });
});

test("normalizeCommitResponse converts opt text and bigint manifest values", () => {
  const response = normalizeCommitResponse({
    Ok: {
      committed_pages: [],
      rejected_pages: [{
        page_id: "page_1",
        reason: "conflict",
        conflicting_section_paths: ["root"],
        local_changed_section_paths: ["root"],
        remote_changed_section_paths: ["root"],
        conflict_markdown: ["<<<<<<< LOCAL"]
      }],
      snapshot_revision: "snapshot_2",
      snapshot_was_stale: true,
      system_pages: [],
      manifest_delta: {
        upserted_pages: [{
          page_id: "page_1",
          slug: "alpha",
          revision_id: "rev_2",
          updated_at: 42n
        }],
        removed_page_ids: []
      }
    }
  });

  assert.equal(response.rejected_pages[0].conflict_markdown, "<<<<<<< LOCAL");
  assert.equal(response.manifest_delta.upserted_pages[0].updated_at, 42);
  assert.equal(response.snapshot_was_stale, true);
});

test("localReplicaHost detects localhost style hosts", () => {
  assert.equal(localReplicaHost("http://127.0.0.1:8000"), true);
  assert.equal(localReplicaHost("http://localhost:8000"), true);
  assert.equal(localReplicaHost("https://ic0.app"), false);
});
