import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { didTypeAliases, expectedMethods, expectedTypes } from "./candid-shapes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const didPath = join(root, "crates", "vfs_canister", "vfs.did");
const idlPath = join(here, "..", "lib", "vfs-idl.ts");

const typeOrder = [
  "CanisterHealth",
  "DatabaseRole",
  "DatabaseStatus",
  "DatabaseSummary",
  "CyclesTopUpConfig",
  "CyclesBillingConfig",
  "CyclesBillingConfigUpdate",
  "CyclesPurchaseResult",
  "CyclesTopUpLauncherError",
  "CyclesTopUpLauncherResult",
  "CyclesTopUpCheckStatus",
  "CyclesTopUpCheckResult",
  "DatabaseCyclesPendingPurchase",
  "DatabaseCyclesPurchaseRequest",
  "MarketCreateListingRequest",
  "MarketEntitlement",
  "MarketEntitlementPage",
  "MarketListingStatus",
  "MarketListing",
  "MarketCategoryGraphEdge",
  "MarketCategoryGraphNode",
  "MarketCategoryGraph",
  "LinkEdge",
  "MarketListingPage",
  "MarketOrder",
  "MarketOrderPage",
  "MarketPreviewExcerpt",
  "MarketListingPreview",
  "MarketListingVerifiedStats",
  "MarketListingDetail",
  "MarketPurchasePreview",
  "MarketPurchaseRequest",
  "MarketUpdateListingRequest",
  "Icrc21ConsentMessageMetadata",
  "Icrc21DeviceSpec",
  "Icrc21ConsentMessageSpec",
  "Icrc21ConsentMessageRequest",
  "Icrc21ConsentMessage",
  "Icrc21ConsentInfo",
  "Icrc21ErrorInfo",
  "Icrc21GenericError",
  "Icrc21Error",
  "Icrc21ConsentMessageResponse",
  "Icrc10SupportedStandard",
  "CreateDatabaseRequest",
  "CreateDatabaseResult",
  "RenameDatabaseRequest",
  "DeleteDatabaseRequest",
  "DatabaseMember",
  "DatabaseCycleEntry",
  "DatabaseCycleEntryPage",
  "NodeKind",
  "NodeEntryKind",
  "Node",
  "ChildNode",
  "NodeMutationAck",
  "NodeContext",
  "SearchPreviewField",
  "SearchPreviewMode",
  "SearchPreview",
  "SearchNodeHit",
  "MemoryCapability",
  "MemoryRoot",
  "CanonicalRole",
  "MemoryManifest",
  "SourceEvidenceRef",
  "SourceEvidence",
  "QueryContext",
  "ListChildrenRequest",
  "IncomingLinksRequest",
  "OutgoingLinksRequest",
  "GraphLinksRequest",
  "GraphNeighborhoodRequest",
  "NodeContextRequest",
  "WriteNodeRequest",
  "WriteSourceForGenerationRequest",
  "DeleteNodeRequest",
  "MkdirNodeRequest",
  "MoveNodeRequest",
  "UrlIngestTriggerSessionRequest",
  "UrlIngestTriggerSessionCheckRequest",
  "OpsAnswerSessionRequest",
  "OpsAnswerSessionCheckRequest",
  "OpsAnswerSessionCheckResult",
  "SourceRunSessionCheckRequest",
  "SearchNodePathsRequest",
  "SearchNodesRequest",
  "QueryContextRequest",
  "SourceEvidenceRequest",
  "StorageBillingBatchRequest",
  "StorageBillingBatchResult",
  "ResultNode",
  "ResultChildren",
  "ResultLinks",
  "ResultNodeContext",
  "ResultSearch",
  "ResultQueryContext",
  "ResultSourceEvidence",
  "ResultStorageBillingBatch",
  "ResultCyclesTopUpCheck",
  "ResultCreateDatabase",
  "ResultCyclesBillingConfig",
  "ResultCyclesPurchase",
  "ResultCyclesEntries",
  "ResultCyclesPendingPurchases",
  "ResultMarketEntitlementPage",
  "ResultMarketListing",
  "ResultMarketListingDetail",
  "ResultMarketListings",
  "ResultMarketListingPage",
  "ResultMarketOrder",
  "ResultMarketOrderPage",
  "ResultMarketPurchasePreview",
  "ResultDatabases",
  "ResultMembers",
  "ResultNat64",
  "WriteNodeResult",
  "ResultWriteNode",
  "WriteSourceForGenerationResult",
  "ResultWriteSourceForGeneration",
  "DeleteNodeResult",
  "ResultDeleteNode",
  "MkdirNodeResult",
  "ResultMkdirNode",
  "MoveNodeResult",
  "ResultMoveNode",
  "ResultUnit",
  "ResultOpsAnswerSessionCheck"
];

