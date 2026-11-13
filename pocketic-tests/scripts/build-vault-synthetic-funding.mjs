// NONDEPLOYABLE fixture: production-origin policy coverage with synthetic funding enabled.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const target = resolve(root, "target/vault-synthetic-funding-build");
const env = { ...process.env, CARGO_TARGET_DIR: target };
for (const key of ["VAULT_LOCAL_ORIGIN", "VAULT_LOCAL_HOST", "VAULT_LOCAL_II", "CARGO_ENCODED_RUSTFLAGS", "RUSTFLAGS"]) delete env[key];
execFileSync("cargo", ["build", "-p", "vault-canister", "--features", "synthetic-funding-test-only", "--target", "wasm32-unknown-unknown", "--release", "--locked"], { cwd: root, env, stdio: "inherit" });
const wasm = resolve(target, "wasm32-unknown-unknown/release/vault_canister.wasm");
const git = (...args) => execFileSync("git", args, { cwd: root });
const hash = value => createHash("sha256").update(value).digest("hex");
writeFileSync(resolve(target, "provenance.json"), JSON.stringify({
  funding_mode: "synthetic-test-only", deployable: false,
  origin_policy: "production-origin configuration for tests only",
  source_commit: git("rev-parse", "HEAD").toString().trim(),
  working_tree_diff_sha256: hash(git("diff", "--binary")),
  wasm, wasm_sha256: hash(readFileSync(wasm)),
  lock_sha256: hash(readFileSync(resolve(root, "Cargo.lock"))),
}, null, 2) + "\n");
console.log("Built NONDEPLOYABLE synthetic-funding fixture:", wasm);
