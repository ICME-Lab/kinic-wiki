// Sequential processes preserve independent replica lifecycles and fail on teardown errors.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const binary = process.env.POCKET_IC_BIN;
if (!binary) {
  throw Error("Vault acceptance requires POCKET_IC_BIN pointing to PocketIC 16.1.0");
}
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
if (version !== "pocket-ic-server 16.1.0") {
  throw Error(`Vault acceptance requires PocketIC 16.1.0; ${binary} reports ${version}`);
}
console.log(`Vault acceptance runtime: ${version} (${binary})`);
const cases = [
  ["physical-isolation"],
  ["certification"],
  ["isolation"],
  ["generations"],
  ["capacity"],
  ["incident"],
  ["incident-cutover"],
  ["restore-admission"],
  ["restore-admission", { VAULT_RESTORE_REUSE_SMOKE: "1" }],
  ["restore-pipeline", { VAULT_RESTORE_FULL_QUOTA: "1" }],
  ["restore-parent", { VAULT_RESTORE_FULL_QUOTA: "1" }],
  [
    "restore-parent",
    { VAULT_RESTORE_FULL_QUOTA: "1", VAULT_PARENT_MIXED: "1" },
  ],
  ["restore-sources"],
  ["restore-upgrade"],
  ["restore-flights"],
  ["restore-cancel"],
  ["restore-quota-refusal"],
  ["create-empty"],
];
for (const [name, env = {}] of cases) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name))
    continue;
  console.log(`RUN vault-${name} ${JSON.stringify(env)}`);
  execFileSync(
    process.execPath,
    [`pocketic-tests/integration/vault-${name}.test.mjs`],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    },
  );
  console.log(`EXIT 0 vault-${name}`);
}
console.log("PASS selected dedicated Wasm acceptance processes");
