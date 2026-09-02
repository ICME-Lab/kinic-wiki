// Where: extensions/wiki-clipper/scripts/check-candid-drift.mjs
// What: Compare the extension's hand-written VFS IDL subset with vfs.did.
// Why: Extension writes use a minimal IDL that can silently drift from canister Candid.
import { readFileSync } from "node:fs";
import {
  didTypeAliases,
  expectedMethods as sharedMethods,
  expectedTypes as sharedTypes
} from "@kinic/candid-tools/shapes";
import { checkCandidSubset, selectCandidShapes } from "@kinic/candid-tools/subset-check";

const did = readFileSync(new URL("../../../crates/vfs_canister/vfs.did", import.meta.url), "utf8");
const actor = readFileSync(new URL("../src/vfs-actor.js", import.meta.url), "utf8");

const expectedTypes = selectCandidShapes(sharedTypes, [
  "DatabaseRole",
  "DatabaseStatus",
  "DatabaseMetadata",
  "DatabaseSummary",
  "CyclesBillingConfig",
  "CyclesTopUpConfig",
  "CreateDatabaseRequest",
  "CreateDatabaseResult",
  "NodeKind",
  "NodeMutationErrorCode",
  "NodeMutationError",
  "Node",
  "SearchPreviewField",
  "SearchPreviewMode",
  "SearchPreview",
  "SearchNodeHit",
  "SearchNodesRequest",
  "WriteSourceForGenerationRequest",
  "MkdirNodeRequest",
  "MkdirNodeResult",
  "NodeMutationAck",
  "WriteNodeResult",
  "WriteSourceForGenerationResult"
]);
const expectedMethods = selectCandidShapes(sharedMethods, [
  "get_cycles_billing_config",
  "create_database",
  "list_databases",
  "mkdir_node",
  "read_node",
  "search_nodes",
  "write_source_for_generation"
]);
const idlResultAliases = {
  null: "ResultUnit",
  CyclesBillingConfig: "ResultCyclesBillingConfig",
  CreateDatabaseResult: "ResultCreateDatabase",
  "vec DatabaseSummary": "ResultDatabases",
  "MkdirNodeResult|NodeMutationError": "ResultMkdirNode",
  "opt Node": "ResultNode",
  "vec SearchNodeHit": "ResultSearch",
  WriteNodeResult: "ResultWriteNode",
  "WriteSourceForGenerationResult|NodeMutationError": "ResultWriteSourceForGeneration"
};

const failures = checkCandidSubset({
  didSource: did,
  idlSource: actor,
  expectedTypes,
  expectedMethods,
  didTypeAliases,
  idlResultAliases,
  rejectUnexpectedMethods: true
});
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Extension Candid subset OK: ${Object.keys(expectedMethods).join(", ")}`);
