import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedMethods, expectedTypes } from "./candid-shapes.mjs";
import { generateVfsIdlFromDid } from "./generate-vfs-idl.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const idl = readFileSync(join(here, "..", "lib", "vfs-idl.ts"), "utf8");
const readme = readFileSync(join(here, "..", "README.md"), "utf8");
const generator = readFileSync(join(here, "generate-vfs-idl.mjs"), "utf8");

const idlTypes = parseIdlTypes(idl);
const idlMethods = parseIdlMethods(idl);
const failures = [];

for (const [name, shape] of Object.entries(expectedTypes)) {
  compareShape(`vfs-idl.ts type ${name}`, idlTypes[name], shape);
}

for (const [name, shape] of Object.entries(expectedMethods)) {
  compareMethod(`vfs-idl.ts method ${name}`, idlMethods[name], shape);
}

for (const name of Object.keys(idlMethods)) {
  if (!(name in expectedMethods)) {
    failures.push(`unexpected wikibrowser IDL method: ${name}`);
  }
}

try {
  const generated = generateVfsIdlFromDid();
  if (idl !== generated) {
    failures.push("wikibrowser/lib/vfs-idl.ts is not generated from scripts/candid-shapes.mjs; run node scripts/generate-vfs-idl.mjs");
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (!readme.includes("production wiki canister `xis3j-paaaa-aaaai-axumq-cai`")) {
  failures.push("wikibrowser README must document the temporary production canister ABI source");
}
if (!readme.includes("Local Internet Identity e2e is intentionally out of scope")) {
  failures.push("wikibrowser README must document the temporary local II e2e exclusion");
}
if (!readme.includes("Point wikibrowser drift checks back at the checked-in canister DID")) {
  failures.push("wikibrowser README must document the post-review Candid reintegration task");
}
if (!generator.includes("Chrome extension review freezes the checked-in canister DID on the older ABI")) {
  failures.push("generate-vfs-idl.mjs must document why it does not read crates/vfs_canister/vfs.did");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Candid subset shape OK: ${Object.keys(expectedMethods).join(", ")}`);

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

function normalizeBlobAlias(value) {
  if (value === "vec nat8") return "blob";
  if (value === "opt vec nat8") return "opt blob";
  return value;
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
  return name;
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
