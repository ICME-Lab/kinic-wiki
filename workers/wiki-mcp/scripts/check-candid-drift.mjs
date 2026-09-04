// Where: workers/wiki-mcp/scripts/check-candid-drift.mjs
// What: Compare the MCP Worker's inline VFS IDL subset with vfs.did.
// Why: wiki-mcp was the only TS canister client without a drift check in CI.
import { readFileSync } from "node:fs";
import { checkCandidSubset, selectCandidShapes } from "@kinic/candid-tools/subset-check";
import {
  didTypeAliases as sharedAliases,
  expectedTypes as sharedTypes
} from "@kinic/candid-tools/shapes";

const did = readFileSync(new URL("../../../crates/vfs_canister/vfs.did", import.meta.url), "utf8");
const idl = readFileSync(new URL("../src/vfs.ts", import.meta.url), "utf8");

const didTypeAliases = {
  ...sharedAliases,
  ResultNodes: "Result_20",
  ResultWriteNodes: "Result_46",
  ResultEditNode: "Result_6",
  ResultMutationBatch: "Result_33",
  ResultNodePublication: "Result_34",
  ResultCyclesPurchase: "Result_13",
  ResultQueryContext: "Result_35",
  ResultIndexSqlJsonQuery: "Result_36",
  ResultNode: "Result_37",
  ResultNodeContext: "Result_38",
  ResultPublicNode: "Result_39",
  ResultSearch: "Result_40",
  ResultStorageBillingBatch: "Result_41",
  ResultSourceEvidence: "Result_42",
  ResultDatabaseMetadata: "Result_43",
  ResultWikiMetrics: "Result_44",
  ResultWikiMetricsSeries: "Result_45",
  ResultWriteSourceForGeneration: "Result_47"
};

const expectedTypes = {
  ...selectCandidShapes(sharedTypes, [
    "DatabaseRole",
    "DatabaseStatus",
    "DatabaseMetadata",
    "DatabaseSummary",
    "NodeKind",
    "NodeMutationErrorCode",
    "NodeMutationError",
    "NodeEntryKind",
    "Node",
    "LinkEdge",
    "NodeContext",
    "SearchPreviewField",
    "SearchPreviewMode",
    "SearchPreview",
    "SearchNodeHit",
    "SearchNodesRequest",
    "SourceEvidenceRef",
    "SourceEvidence",
    "MemoryRoot",
    "MemoryCapability",
    "CanonicalRole",
    "MemoryManifest",
    "QueryContext",
    "QueryContextRequest",
    "DatabaseIdRequest",
    "SourceEvidenceRequest",
    "IndexSqlJsonQueryResult",
    "WriteNodeRequest",
    "WriteNodeItem",
    "WriteNodesRequest",
    "WriteNodeResult",
    "DeleteNodeRequest",
    "DeleteNodeResult",
    "MkdirNodeRequest",
    "MkdirNodeResult",
    "MoveNodeRequest",
    "MoveNodeResult",
    "NodeMutationAck",
    "ResultDatabases",
    "ResultSearch",
    "ResultNode",
    "ResultMemoryManifest",
    "ResultQueryContext",
    "ResultSourceEvidence",
    "ResultIndexSqlJsonQuery",
    "ResultWriteNode",
    "ResultWriteNodes",
    "ResultDeleteNode",
    "ResultMkdirNode",
    "ResultMoveNode"
  ]),
  NodeEntry: {
    kind: "record",
    fields: {
      updated_at: "int64",
      etag: "text",
      kind: "NodeEntryKind",
      path: "text",
      has_children: "bool"
    }
  },
  ListNodesRequest: {
    kind: "record",
    fields: {
      recursive: "bool",
      limit: "nat32",
      database_id: "text",
      prefix: "text"
    }
  },
  ResultNodes: { kind: "variant", cases: { Ok: "vec NodeEntry", Err: "text" } },
  AppendNodeItem: {
    kind: "record",
    fields: {
      content: "text", separator: "opt text", kind: "opt NodeKind", path: "text",
      expected_etag: "opt text", metadata_json: "opt text"
    }
  },
  AppendNodeRequest: {
    kind: "record",
    fields: {
      content: "text", separator: "opt text", kind: "opt NodeKind", path: "text",
      expected_etag: "opt text", metadata_json: "opt text", database_id: "text"
    }
  },
  EditNodeItem: {
    kind: "record",
    fields: {
      path: "text", old_text: "text", replace_all: "bool", expected_etag: "opt text", new_text: "text"
    }
  },
  EditNodeRequest: {
    kind: "record",
    fields: {
      path: "text", old_text: "text", replace_all: "bool", expected_etag: "opt text",
      new_text: "text", database_id: "text"
    }
  },
  EditNodeResult: { kind: "record", fields: { node: "NodeMutationAck", replacement_count: "nat32" } },
  MultiEdit: { kind: "record", fields: { old_text: "text", new_text: "text" } },
  MultiEditNodeItem: {
    kind: "record",
    fields: { path: "text", edits: "vec MultiEdit", expected_etag: "opt text" }
  },
  MultiEditNodeRequest: {
    kind: "record",
    fields: { path: "text", edits: "vec MultiEdit", expected_etag: "opt text", database_id: "text" }
  },
  MoveNodeItem: {
    kind: "record",
    fields: { from_path: "text", to_path: "text", expected_etag: "opt text", expected_target_etag: "opt text", overwrite: "bool" }
  },
  DeleteNodeItem: {
    kind: "record",
    fields: { path: "text", expected_etag: "opt text", expected_folder_index_etag: "opt text" }
  },
  NodeMutation: {
    kind: "variant",
    cases: {
      MultiEdit: "MultiEditNodeItem", Edit: "EditNodeItem", Move: "MoveNodeItem", Write: "WriteNodeItem",
      Mkdir: "text", Delete: "DeleteNodeItem", Append: "AppendNodeItem"
    }
  },
  MutateNodesBatchRequest: {
    kind: "record",
    fields: { operations: "vec NodeMutation", database_id: "text" }
  },
  NodeMutationResult: {
    kind: "variant",
    cases: {
      MultiEdit: "EditNodeResult", Edit: "EditNodeResult", Move: "MoveNodeResult", Write: "WriteNodeResult",
      Mkdir: "MkdirNodeResult", Delete: "DeleteNodeResult", Append: "WriteNodeResult"
    }
  },
  ResultEditNode: { kind: "variant", cases: { Ok: "EditNodeResult", Err: "NodeMutationError" } },
  ResultMutationBatch: { kind: "variant", cases: { Ok: "vec NodeMutationResult", Err: "NodeMutationError" } }
};

