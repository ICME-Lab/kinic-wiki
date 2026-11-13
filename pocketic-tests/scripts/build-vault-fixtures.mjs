// Current source only. All outputs here are NONDEPLOYABLE test fixtures.
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
const out = join(root, "target/vault-ii-acceptance");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const corePaths = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "crates/vault_canister",
  "crates/vault_types",
  "crates/vault_store",
  "crates/vault_service",
  "crates/kinic_sqlite_compat",
];
if (
  execFileSync("git", ["diff", "HEAD", "--", ...corePaths], { cwd: root })
    .length
)
  throw Error(
    "Commit current backend changes before building archived fixtures",
  );
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
for (const name of ["state", "old-schema"]) {
  const dir = join(out, "source-" + name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = (cmd, args, options = {}) =>
    execFileSync(cmd, args, { cwd: dir, stdio: "inherit", ...options });
  const archive = join(dir, "source.tar");
  run(
    "git",
    [
      "archive",
      "--format=tar",
      "--output",
      archive,
      head,
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "crates/vault_canister",
      "crates/vault_types",
      "crates/vault_store",
      "crates/vault_service",
      "crates/kinic_sqlite_compat",
    ],
    { cwd: root },
  );
  run("tar", ["-xf", archive, "-C", dir]);
  writeFileSync(
    join(dir, "Cargo.toml"),
    readFileSync(join(dir, "Cargo.toml"), "utf8")
      .replace(
        /members = \[[\s\S]*?\]/,
        'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat"]',
      )
      .replace('ic-agent = { path = "vendor/ic-agent" }', ""),
  );
  cpSync(join(root, "vaultbrowser/dist"), join(dir, "vaultbrowser/dist"), {
    recursive: true,
  });
  const lib = join(dir, "crates/vault_canister/src/lib.rs");
  const fixture = join(
    root,
    "pocketic-tests/fixtures",
    name === "state" ? "vault-state-controls.rs" : "vault-old-schema.rs",
  );
  if (name === "state")
    writeFileSync(
      lib,
      readFileSync(lib, "utf8") + "\n" + readFileSync(fixture, "utf8"),
    );
  else {
    const before = readFileSync(lib, "utf8"),
      hook = "fn init() {\n    initialize()\n}";
    if (!before.includes(hook)) throw Error("Current init hook changed");
    writeFileSync(lib, before.replace(hook, readFileSync(fixture, "utf8")));
    const state = join(dir, "crates/vault_canister/src/state.rs");
    writeFileSync(
      state,
      readFileSync(state, "utf8") +
        `
#[cfg(target_arch = "wasm32")]
pub fn fixture_old_schema(version:u8) {
 DB.with(|db| { let handle=MEMORY.with(|m|ic_sqlite_vfs::DbHandle::init(m.borrow().get(ic_sqlite_vfs::MemoryId::new(0)))).unwrap(); db.set(Some(handle)); });
 transaction(|db| db.execute_batch(&format!("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('old format must remain unchanged'); PRAGMA user_version={version};")).map_err(|_|Error::Storage)).unwrap();
}
`,
    );
  }
  const env = { ...process.env, CARGO_TARGET_DIR: join(out, "fixture-build") };
  for (const key of [
    "VAULT_LOCAL_ORIGIN",
    "VAULT_LOCAL_HOST",
    "VAULT_LOCAL_II",
    "RUSTFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
  ])
    delete env[key];
  // Shared cache still rebuilds each distinct source directory.
  run(
    "cargo",
    [
      "build",
      "-p",
      "vault-canister",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--offline",
      "--features",
      "synthetic-funding-test-only",
    ],
    { env },
  );
  const output = join(out, "vault-" + name + ".wasm");
  cpSync(
    join(
      env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release/vault_canister.wasm",
    ),
    output,
  );
  writeFileSync(
    join(out, name + ".json"),
    JSON.stringify(
      {
        source_commit: head,
        source_archive_sha256: digest(archive),
        cargo_lock_sha256: digest(join(dir, "Cargo.lock")),
        builder_sha256: digest(import.meta.filename),
        fixture_sha256: digest(fixture),
        wasm_sha256: digest(output),
        funding_mode: "synthetic-test-only",
        deployable: false,
      },
      null,
      2,
    ) + "\n",
  );
}
