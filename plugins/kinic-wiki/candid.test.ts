import test from "node:test";
import assert from "node:assert/strict";

import { IDL } from "@dfinity/candid";

import {
  idlFactory,
  localReplicaHost,
  normalizeExportResponse,
  normalizeFetchResponse,
  normalizeGlobNodeHits,
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
    source_count: 0n
  });
  assert.deepEqual(status, {
    file_count: 1,
    source_count: 0
  });
});

test("normalizeWriteNodeResult converts node timestamps and opt values", () => {
  const result = normalizeWriteNodeResult({
    Ok: {
      created: false,
      node: {
        path: "/Wiki/foo.md",
        kind: { File: null },
        updated_at: 2n,
        etag: "etag-1"
      }
    }
  });

  assert.equal(result.node.kind, "file");
  assert.equal(result.node.updated_at, 2);
});

test("normalizeGlobNodeHits accepts the compact glob wire shape", () => {
  const hits = normalizeGlobNodeHits({
    Ok: [{
      path: "/Wiki/nested",
      kind: { Directory: null },
      has_children: true
    }, {
      path: "/Wiki/nested/file.md",
      kind: { File: null },
      has_children: false
    }]
  });

  assert.deepEqual(hits, [{
    path: "/Wiki/nested",
    kind: "directory",
    has_children: true
  }, {
    path: "/Wiki/nested/file.md",
    kind: "file",
    has_children: false
  }]);
});

test("sync normalizers convert paged cursor fields", () => {
  const snapshot = normalizeExportResponse({
    Ok: {
      snapshot_revision: "snap-1",
      snapshot_session_id: ["session-1"],
      nodes: [],
      next_cursor: ["/Wiki/page-099.md"]
    }
  });
  assert.equal(snapshot.next_cursor, "/Wiki/page-099.md");
  assert.equal(snapshot.snapshot_session_id, "session-1");

  const updates = normalizeFetchResponse({
    Ok: {
      snapshot_revision: "snap-2",
      changed_nodes: [],
      removed_paths: [],
      next_cursor: []
    }
  });
  assert.equal(updates.next_cursor, null);
});


test("localReplicaHost detects localhost style hosts", () => {
  assert.equal(localReplicaHost("http://127.0.0.1:8000"), true);
  assert.equal(localReplicaHost("http://localhost:8000"), true);
  assert.equal(localReplicaHost("https://ic0.app"), false);
});

test("plugin idlFactory uses mutation ack result shapes", () => {
  const service = idlFactory({ IDL });
  assert.ok(isServiceShape(service));

  const writeNode = service._fields.find(([name]) => name === "write_node")?.[1];
  assert.ok(writeNode);
  const resultShape = writeNode.retTypes.map((type) => type.display()).join("\n");
  assert.match(resultShape, /node:record/);
  assert.match(resultShape, /etag:text/);
  assert.match(resultShape, /kind:variant/);
  assert.match(resultShape, /path:text/);
  assert.match(resultShape, /updated_at:int64/);
  assert.doesNotMatch(resultShape, /content|metadata_json|created_at/);
});

function isServiceShape(input: unknown): input is {
  _fields: Array<[string, {
    argTypes: Array<{ display(): string }>;
    retTypes: Array<{ display(): string }>;
    annotations: string[];
  }]>;
} {
  if (typeof input !== "object" || input === null || !("_fields" in input)) {
    return false;
  }
  const fields = input._fields;
  if (!Array.isArray(fields)) {
    return false;
  }
  return fields.every((entry) =>
    Array.isArray(entry)
    && entry.length === 2
    && typeof entry[0] === "string"
    && isFunctionShape(entry[1])
  );
}

function isFunctionShape(input: unknown): input is {
  argTypes: Array<{ display(): string }>;
  retTypes: Array<{ display(): string }>;
  annotations: string[];
} {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  if (!("argTypes" in input) || !("retTypes" in input) || !("annotations" in input)) {
    return false;
  }
  return Array.isArray(input.argTypes)
    && input.argTypes.every(isDisplayType)
    && Array.isArray(input.retTypes)
    && input.retTypes.every(isDisplayType)
    && Array.isArray(input.annotations)
    && input.annotations.every((value) => typeof value === "string");
}

function isDisplayType(input: unknown): input is { display(): string } {
  return typeof input === "object"
    && input !== null
    && "display" in input
    && typeof input.display === "function";
}