const expectedMethods = {
  list_databases: { input: [], output: "ResultDatabases", mode: "query" },
  list_nodes: { input: ["ListNodesRequest"], output: "ResultNodes", mode: "query" },
  search_nodes: { input: ["SearchNodesRequest"], output: "ResultSearch", mode: "query" },
  memory_manifest: { input: ["DatabaseIdRequest"], output: "ResultMemoryManifest", mode: "query" },
  query_context: { input: ["QueryContextRequest"], output: "ResultQueryContext", mode: "query" },
  source_evidence: { input: ["SourceEvidenceRequest"], output: "ResultSourceEvidence", mode: "query" },
  query_database_sql_json: { input: ["text", "text", "nat32"], output: "ResultIndexSqlJsonQuery", mode: "query" },
  read_node: { input: ["text", "text"], output: "ResultNode", mode: "query" },
  write_node: { input: ["WriteNodeRequest"], output: "ResultWriteNode", mode: "update" },
  write_nodes: { input: ["WriteNodesRequest"], output: "ResultWriteNodes", mode: "update" },
  append_node: { input: ["AppendNodeRequest"], output: "ResultWriteNode", mode: "update" },
  edit_node: { input: ["EditNodeRequest"], output: "ResultEditNode", mode: "update" },
  multi_edit_node: { input: ["MultiEditNodeRequest"], output: "ResultEditNode", mode: "update" },
  mkdir_node: { input: ["MkdirNodeRequest"], output: "ResultMkdirNode", mode: "update" },
  move_node: { input: ["MoveNodeRequest"], output: "ResultMoveNode", mode: "update" },
  delete_node: { input: ["DeleteNodeRequest"], output: "ResultDeleteNode", mode: "update" },
  mutate_nodes_batch: { input: ["MutateNodesBatchRequest"], output: "ResultMutationBatch", mode: "update" }
};

const failures = checkCandidSubset({ didSource: did, idlSource: idl, expectedTypes, expectedMethods, didTypeAliases });
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Wiki MCP Candid subset OK: ${Object.keys(expectedMethods).join(", ")}`);
