// NONDEPLOYABLE: discard a real ledger reply after awaiting the real transfer.
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "../..");
const dir = resolve(root, "target/vault-funding-fault/source");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: dir, stdio: "inherit", ...options });
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
run(
  "git",
  [
    "archive",
    "--format=tar",
    "--output",
    resolve(dir, "source.tar"),
    head,
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates/vault_canister",
    "crates/vault_types",
    "crates/vault_store",
    "crates/vault_service",
    "crates/kinic_sqlite_compat",
    "crates/credit_bridge_types",
  ],
  { cwd: root },
);
run("tar", ["-xf", "source.tar"]);
const cargo = resolve(dir, "Cargo.toml");
writeFileSync(
  cargo,
  readFileSync(cargo, "utf8")
    .replace(
      /members = \[[\s\S]*?\]/,
      'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat","crates/credit_bridge_types"]',
    )
    .replace('ic-agent = { path = "vendor/ic-agent" }', ""),
);
const embedded = process.env.VAULT_LEDGER_TEST_EMBEDDED === "1";
if (embedded)
  cpSync(
    resolve(root, "vaultbrowser/dist"),
    resolve(dir, "vaultbrowser/dist"),
    { recursive: true },
  );
writeFileSync(
  resolve(root, "target/vault-funding-fault/vault-candid.mjs"),
  execFileSync(
    process.env.DIDC_BIN ?? "didc",
    ["bind", "--target", "js", resolve(dir, "crates/vault_canister/vault.did")],
    { cwd: root },
  ),
);
const path = resolve(dir, "crates/vault_canister/src/funding/api.rs");
const source = readFileSync(path, "utf8"),
  needle = "    complete_payment(&p, outcome)";
if (source.split(needle).length !== 2)
  throw Error("Expected unique post-await completion hook");
writeFileSync(
  path,
  source.replace(
    needle,
    `    let outcome = if FIXTURE_DROP_REPLY.with(|drop| drop.replace(false)) { crate::funding::Outcome::Unknown } else { outcome };
${needle}`,
  ) +
    `
// Test-source only: never compiled into a deployable artifact.
thread_local! { static FIXTURE_DROP_REPLY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[ic_cdk::update]
fn fixture_drop_reply() { assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller())); FIXTURE_DROP_REPLY.with(|drop|drop.set(true)); }
`,
);
const target = resolve(root, "target/vault-funding-fault/build");
const env = { ...process.env, CARGO_TARGET_DIR: target };
for (const key of [
  "VAULT_LOCAL_ORIGIN",
  "VAULT_LOCAL_HOST",
  "VAULT_LOCAL_II",
  "CARGO_ENCODED_RUSTFLAGS",
  "RUSTFLAGS",
])
  delete env[key];
run(
  "cargo",
  [
    "build",
    "-p",
    "vault-canister",
    ...(embedded ? ["--features", "embedded-assets"] : []),
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--offline",
  ],
  { env },
);
const wasm = resolve(
  target,
  "wasm32-unknown-unknown/release/vault_canister.wasm",
);
const hash = (x) => createHash("sha256").update(x).digest("hex");
writeFileSync(
  resolve(root, "target/vault-funding-fault/provenance.json"),
  JSON.stringify(
    {
      deployable: false,
      source_commit: head,
      source_archive_sha256: hash(readFileSync(resolve(dir, "source.tar"))),
      builder_sha256: hash(readFileSync(import.meta.filename)),
      embedded_assets: embedded,
      source_lock_sha256: hash(readFileSync(resolve(root, "Cargo.lock"))),
      fixture_lock_sha256: hash(readFileSync(resolve(dir, "Cargo.lock"))),
      source_sha256: hash(readFileSync(path)),
      wasm,
      wasm_sha256: hash(readFileSync(wasm)),
      fault:
        "Discard next actual ledger response only after transfer await, before completion",
    },
    null,
    2,
  ) + "\n",
);
