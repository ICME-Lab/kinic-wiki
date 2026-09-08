#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const livePath = path.join(repoRoot, "contracts/mainnet-vfs-83bbb0b6.did");
const candidatePath = path.join(repoRoot, "crates/vfs_canister/vfs.did");
const expectedFixtureHash = "3ed81d15507a9e5ab94e51106379e73414317d759dddc9bd68b13070e4e8a8ba";

const live = readFileSync(livePath, "utf8");
const candidate = readFileSync(candidatePath, "utf8");
const fixtureHash = createHash("sha256").update(live).digest("hex");
if (fixtureHash !== expectedFixtureHash) {
  throw new Error(`mainnet Candid fixture hash changed: ${fixtureHash}`);
}

const compatibility = spawnSync("didc", ["check", candidatePath, livePath], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (compatibility.status !== 0) {
  process.stderr.write(compatibility.stderr || compatibility.stdout);
  throw new Error("candidate Candid is not backward-compatible with the live fixture");
}

function serviceMethods(source) {
  const service = source.match(/service\s*:\s*\([^]*?\)\s*->\s*\{([^]*)\}\s*$/)?.[1];
  if (!service) throw new Error("unable to locate Candid service block");
  return new Set([...service.matchAll(/^\s{2}([a-zA-Z0-9_]+)\s*:/gm)].map((match) => match[1]));
}

const liveMethods = serviceMethods(live);
const candidateMethods = serviceMethods(candidate);
const removedMethods = [...liveMethods].filter((method) => !candidateMethods.has(method));
const addedMethods = [...candidateMethods].filter((method) => !liveMethods.has(method));
if (removedMethods.length !== 0 || addedMethods.join(",") !== "grant_database_cycles_from_iap") {
  throw new Error(
    `unexpected service method delta; removed=[${removedMethods}] added=[${addedMethods}]`,
  );
}

const requiredFragments = [
  /type CyclesBillingConfig = record \{[^}]*iap_authority_id : opt text;/s,
  /type CyclesBillingConfigUpdate = record \{[^}]*iap_authority_id : opt text;/s,
  /grant_database_cycles_from_iap\s*:\s*\(DatabaseCyclesIapGrantRequest\)\s*->\s*\(\s*Result_\d+,?\s*\);/s,
];
for (const fragment of requiredFragments) {
  if (!fragment.test(candidate)) {
    throw new Error(`candidate Candid is missing expected IAP contract: ${fragment}`);
  }
}

const grantRequest = candidate.match(
  /type DatabaseCyclesIapGrantRequest = record \{([^}]*)\};/s,
)?.[1];
if (!grantRequest) throw new Error("candidate Candid is missing the IAP grant request type");
const expectedGrantFields = new Set([
  "amount_cycles:nat64",
  "database_id:text",
  "external_payment_id:text",
  "provider:text",
  "product_id:text",
  "purchaser_principal:text",
]);
const actualGrantFields = new Set(
  [...grantRequest.matchAll(/^\s*([a-z_]+)\s*:\s*([^;]+);/gm)].map(
    ([, name, type]) => `${name}:${type.trim()}`,
  ),
);
if (
  actualGrantFields.size !== expectedGrantFields.size ||
  [...expectedGrantFields].some((field) => !actualGrantFields.has(field))
) {
  throw new Error(`unexpected IAP grant request fields: ${[...actualGrantFields]}`);
}

console.log("mainnet Candid compatibility: PASS");
