import test from "node:test";
import assert from "node:assert/strict";

import {
  localReplicaHost,
  normalizeNodeKind,
  normalizeStatus,
  normalizeWriteNodeResult
} from "./candid";

test("normalizeNodeKind maps candid variants to plugin strings", () => {
  assert.equal(normalizeNodeKind({ File: null }), "file");
  assert.equal(normalizeNodeKind({ Source: null }), "source");
});

test("normalizeStatus converts bigint counts to numbers", () => {
  const status = normalizeStatus({
    file_count: 1n,
    source_count: 0n,
    deleted_count: 2n
  });
  assert.deepEqual(status, {
    file_count: 1,
    source_count: 0,
    deleted_count: 2
  });
});

test("normalizeWriteNodeResult converts node timestamps and opt values", () => {
  const result = normalizeWriteNodeResult({
    Ok: {
      created: false,
      node: {
        path: "/Wiki/foo.md",
        kind: { File: null },
        content: "# Foo",
        created_at: 1n,
        updated_at: 2n,
        etag: "etag-1",
        deleted_at: [],
        metadata_json: "{}"
      }
    }
  });

  assert.equal(result.node.kind, "file");
  assert.equal(result.node.updated_at, 2);
  assert.equal(result.node.deleted_at, null);
});

test("localReplicaHost detects localhost style hosts", () => {
  assert.equal(localReplicaHost("http://127.0.0.1:8000"), true);
  assert.equal(localReplicaHost("http://localhost:8000"), true);
  assert.equal(localReplicaHost("https://ic0.app"), false);
});
