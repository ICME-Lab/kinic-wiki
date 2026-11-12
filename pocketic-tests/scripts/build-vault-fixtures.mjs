// Isolated source archives only; no fixture hooks enter production Wasm.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const pinned = JSON.parse(readFileSync(join(root, "pocketic-tests/fixtures/vault-baselines.json")));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const variants = [
  { name: "vault-v6-baseline", commit: pinned["vault-v6-baseline"] },
  { name: "vault-capacity-baseline", commit: head, fixture: "vault-capacity-init.rs", hook: "init" },
  { name: "vault-restore-quota-baseline", commit: head, fixture: "vault-incident-fill.rs", hook: "post_upgrade" },
];
for (const v of variants) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(v.name)) continue;
  const dir = join(root, "target/vault-fixtures", v.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: dir, stdio: "inherit", ...options });
  run("git", ["merge-base", "--is-ancestor", v.commit, "HEAD"], { cwd: root });
  const archive = join(dir, "source.tar");
  run("git", ["archive", "--format=tar", "--output", archive, v.commit,
    "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates/vault_canister",
    "crates/vault_types", "crates/vault_store", "crates/vault_service", "crates/kinic_sqlite_compat", "vendor/passkey-auth"], { cwd: root });
  run("tar", ["-xf", archive, "-C", dir]);
  const manifest = readFileSync(join(dir, "Cargo.toml"), "utf8")
    .replace(/members = \[[\s\S]*?\]/, 'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat"]')
    .replace('ic-agent = { path = "vendor/ic-agent" }', "");
  writeFileSync(join(dir, "Cargo.toml"), manifest);
  cpSync(join(root, "vaultbrowser/dist"), join(dir, "vaultbrowser/dist"), { recursive: true });
  if (v.fixture) {
    const lib = join(dir, "crates/vault_canister/src/lib.rs");
    const before = readFileSync(lib, "utf8"), hook = `fn ${v.hook}() {\n    initialize()\n}`;
    if (!before.includes(hook)) throw Error(`Fixture hook changed: ${v.name}`);
    writeFileSync(lib, before.replace(hook, readFileSync(join(root, "pocketic-tests/fixtures", v.fixture), "utf8")));
  }
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, "target/vault-fixtures-build") };
  for (const key of ["VAULT_LOCAL_ORIGIN", "VAULT_LOCAL_HOST", "VAULT_LOCAL_II"]) delete env[key];
  // Archives retain mtimes: invalidate local crates when switching pinned/current source.
  run("cargo", ["clean", "--release", "--target", "wasm32-unknown-unknown",
    ...["vault-types", "vault-store", "vault-service", "vault-canister", "kinic-sqlite-compat", "passkey-auth"].flatMap(name => ["-p", name])], { env });
  run("cargo", ["build", "-p", "vault-canister", "--target", "wasm32-unknown-unknown", "--release", "--locked", "--features", "synthetic-funding-test-only"], { env });
  const output = join(root, `target/${v.name}.wasm`);
  cpSync(join(env.CARGO_TARGET_DIR, "wasm32-unknown-unknown/release/vault_canister.wasm"), output);
  writeFileSync(join(root, `target/${v.name}.json`), JSON.stringify({
    source_commit: v.commit, source_archive_sha256: digest(archive),
    wasm_sha256: digest(output), cargo_lock_sha256: digest(join(dir, "Cargo.lock")),
    fixture: v.fixture ?? null,
    fixture_sha256: v.fixture ? digest(join(root, "pocketic-tests/fixtures", v.fixture)) : null,
    funding_mode: "synthetic-test-only", deployable: false,
    rustc: run("rustc", ["--version"], { encoding: "utf8", stdio: "pipe" }).trim(),
    assets: "Current vaultbrowser/dist; backend fixture only",
  }, null, 2) + "\n");
  console.log(`FIXTURE ${v.name} source=${v.commit} sha256=${digest(output)}`);
}
