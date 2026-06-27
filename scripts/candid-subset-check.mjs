// Where: scripts/candid-subset-check.mjs
// What: Shared structural checks for hand-written Candid IDL subsets.
// Why: Browser-side hand-written IDL should fail CI when crates/vfs_canister/vfs.did drifts.
export function checkCandidSubset({ didSource, idlSource, expectedTypes, expectedMethods, didTypeAliases = {} }) {
  const failures = [];
  const didTypes = parseDidTypes(didSource);
  const didMethods = parseDidMethods(didSource, didTypeAliases);
  const idlTypes = parseIdlTypes(idlSource);
  const idlMethods = parseIdlMethods(idlSource);

  for (const [name, shape] of Object.entries(expectedTypes)) {
    compareShape(failures, `vfs.did type ${name}`, didTypes[didTypeAliases[name] ?? name], shape);
    compareShape(failures, `hand-written IDL type ${name}`, idlTypes[name], shape);
  }

  for (const [name, shape] of Object.entries(expectedMethods)) {
    compareMethod(failures, `vfs.did method ${name}`, didMethods[name], shape, didTypeAliases);
    compareMethod(failures, `hand-written IDL method ${name}`, idlMethods[name], shape, didTypeAliases);
  }

  return failures;
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

function parseDidMethods(source, didTypeAliases) {
  const service = source.match(/service\s*:\s*\([^)]*\)\s*->\s*\{([^]*?)\n\}/m)?.[1] ?? "";
  const methods = {};
  for (const raw of service.split(";")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\w+)\s*:\s*\(([^)]*)\)\s*->\s*\(([^)]*)\)(?:\s+(\w+))?$/);
    if (!match) continue;
    methods[match[1]] = {
      input: splitShapes(match[2]),
      output: normalizeResultAlias(match[3], didTypeAliases),
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

function splitShapes(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((part) => normalizeShape(part))
    .filter(Boolean);
}

function normalizeShape(value) {
  return normalizeBlobAlias(value.trim().replace(/\s+/g, " "));
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

function normalizeResultAlias(value, didTypeAliases) {
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

function compareMethod(failures, label, actual, expected, didTypeAliases) {
  if (!actual) {
    failures.push(`${label} missing`);
    return;
  }
  const actualInput = actual.input.map((name) => canonicalTypeName(name, didTypeAliases));
  const expectedInput = expected.input.map((name) => canonicalTypeName(name, didTypeAliases));
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

function canonicalTypeName(name, didTypeAliases) {
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
