// Focused actual-Wasm gate. Build the canister, synthetic ledger and isolated quota
// baseline first. Every child process must finish successfully, including teardown.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
for (const path of [
  "target/wasm32-unknown-unknown/release/vault_canister.wasm",
  "target/vault-restore-quota-baseline.wasm",
  "target/vault-dedicated-task12.wasm",
  "target/vault-restore-task12-quota.wasm",
]) {
  console.log(
    `ARTIFACT ${path} sha256=${createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex")}`,
  );
}
for (const name of [
  "pipeline",
  "parent",
  "sources",
  "upgrade",
  "flights",
  "cancel",
  "quota-refusal",
]) {
  console.log(`RUN actual Wasm restore ${name}`);
  execFileSync(
    process.execPath,
    [`pocketic-tests/integration/vault-restore-${name}.test.mjs`],
    {
      cwd: root,
      env: {
        ...process.env,
        VAULT_RESTORE_FULL_QUOTA: ["pipeline", "parent"].includes(name)
          ? "1"
          : "0",
      },
      stdio: "inherit",
    },
  );
  console.log(`EXIT 0 actual Wasm restore ${name}`);
}
console.log(
  "PASS all 7 actual-Wasm restore acceptance processes, including teardown",
);
