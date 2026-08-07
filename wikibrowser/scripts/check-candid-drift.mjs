import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateVfsIdlFromDid } from "@kinic/candid-tools/generate-vfs-idl";
import { didTypeAliases, expectedMethods, expectedTypes } from "@kinic/candid-tools/shapes";
import { checkCandidSubset } from "@kinic/candid-tools/subset-check";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const did = readFileSync(join(root, "crates", "vfs_canister", "vfs.did"), "utf8");
const idlPath = join(root, "packages", "vfs-candid", "index.ts");
const idl = readFileSync(idlPath, "utf8");

const failures = checkCandidSubset({
  didSource: did,
  idlSource: idl,
  expectedTypes,
  expectedMethods,
  didTypeAliases,
  rejectUnexpectedMethods: true
});

try {
  const generated = generateVfsIdlFromDid(did);
  if (idl !== generated) {
    failures.push(
      "packages/vfs-candid/index.ts is not generated from crates/vfs_canister/vfs.did; run pnpm --dir packages/vfs-candid generate"
    );
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Candid subset shape OK: ${Object.keys(expectedMethods).join(", ")}`);
