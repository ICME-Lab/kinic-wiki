// Where: extensions/wiki-clipper/scripts/check-candid-drift.mjs
// What: Compare the extension's hand-written VFS IDL subset with vfs.did.
// Why: Extension writes use a minimal IDL that can silently drift from canister Candid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const did = readFileSync(new URL("../../../crates/vfs_canister/vfs.did", import.meta.url), "utf8");
const actor = readFileSync(new URL("../src/vfs-actor.js", import.meta.url), "utf8");

const expectedTypes = {
  DatabaseRole: { kind: "variant", fields: { Reader: "null", Writer: "null", Owner: "null" } },
  DatabaseStatus: { kind: "variant", fields: { Hot: "null", Restoring: "null", Archiving: "null", Archived: "null", Deleted: "null" } },
  DatabaseSummary: {
    kind: "record",
    fields: {
      status: "DatabaseStatus",
      name: "text",
      role: "DatabaseRole",
      logical_size_bytes: "nat64",
      database_id: "text",
      cycles_balance: "opt nat64",
      cycles_suspended_at_ms: "opt int64",
      archived_at_ms: "opt int64",
      deleted_at_ms: "opt int64"
    }
  },
  CyclesBillingConfig: {
    kind: "record",
    fields: {
      kinic_ledger_canister_id: "text",
      billing_authority_id: "text",
      cycles_per_kinic: "nat64",
      min_update_cycles: "nat64"
    }
  },
  CreateDatabaseRequest: { kind: "record", fields: { name: "text" } },
  CreateDatabaseResult: { kind: "record", fields: { name: "text", database_id: "text" } },
  NodeKind: { kind: "variant", fields: { File: "null", Source: "null", Folder: "null" } },
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
  WriteNodeRequest: {
    kind: "record",
    fields: {
      database_id: "text",
      path: "text",
      kind: "NodeKind",
      content: "text",
      metadata_json: "text",
      expected_etag: "opt text"
    }
  },
  WriteSourceForGenerationRequest: {
    kind: "record",
    fields: {
      database_id: "text",
      path: "text",
      content: "text",
      metadata_json: "text",
      expected_etag: "opt text",
      session_nonce: "text"
    }
  },
  MkdirNodeRequest: { kind: "record", fields: { database_id: "text", path: "text" } },
  MkdirNodeResult: { kind: "record", fields: { path: "text", created: "bool" } },
  UrlIngestTriggerSessionRequest: { kind: "record", fields: { database_id: "text", session_nonce: "text" } },
  NodeMutationAck: { kind: "record", fields: { updated_at: "int64", etag: "text", kind: "NodeKind", path: "text" } },
  WriteNodeResult: { kind: "record", fields: { created: "bool", node: "NodeMutationAck" } },
  WriteSourceForGenerationResult: { kind: "record", fields: { write: "WriteNodeResult", session_nonce: "text" } }
};
const actorExpectedTypes = {
  ...expectedTypes,
  DatabaseStatus: { kind: "variant", fields: { Hot: "null", Pending: "null", Active: "null", Restoring: "null", Archiving: "null", Archived: "null", Deleted: "null" } }
};

const expectedMethods = {
  authorize_url_ingest_trigger_session: { input: ["UrlIngestTriggerSessionRequest"], output: "ResultUnit", mode: "update" },
  get_cycles_billing_config: { input: [], output: "ResultCyclesBillingConfig", mode: "query" },
  create_database: { input: ["CreateDatabaseRequest"], output: "ResultCreateDatabase", mode: "update" },
  list_databases: { input: [], output: "ResultDatabases", mode: "query" },
  mkdir_node: { input: ["MkdirNodeRequest"], output: "ResultMkdirNode", mode: "update" },
  read_node: { input: ["text", "text"], output: "ResultNode", mode: "query" },
  write_node: { input: ["WriteNodeRequest"], output: "ResultWriteNode", mode: "update" },
  write_source_for_generation: { input: ["WriteSourceForGenerationRequest"], output: "ResultWriteSourceForGeneration", mode: "update" }
};

const didTypes = parseDidTypes(did);
const didMethods = parseDidMethods(did);
const actorTypes = parseActorTypes(actor);
const actorMethods = parseActorMethods(actor);

for (const [name, shape] of Object.entries(expectedTypes)) {
  assert.deepEqual(canonicalTypeShape(didTypes[name]), shape, `vfs.did type drift: ${name}`);
  assert.deepEqual(actorTypes[name], actorExpectedTypes[name], `extension IDL type drift: ${name}`);
}

for (const [name, shape] of Object.entries(expectedMethods)) {
  assert.deepEqual(didMethods[name], shape, `vfs.did method drift: ${name}`);
  assert.deepEqual(actorMethods[name], shape, `extension IDL method drift: ${name}`);
}

console.log(`Extension Candid subset OK: ${Object.keys(expectedMethods).join(", ")}`);

