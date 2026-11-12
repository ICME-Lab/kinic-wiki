// Backend upgrade provenance, built from reachable source archives, never worktrees.
// Assets deliberately come from the current bundle; browser acceptance uses current Wasm.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const baselines = JSON.parse(
  readFileSync(join(root, "pocketic-tests/fixtures/vault-baselines.json")),
);
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...options });
for (const [name, commit] of Object.entries(baselines)) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name))
    continue;
  run("git", ["merge-base", "--is-ancestor", commit, "HEAD"]);
  const dir = join(root, "target/vault-baselines", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "source.tar");
  run("git", [
    "archive",
    "--format=tar",
    "--output",
    archive,
    commit,
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates/vault_canister",
    "crates/vault_types",
    "crates/vault_store",
    "crates/vault_service",
    "crates/kinic_sqlite_compat",
    "vendor/passkey-auth",
  ]);
  run("tar", ["-xf", archive, "-C", dir]);
  const manifest = readFileSync(join(dir, "Cargo.toml"), "utf8")
    .replace(
      /members = \[[\s\S]*?\]/,
      'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat"]',
    )
    .replace('ic-agent = { path = "vendor/ic-agent" }', "");
  writeFileSync(join(dir, "Cargo.toml"), manifest);
  cpSync(join(root, "vaultbrowser/dist"), join(dir, "vaultbrowser/dist"), {
    recursive: true,
  });
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: join(root, "target/vault-baselines-build"),
  };
  for (const key of [
    "VAULT_LOCAL_ORIGIN",
    "VAULT_LOCAL_HOST",
    "VAULT_LOCAL_II",
  ])
    delete env[key];
  // Cargo archives preserve old mtimes; never reuse local-crate fingerprints across commits.
  run(
    "cargo",
    [
      "clean",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "-p",
      "vault-types",
      "-p",
      "vault-store",
      "-p",
      "vault-service",
      "-p",
      "vault-canister",
      "-p",
      "kinic-sqlite-compat",
      "-p",
      "passkey-auth",
    ],
    { cwd: dir, env },
  );
  run(
    "cargo",
    [
      "build",
      "-p",
      "vault-canister",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      ...(name === "vault-dedicated-upload-v5"
        ? ["--features", "synthetic-funding-test-only"]
        : []),
    ],
    { cwd: dir, env },
  );
  const output = join(root, `target/${name}.wasm`);
  cpSync(
    join(
      env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release/vault_canister.wasm",
    ),
    output,
  );
  writeFileSync(
    join(root, `target/${name}.json`),
    JSON.stringify(
      {
        source_commit: commit,
        ...(name === "vault-dedicated-upload-v5"
          ? { funding_mode: "synthetic-test-only", deployable: false }
          : {}),
        source_archive_sha256: digest(archive),
        wasm_sha256: digest(output),
        cargo_lock_sha256: digest(join(dir, "Cargo.lock")),
        rustc: run("rustc", ["--version"], {
          cwd: dir,
          encoding: "utf8",
          stdio: "pipe",
        }).trim(),
        assets: "Current vaultbrowser/dist, not historical frontend provenance",
        manifest_adjustment:
          "Restrict workspace to Vault crates; remove unused ic-agent patch",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`BASELINE ${name} source=${commit} sha256=${digest(output)}`);
}
