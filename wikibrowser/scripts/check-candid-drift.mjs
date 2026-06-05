import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { didTypeAliases, expectedMethods, expectedTypes } from "./candid-shapes.mjs";
import { generateVfsIdlFromDid } from "./generate-vfs-idl.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const did = readFileSync(join(root, "crates", "vfs_canister", "vfs.did"), "utf8");
const idl = readFileSync(join(here, "..", "lib", "vfs-idl.ts"), "utf8");

const didTypes = parseDidTypes(did);
const didMethods = parseDidMethods(did);
const idlTypes = parseIdlTypes(idl);
const idlMethods = parseIdlMethods(idl);
const failures = [];

for (const [name, shape] of Object.entries(expectedTypes)) {
  compareShape(`vfs.did type ${name}`, didTypes[didTypeAliases[name] ?? name], shape);
  compareShape(`vfs-idl.ts type ${name}`, idlTypes[name], shape);
}

for (const [name, shape] of Object.entries(expectedMethods)) {
  compareMethod(`vfs.did method ${name}`, didMethods[name], shape);
  compareMethod(`vfs-idl.ts method ${name}`, idlMethods[name], shape);
}

for (const name of Object.keys(idlMethods)) {
  if (!(name in expectedMethods)) {
    failures.push(`unexpected wikibrowser IDL method: ${name}`);
  }
}

try {
  const generated = generateVfsIdlFromDid(did);
  if (idl !== generated) {
    failures.push("wikibrowser/lib/vfs-idl.ts is not generated from crates/vfs_canister/vfs.did; run node scripts/generate-vfs-idl.mjs");
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Candid subset shape OK: ${Object.keys(expectedMethods).join(", ")}`);

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

function parseIdlTypes(source) {
  const types = {};
  for (const declaration of extractIdlConstDeclarations(source)) {
    const match = declaration.initializer.match(/^idl\.(Record|Variant)\(\{([^]*)\}\)$/m);
    if (!match) continue;
    const [, rawKind, body] = match;
    const kind = rawKind === "Record" ? "record" : "variant";
    const fields = parseIdlFields(body);
    types[declaration.name] = kind === "record" ? { kind, fields } : { kind, cases: fields };
  }
  return types;
}

function extractIdlConstDeclarations(source) {
  const declarations = [];
  const pattern = /const\s+(\w+)\s*=\s*/g;
  let match;
  while ((match = pattern.exec(source))) {
    const name = match[1];
    const start = match.index + match[0].length;
    const end = findStatementEnd(source, start);
    if (end === -1) continue;
    declarations.push({ name, initializer: source.slice(start, end).trim() });
    pattern.lastIndex = end + 1;
  }
  return declarations;
}

function parseIdlFields(body) {
  const fields = {};
  for (const raw of body.split(",")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (!match) continue;
    fields[match[1]] = normalizeIdlShape(match[2]);
  }
  return fields;
}

function parseIdlMethods(source) {
  const service = source.match(/return\s+idl\.Service\(\{([^]*?)\n\s*\}\);/m)?.[1] ?? "";
  const methods = {};
  for (const match of service.matchAll(/^\s*(\w+):\s*idl\.Func\(\[\s*([^\]]*)\s*\],\s*\[\s*([^\]]+?)\s*\],\s*\[\s*(?:"(\w+)")?\s*\]\)/gm)) {
    methods[match[1]] = {
      input: splitIdlInputs(match[2]),
      output: normalizeIdlShape(match[3]),
      mode: match[4] ?? "update"
    };
  }
  return methods;
}

function findStatementEnd(source, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (char === "\"" && previous !== "\\") {
      inString = !inString;
    }
    if (inString) continue;
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
    } else if (char === ";" && depth === 0) {
      return index;
    }
  }
  return -1;
}

function normalizeIdlShape(value) {
  const normalized = value
    .trim()
    .replace(/^idl\./, "")
    .replace(/^Text$/, "text")
    .replace(/^Int16$/, "int16")
    .replace(/^Int64$/, "int64")
    .replace(/^Nat64$/, "nat64")
    .replace(/^Nat32$/, "nat32")
    .replace(/^Nat16$/, "nat16")
    .replace(/^Nat8$/, "nat8")
    .replace(/^Nat$/, "nat")
    .replace(/^Float32$/, "float32")
    .replace(/^Bool$/, "bool")
    .replace(/^Principal$/, "principal")
    .replace(/^Null$/, "null")
    .replace(/^Opt\((.+)\)$/, (_, inner) => `opt ${normalizeIdlShape(inner)}`)
    .replace(/^Vec\((.+)\)$/, (_, inner) => `vec ${normalizeIdlShape(inner)}`);
  return normalizeBlobAlias(normalized);
}

function splitIdlInputs(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((part) => normalizeIdlShape(part));
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
  if (normalized === "Result_10") return "ResultLinks";
  if (normalized === "Result_11") return "ResultLinks";
  if (normalized === "Result_12") return "ResultChildren";
  if (normalized === "Result_13") return "ResultCyclesEntries";
  if (normalized === "Result_14") return "ResultCyclesPendingPurchases";
  if (normalized === "Result_15") return "ResultMembers";
  if (normalized === "Result_16") return "ResultDatabases";
  if (normalized === "Result_1") return "ResultUnit";
  if (normalized === "Result_4") return "ResultCreateDatabase";
  if (normalized === "Result_5") return "ResultDeleteNode";
  if (normalized === "Result_18") return "ResultMkdirNode";
  if (normalized === "Result_19") return "ResultMoveNode";
  if (normalized === "Result_20") return "ResultCyclesPurchase";
  if (normalized === "Result_21") return "ResultQueryContext";
  if (normalized === "Result_24") return "ResultNode";
  if (normalized === "Result_25") return "ResultNodeContext";
  if (normalized === "Result_26") return "ResultSearch";
  if (normalized === "Result_27") return "ResultStorageBillingBatch";
  if (normalized === "Result_28") return "ResultSourceEvidence";
  if (normalized === "Result_3") return "ResultOpsAnswerSessionCheck";
  if (normalized === "Result_30") return "ResultWriteSourceForGeneration";
  if (normalized === "Result_9") return "ResultCyclesBillingConfig";
  if (normalized === "Result") return "ResultWriteNode";
  return normalized;
}

function compareShape(label, actual, expected) {
  if (!actual) {
    failures.push(`${label} missing`);
    return;
  }
  if (actual.kind !== expected.kind) {
    failures.push(`${label} kind mismatch: ${actual.kind} != ${expected.kind}`);
    return;
  }
  const actualFields = actual.fields ?? actual.cases;
  const expectedFields = expected.fields ?? expected.cases;
  compareMap(label, actualFields, expectedFields);
}

function compareMethod(label, actual, expected) {
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

function compareMap(label, actual, expected) {
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