function parseDidTypes(source) {
  const result = {};
  for (const match of source.matchAll(/^type\s+(\w+)\s*=\s*(record|variant)\s*\{([^]*?)\};/gm)) {
    const [, name, kind, body] = match;
    result[name] = { kind, fields: parseDidFields(body) };
  }
  return result;
}

function parseDidFields(body) {
  const fields = {};
  for (const raw of body.split(";")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^"?(\w+)"?\s*(?::\s*(.+))?$/);
    if (match) fields[match[1]] = normalizeDidShape(match[2] ?? "null");
  }
  return fields;
}

function parseDidMethods(source) {
  const service = source.match(/service\s*:\s*\([^)]*\)\s*->\s*\{([^]*?)\n\}/m)?.[1] ?? "";
  const methods = {};
  for (const raw of service.split(";")) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (!line) continue;
    const match = line.match(/^(\w+)\s*:\s*\(([^)]*)\)\s*->\s*\(([^)]*)\)(?:\s+(\w+))?$/);
    if (!match || !(match[1] in expectedMethods)) continue;
    methods[match[1]] = {
      input: splitDidInputs(match[2]),
      output: normalizeDidResult(match[3]),
      mode: match[4] ?? "update"
    };
  }
  return methods;
}

function parseActorTypes(source) {
  const result = {};
  for (const [name, shape] of Object.entries(actorExpectedTypes)) {
    const initializer = source.match(new RegExp(`const\\s+${name}\\s*=\\s*idl\\.(Record|Variant)\\(\\{([^]*?)\\}\\);`, "m"));
    assert.ok(initializer, `extension IDL type missing: ${name}`);
    const kind = initializer[1] === "Record" ? "record" : "variant";
    result[name] = { kind, fields: parseActorFields(initializer[2]) };
    assert.equal(result[name].kind, shape.kind, `extension IDL kind drift: ${name}`);
  }
  return result;
}

function parseActorFields(body) {
  const fields = {};
  for (const raw of body.split(",")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) fields[match[1]] = normalizeActorShape(match[2]);
  }
  return fields;
}

function parseActorMethods(source) {
  const methods = {};
  const service = source.match(/return idl\.Service\(\{([^]*?)\n\s*\}\);/m)?.[1] ?? "";
  for (const [name, expected] of Object.entries(expectedMethods)) {
    const match = service.match(new RegExp(`${name}:\\s*idl\\.Func\\(\\[([^\\]]*)\\],\\s*\\[idl\\.Variant\\(\\{\\s*Ok:\\s*([^,}]+),\\s*Err:\\s*idl\\.Text\\s*\\}\\)\\],\\s*\\[([^\\]]*)\\]`, "m"));
    assert.ok(match, `extension IDL method missing: ${name}`);
    methods[name] = {
      input: splitActorInputs(match[1]),
      output: actorResultName(match[2].trim()),
      mode: match[3].includes('"query"') ? "query" : "update"
    };
    assert.deepEqual(methods[name].input, expected.input, `extension IDL input drift: ${name}`);
  }
  return methods;
}

function normalizeDidShape(value) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeDidResult(value) {
  const normalized = normalizeDidShape(value).replace(/,$/, "");
  if (normalized === "Result_1") return "ResultUnit";
  if (normalized === "Result_9") return "ResultCyclesBillingConfig";
  if (normalized === "Result_4") return "ResultCreateDatabase";
  if (normalized === "Result_16") return "ResultDatabases";
  if (normalized === "Result_18") return "ResultMkdirNode";
  if (normalized === "Result_24") return "ResultNode";
  if (normalized === "Result_30") return "ResultWriteSourceForGeneration";
  if (normalized === "Result") return "ResultWriteNode";
  return normalized;
}

function normalizeActorShape(value) {
  return value
    .trim()
    .replace(/^idl\./, "")
    .replace(/^Text$/, "text")
    .replace(/^Int64$/, "int64")
    .replace(/^Nat64$/, "nat64")
    .replace(/^Bool$/, "bool")
    .replace(/^Null$/, "null")
    .replace(/^Opt\((.+)\)$/, (_, inner) => `opt ${normalizeActorShape(inner)}`);
}

function splitDidInputs(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((part) => normalizeDidShape(part));
}

function splitActorInputs(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((part) => normalizeActorShape(part.trim()));
}

function actorResultName(okShape) {
  const normalized = normalizeActorShape(okShape);
  if (normalized === "null") return "ResultUnit";
  if (normalized === "CyclesBillingConfig") return "ResultCyclesBillingConfig";
  if (normalized === "CreateDatabaseResult") return "ResultCreateDatabase";
  if (normalized === "Vec(DatabaseSummary)") return "ResultDatabases";
  if (normalized === "MkdirNodeResult") return "ResultMkdirNode";
  if (normalized === "opt Node") return "ResultNode";
  if (normalized === "WriteNodeResult") return "ResultWriteNode";
  if (normalized === "WriteSourceForGenerationResult") return "ResultWriteSourceForGeneration";
  return normalized;
}

function canonicalTypeShape(shape) {
  if (!shape) return shape;
  return shape;
}
