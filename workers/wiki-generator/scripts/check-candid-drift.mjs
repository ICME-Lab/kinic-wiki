// Where: workers/wiki-generator/scripts/check-candid-drift.mjs
// What: Compare the generator Worker's hand-written VFS IDL subset with vfs.did.
// Why: Worker canister calls use a local minimal IDL that must drift-fail in CI.
import { readFileSync } from "node:fs";
import { checkCandidSubset } from "../../../scripts/candid-subset-check.mjs";
import { didTypeAliases as sharedAliases } from "../../../wikibrowser/scripts/candid-shapes.mjs";

const did = readFileSync(new URL("../../../crates/vfs_canister/vfs.did", import.meta.url), "utf8");
const idl = readFileSync(new URL("../src/vfs-idl.ts", import.meta.url), "utf8");

const didTypeAliases = {
  ...sharedAliases,
  ResultExportSnapshot: "Result_7",
  ResultFetchUpdates: "Result_8"
};

const expectedTypes = {
  NodeKind: { kind: "variant", cases: { File: "null", Source: "null", Folder: "null" } },
  Node: {
    kind: "record",
    fields: {
      path: "text",
      kind: "NodeKind",
      content: "text",
      created_at: "int64",
      updated_at: "int64",
      etag: "text",
      metadata_json: "text"
    }
  },
  NodeMutationAck: {
    kind: "record",
    fields: { updated_at: "int64", etag: "text", kind: "NodeKind", path: "text" }
  },
  SearchPreviewField: { kind: "variant", cases: { Path: "null", Content: "null" } },
  SearchPreviewMode: { kind: "variant", cases: { Light: "null", ContentStart: "null", None: "null" } },
  SearchPreview: {
    kind: "record",
    fields: {
      field: "SearchPreviewField",
      char_offset: "nat32",
      match_reason: "text",
      excerpt: "opt text"
    }
  },
  SearchNodeHit: {
    kind: "record",
    fields: {
      path: "text",
      kind: "NodeKind",
      snippet: "opt text",
      preview: "opt SearchPreview",
      score: "float32",
      match_reasons: "vec text"
    }
  },
  WriteNodeRequest: {
    kind: "record",
    fields: {
      content: "text",
      kind: "NodeKind",
      path: "text",
      expected_etag: "opt text",
      metadata_json: "text",
      database_id: "text"
    }
  },
  MkdirNodeRequest: { kind: "record", fields: { path: "text", database_id: "text" } },
  SearchNodesRequest: {
    kind: "record",
    fields: {
      database_id: "text",
      query_text: "text",
      prefix: "opt text",
      top_k: "nat32",
      preview_mode: "opt SearchPreviewMode"
    }
  },
  ExportSnapshotRequest: {
    kind: "record",
    fields: {
      snapshot_revision: "opt text",
      cursor: "opt text",
      limit: "nat32",
      database_id: "text",
      prefix: "opt text",
      snapshot_session_id: "opt text"
    }
  },
  ExportSnapshotResponse: {
    kind: "record",
    fields: {
      snapshot_revision: "text",
      nodes: "vec Node",
      next_cursor: "opt text",
      snapshot_session_id: "opt text"
    }
  },
  FetchUpdatesRequest: {
    kind: "record",
    fields: {
      known_snapshot_revision: "text",
      cursor: "opt text",
      limit: "nat32",
      database_id: "text",
      prefix: "opt text",
      target_snapshot_revision: "opt text"
    }
  },
  FetchUpdatesResponse: {
    kind: "record",
    fields: {
      removed_paths: "vec text",
      snapshot_revision: "text",
      changed_nodes: "vec Node",
      next_cursor: "opt text"
    }
  },
  SourceCaptureTriggerSessionCheckRequest: {
    kind: "record",
    fields: { database_id: "text", request_path: "text", session_nonce: "text" }
  },
  SourceRunSessionCheckRequest: {
    kind: "record",
    fields: {
      source_path: "text",
      source_etag: "text",
      session_nonce: "text",
      database_id: "text"
    }
  },
  WriteNodeResult: { kind: "record", fields: { created: "bool", node: "NodeMutationAck" } },
  MkdirNodeResult: { kind: "record", fields: { created: "bool", path: "text" } },
  ResultNode: { kind: "variant", cases: { Ok: "opt Node", Err: "text" } },
  ResultSearch: { kind: "variant", cases: { Ok: "vec SearchNodeHit", Err: "text" } },
  ResultWriteNode: { kind: "variant", cases: { Ok: "WriteNodeResult", Err: "text" } },
  ResultMkdirNode: { kind: "variant", cases: { Ok: "MkdirNodeResult", Err: "text" } },
  ResultExportSnapshot: { kind: "variant", cases: { Ok: "ExportSnapshotResponse", Err: "text" } },
  ResultFetchUpdates: { kind: "variant", cases: { Ok: "FetchUpdatesResponse", Err: "text" } },
  ResultUnit: { kind: "variant", cases: { Ok: "null", Err: "text" } }
};

const expectedMethods = {
  check_database_write_cycles: { input: ["text"], output: "ResultUnit", mode: "query" },
  check_source_run_session: { input: ["SourceRunSessionCheckRequest"], output: "ResultUnit", mode: "query" },
  check_source_capture_trigger_session: { input: ["SourceCaptureTriggerSessionCheckRequest"], output: "ResultUnit", mode: "query" },
  read_node: { input: ["text", "text"], output: "ResultNode", mode: "query" },
  mkdir_node: { input: ["MkdirNodeRequest"], output: "ResultMkdirNode", mode: "update" },
  write_node: { input: ["WriteNodeRequest"], output: "ResultWriteNode", mode: "update" },
  search_nodes: { input: ["SearchNodesRequest"], output: "ResultSearch", mode: "query" },
  export_snapshot: { input: ["ExportSnapshotRequest"], output: "ResultExportSnapshot", mode: "query" },
  fetch_updates: { input: ["FetchUpdatesRequest"], output: "ResultFetchUpdates", mode: "query" }
};

const failures = checkCandidSubset({ didSource: did, idlSource: idl, expectedTypes, expectedMethods, didTypeAliases });
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Wiki generator Candid subset OK: ${Object.keys(expectedMethods).join(", ")}`);
