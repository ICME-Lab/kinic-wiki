// Isolated Task5 fixture: only init seeding differs from the immutable baseline.
// No fixture method or seeding code is linked into production Vault Wasm.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const base = "17a21c18ba37700f03af835b32c3038a55886a45";
const dir = join(root, "target/vault-capacity-baseline");
mkdirSync(dir, { recursive: true });
const archive = join(dir, "source.tar");
execFileSync("git", [
  "-C",
  root,
  "archive",
  "--format=tar",
  "--output",
  archive,
  base,
  "Cargo.toml",
  "Cargo.lock",
  "crates/vault_canister",
  "crates/vault_types",
  "crates/vault_store",
  "crates/vault_service",
  "crates/kinic_sqlite_compat",
  "vendor/passkey-auth",
]);
execFileSync("tar", ["-xf", archive, "-C", dir]);
let manifest = readFileSync(join(dir, "Cargo.toml"), "utf8")
  .replace(
    /members = \[[\s\S]*?\]/,
    'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat"]',
  )
  .replace('ic-agent = { path = "vendor/ic-agent" }', "");
writeFileSync(join(dir, "Cargo.toml"), manifest);
if (!existsSync(join(dir, "vaultbrowser")))
  symlinkSync(join(root, "vaultbrowser"), join(dir, "vaultbrowser"));
const lib = join(dir, "crates/vault_canister/src/lib.rs");
let source = readFileSync(lib, "utf8");
source = source.replace(
  "fn init() {\n    initialize()\n}",
  readFileSync(
    join(root, "pocketic-tests/fixtures/vault-capacity-init.rs"),
    "utf8",
  ),
);
if (!source.includes("fn init(seed_accounts: u16, overcommit: bool)"))
  throw Error("baseline init changed");
writeFileSync(lib, source);
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
      CARGO_TARGET_DIR: join(root, "target/vault-capacity-baseline-build"),
    },
    stdio: "inherit",
  },
);
writeFileSync(
  join(root, "target/vault-capacity-baseline.wasm"),
  readFileSync(
    join(
      root,
      "target/vault-capacity-baseline-build/wasm32-unknown-unknown/release/vault_canister.wasm",
    ),
  ),
);
console.log(
  `Synthetic seeded Task5 baseline ${base}: target/vault-capacity-baseline.wasm`,
);
