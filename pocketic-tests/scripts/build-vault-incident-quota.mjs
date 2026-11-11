// Copy the current reviewed-source candidate into an isolated fixture build. Only that copy
// gains synthetic logical-quota seeding on upgrade. Production source/Wasm remain unchanged.
import {
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "../.."),
  dir = join(root, "target/vault-incident-quota-source");
mkdirSync(dir, { recursive: true });
for (const path of [
  "Cargo.toml",
  "Cargo.lock",
  "crates/vault_canister",
  "crates/vault_types",
  "crates/vault_store",
  "crates/vault_service",
  "crates/kinic_sqlite_compat",
  "vendor/passkey-auth",
]) {
  cpSync(join(root, path), join(dir, path), { recursive: true });
}
let manifest = readFileSync(join(dir, "Cargo.toml"), "utf8")
  .replace(
    /members = \[[\s\S]*?\]/,
    'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat"]',
  )
  .replace('ic-agent = { path = "vendor/ic-agent" }', "");
writeFileSync(join(dir, "Cargo.toml"), manifest);
if (!existsSync(join(dir, "vaultbrowser")))
  symlinkSync(join(root, "vaultbrowser"), join(dir, "vaultbrowser"));
const lib = join(dir, "crates/vault_canister/src/lib.rs"),
  before = readFileSync(lib, "utf8");
const after = before.replace(
  "fn post_upgrade() {\n    initialize()\n}",
  readFileSync(
    join(root, "pocketic-tests/fixtures/vault-incident-fill.rs"),
    "utf8",
  ),
);
if (after === before) throw Error("upgrade hook changed");
writeFileSync(lib, after);
execFileSync(
  "cargo",
  [
    "build",
    "-p",
    "vault-canister",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--offline",
  ],
  {
    cwd: dir,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: join(root, "target/vault-incident-quota-build"),
    },
    stdio: "inherit",
  },
);
cpSync(
  join(
    root,
    "target/vault-incident-quota-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  ),
  join(root, "target/vault-incident-quota.wasm"),
);
console.log(
  "Built isolated full-quota incident fixture; production has no seeding code",
);