const methodOrder = [
  "authorize_ops_answer_session",
  "authorize_url_ingest_trigger_session",
  "canister_health",
  "check_database_write_cycles",
  "check_cycles_top_up",
  "check_ops_answer_session",
  "check_source_run_session",
  "check_url_ingest_trigger_session",
  "create_database",
  "delete_database",
  "delete_node",
  "get_cycles_billing_config",
  "grant_database_access",
  "graph_links",
  "graph_neighborhood",
  "icrc10_supported_standards",
  "icrc21_canister_call_consent_message",
  "incoming_links",
  "list_database_cycle_entries",
  "list_database_cycles_pending_purchases",
  "list_databases",
  "list_database_members",
  "market_count_active_entitlements",
  "market_create_listing",
  "market_get_listing",
  "market_list_database_entitlements",
  "market_list_database_listings",
  "market_list_entitlements",
  "market_list_listings",
  "market_list_orders",
  "market_list_seller_listings",
  "market_pause_listing",
  "market_preview_purchase",
  "market_publish_listing",
  "market_purchase_access",
  "market_update_listing",
  "memory_manifest",
  "mkdir_node",
  "move_node",
  "query_context",
  "read_node",
  "read_node_context",
  "list_children",
  "outgoing_links",
  "revoke_database_access",
  "rename_database",
  "search_node_paths",
  "search_nodes",
  "settle_database_storage_charges_batch",
  "source_evidence",
  "update_cycles_billing_config",
  "purchase_database_cycles",
  "write_node",
  "write_source_for_generation"
];

export function generateVfsIdlFromDid(didSource) {
  validateDidSubset(didSource);
  validateRenderOrder();
  return renderVfsIdl();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = generateVfsIdlFromDid(readFileSync(didPath, "utf8"));
  if (process.argv.includes("--check")) {
    const current = readFileSync(idlPath, "utf8");
    if (current !== generated) {
      console.error("wikibrowser/lib/vfs-idl.ts is out of date. Run: node scripts/generate-vfs-idl.mjs");
      process.exit(1);
    }
    console.log("Generated VFS IDL is up to date");
  } else {
    writeFileSync(idlPath, generated);
    console.log("Generated wikibrowser/lib/vfs-idl.ts");
  }
}

