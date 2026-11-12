import { createHash } from "node:crypto";
// Isolated reachable source archive: only upgrade quota seeding differs.
// Filler belongs to another owner; replacing the tested Vault never reclaims it.
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
// Full-quota seeding must remain schema-compatible with the current runtime.
// Historical upgrade tests explicitly select their immutable old source below.
const base = process.env.VAULT_RESTORE_BASE ?? "HEAD";
const commit = execFileSync(
  "git",
  ["-C", root, "rev-parse", `${base}^{commit}`],
  { encoding: "utf8" },
).trim();
execFileSync("git", [
  "-C",
  root,
  "merge-base",
  "--is-ancestor",
  commit,
  "HEAD",
]);
const output =
  process.env.VAULT_RESTORE_OUTPUT ?? "vault-restore-quota-baseline";
if (!/^[a-z0-9-]+$/.test(output)) throw Error("invalid output basename");
const dir = join(root, `target/vault-restore-quota-baseline-${commit}`);
mkdirSync(dir, { recursive: true });
const archive = join(dir, "source.tar");
execFileSync("git", [
  "-C",
  root,
  "archive",
  "--format=tar",
  "--output",
  archive,
  commit,
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
  "fn post_upgrade() {\n    initialize()\n}",
  readFileSync(
    join(root, "pocketic-tests/fixtures/vault-incident-fill.rs"),
    "utf8",
  ),
);
if (!source.includes("let remaining=vault_types::TOTAL_MAX"))
  throw Error("baseline init changed");
writeFileSync(lib, source);
const buildEnv = {
  ...process.env,
  CARGO_TARGET_DIR: join(root, "target/vault-restore-quota-baseline-build"),
};
// git archive restores historical mtimes. The shared target can otherwise reuse
// current vault-types while compiling an older service (or the reverse).
// Match the ordinary baseline builder: rebuild every local crate for this source.
execFileSync(
  "cargo",
  [
    "clean",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--offline",
    ...[
      "vault-types",
      "vault-store",
      "vault-service",
      "vault-canister",
      "kinic-sqlite-compat",
      "passkey-auth",
    ].flatMap((name) => ["-p", name]),
  ],
  { cwd: dir, env: buildEnv, stdio: "inherit" },
);
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
    env: buildEnv,
    stdio: "inherit",
  },
);
writeFileSync(
  join(root, `target/${output}.wasm`),
  readFileSync(
    join(
      root,
      "target/vault-restore-quota-baseline-build/wasm32-unknown-unknown/release/vault_canister.wasm",
    ),
  ),
);
console.log(
  `Synthetic other-owner quota restore baseline ${commit}: target/${output}.wasm`,
);

const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(
  join(root, `target/${output}.json`),
  JSON.stringify(
    {
      source_commit: commit,
      deployable: false,
      source_archive_sha256: digest(archive),
      fixture: "pocketic-tests/fixtures/vault-incident-fill.rs",
      fixture_sha256: digest(
        join(root, "pocketic-tests/fixtures/vault-incident-fill.rs"),
      ),
      wasm_sha256: digest(join(root, `target/${output}.wasm`)),
      cargo_lock_sha256: digest(join(dir, "Cargo.lock")),
      rustc: execFileSync("rustc", ["--version"], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
      assets:
        "Existing local vaultbrowser/dist bundle; backend acceptance only, no frontend provenance claim",
    },
    null,
    2,
  ) + "\n",
);
