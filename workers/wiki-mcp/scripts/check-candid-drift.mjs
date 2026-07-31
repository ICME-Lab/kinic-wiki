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
  ResultNodes: "Result_19"
};

const expectedTypes = {
  ...selectCandidShapes(sharedTypes, [
    "DatabaseRole",
    "DatabaseStatus",
    "DatabaseMetadata",
    "DatabaseSummary",
    "NodeKind",
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
    "ResultDatabases",
    "ResultSearch",
    "ResultNode",
    "ResultMemoryManifest",
    "ResultQueryContext",
    "ResultSourceEvidence",
    "ResultIndexSqlJsonQuery"
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
  ResultNodes: { kind: "variant", cases: { Ok: "vec NodeEntry", Err: "text" } }
};

const expectedMethods = {
  list_databases: { input: [], output: "ResultDatabases", mode: "query" },
  list_nodes: { input: ["ListNodesRequest"], output: "ResultNodes", mode: "query" },
  search_nodes: { input: ["SearchNodesRequest"], output: "ResultSearch", mode: "query" },
  memory_manifest: { input: ["DatabaseIdRequest"], output: "ResultMemoryManifest", mode: "query" },
  query_context: { input: ["QueryContextRequest"], output: "ResultQueryContext", mode: "query" },
  source_evidence: { input: ["SourceEvidenceRequest"], output: "ResultSourceEvidence", mode: "query" },
  query_database_sql_json: { input: ["text", "text", "nat32"], output: "ResultIndexSqlJsonQuery", mode: "query" },
  read_node: { input: ["text", "text"], output: "ResultNode", mode: "query" }
};

const failures = checkCandidSubset({ didSource: did, idlSource: idl, expectedTypes, expectedMethods, didTypeAliases });
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Wiki MCP Candid subset OK: ${Object.keys(expectedMethods).join(", ")}`);