function renderVfsIdl() {
  const lines = [
    "// Generated by scripts/generate-vfs-idl.mjs from crates/vfs_canister/vfs.did.",
    "// Do not edit by hand.",
    'import { Actor } from "@icp-sdk/core/agent";',
    'import { IDL } from "@icp-sdk/core/candid";',
    "",
    "type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];",
    "",
    "export const idlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {"
  ];

  for (const name of typeOrder) {
    lines.push(...renderTypeConst(name, expectedTypes[name]));
  }

  lines.push("");
  lines.push("  return idl.Service({");
  lines.push("    // The public canister ABI keeps legacy ops_* names; browser code exposes Query Q&A wrappers.");

  for (const [index, name] of methodOrder.entries()) {
    const suffix = index === methodOrder.length - 1 ? "" : ",";
    lines.push(`    ${renderMethod(name)}${suffix}`);
  }

  lines.push("  });");
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

function renderTypeConst(name, shape) {
  const kind = shape.kind === "record" ? "Record" : "Variant";
  const entries = Object.entries(shape.fields ?? shape.cases);
  const renderedEntries = entries.map(([field, type]) => `${field}: ${shapeToIdl(type)}`);
  const inline = `  const ${name} = idl.${kind}({ ${renderedEntries.join(", ")} });`;

  if (inline.length <= 120) {
    return [inline];
  }

  return [
    `  const ${name} = idl.${kind}({`,
    ...renderedEntries.map((entry, index) => `    ${entry}${index === renderedEntries.length - 1 ? "" : ","}`),
    "  });"
  ];
}

function renderMethod(name) {
  const method = expectedMethods[name];
  const inputs = method.input.map(shapeToIdl).join(", ");
  const mode = method.mode === "query" ? '"query"' : "";
  return `${name}: idl.Func([${inputs}], [${shapeToIdl(method.output)}], [${mode}])`;
}

function shapeToIdl(shape) {
  if (shape.startsWith("opt ")) {
    return `idl.Opt(${shapeToIdl(shape.slice(4))})`;
  }
  if (shape.startsWith("vec ")) {
    return `idl.Vec(${shapeToIdl(shape.slice(4))})`;
  }
  if (shape === "blob") {
    return "idl.Vec(idl.Nat8)";
  }

  const primitives = {
    bool: "idl.Bool",
    float32: "idl.Float32",
    int16: "idl.Int16",
    int64: "idl.Int64",
    nat: "idl.Nat",
    nat8: "idl.Nat8",
    nat16: "idl.Nat16",
    nat32: "idl.Nat32",
    nat64: "idl.Nat64",
    null: "idl.Null",
    principal: "idl.Principal",
    text: "idl.Text"
  };

  return primitives[shape] ?? shape;
}

function validateDidSubset(source) {
  const didTypes = parseDidTypes(source);
  const didMethods = parseDidMethods(source);
  const failures = [];

  for (const [name, shape] of Object.entries(expectedTypes)) {
    compareShape(failures, `vfs.did type ${name}`, didTypes[didTypeAliases[name] ?? name], shape);
  }

  for (const [name, shape] of Object.entries(expectedMethods)) {
    compareMethod(failures, `vfs.did method ${name}`, didMethods[name], shape);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

function validateRenderOrder() {
  const missingTypes = Object.keys(expectedTypes).filter((name) => !typeOrder.includes(name));
  const missingMethods = Object.keys(expectedMethods).filter((name) => !methodOrder.includes(name));
  const unknownTypes = typeOrder.filter((name) => !(name in expectedTypes));
  const unknownMethods = methodOrder.filter((name) => !(name in expectedMethods));
  const failures = [
    ...missingTypes.map((name) => `typeOrder missing ${name}`),
    ...missingMethods.map((name) => `methodOrder missing ${name}`),
    ...unknownTypes.map((name) => `typeOrder unknown ${name}`),
    ...unknownMethods.map((name) => `methodOrder unknown ${name}`)
  ];

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

function parseDidTypes(source) {
  const types = {};
  for (const match of source.matchAll(/^type\s+(\w+)\s*=\s*(record|variant)\s*\{([^]*?)\};/gm)) {
    const [, name, kind, body] = match;
    types[name] = kind === "record" ? { kind, fields: parseDidFields(body) } : { kind, cases: parseDidFields(body) };
  }
  return types;
}

function parseDidFields(body) {
  const fields = {};
  for (const raw of body.split(";")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^"?(\w+)"?\s*(?::\s*(.+))?$/);
    if (!match) continue;
    fields[match[1]] = normalizeShape(match[2] ?? "null");
  }
  return fields;
}

function parseDidMethods(source) {
  const service = source.match(/service\s*:\s*\([^)]*\)\s*->\s*\{([^]*?)\n\}/m)?.[1] ?? "";
  const methods = {};
  for (const raw of service.split(";")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\w+)\s*:\s*\(([^)]*)\)\s*->\s*\(([^)]*)\)(?:\s+(\w+))?$/);
    if (!match) continue;
    methods[match[1]] = {
      input: splitShapes(match[2]),
      output: normalizeResultAlias(match[3]),
      mode: match[4] ?? "update"
    };
  }
  return methods;
}

function splitShapes(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((part) => normalizeShape(part));
}

function normalizeShape(value) {
  return normalizeBlobAlias(value.trim().replace(/\s+/g, " "));
}

function normalizeBlobAlias(value) {
  if (value === "vec nat8") return "blob";
  if (value === "opt vec nat8") return "opt blob";
  return value;
}

function normalizeResultAlias(value) {
  const normalized = normalizeShape(value).replace(/,$/, "").trim();
  const alias = Object.entries(didTypeAliases).find(([, didName]) => didName === normalized)?.[0];
  if (alias) return alias;
  if (normalized === "Result") return "ResultWriteNode";
  return normalized;
}

function compareShape(failures, label, actual, expected) {
  if (!actual) {
    failures.push(`${label} missing`);
    return;
  }
  if (actual.kind !== expected.kind) {
    failures.push(`${label} kind mismatch: ${actual.kind} != ${expected.kind}`);
    return;
  }
  compareMap(failures, label, actual.fields ?? actual.cases, expected.fields ?? expected.cases);
}

function compareMethod(failures, label, actual, expected) {
  if (!actual) {
    failures.push(`${label} missing`);
    return;
  }
  const actualInput = actual.input.map(canonicalTypeName);
  const expectedInput = expected.input.map(canonicalTypeName);
  if (JSON.stringify(actualInput) !== JSON.stringify(expectedInput)) {
    failures.push(`${label} input mismatch: ${actual.input.join(", ")} != ${expected.input.join(", ")}`);
  }
  if (actual.output !== expected.output) {
    failures.push(`${label} output mismatch: ${actual.output} != ${expected.output}`);
  }
  if (actual.mode !== expected.mode) {
    failures.push(`${label} mode mismatch: ${actual.mode} != ${expected.mode}`);
  }
}

function canonicalTypeName(name) {
  return didTypeAliases[name] ?? name;
}

function compareMap(failures, label, actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    failures.push(`${label} fields mismatch: ${actualKeys.join(", ")} != ${expectedKeys.join(", ")}`);
    return;
  }
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) {
      failures.push(`${label}.${key} mismatch: ${actual[key]} != ${expected[key]}`);
    }
  }
}
