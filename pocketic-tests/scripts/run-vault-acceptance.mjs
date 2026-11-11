// Sequential processes preserve independent replica lifecycles and fail on teardown errors.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
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
