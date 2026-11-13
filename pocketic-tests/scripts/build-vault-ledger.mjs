import { createHash } from "node:crypto";
// Compile a separate synthetic ledger. No production source or feature is modified.
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = join(root, "target/vault-ledger-fixture");
mkdirSync(join(dir, "src"), {
  recursive: true,
});
copyFileSync(
  join(root, "pocketic-tests/fixtures/vault-ledger.rs"),
  join(dir, "src/lib.rs"),
);
writeFileSync(
  join(dir, "Cargo.toml"),
  '[workspace]\n[package]\nname="vault-ledger-fixture"\nversion="0.1.0"\nedition="2024"\n[lib]\ncrate-type=["cdylib"]\n[dependencies]\ncandid="=0.10.26"\nic-cdk="=0.20.1"\nserde={version="=1.0.228",features=["derive"]}\n',
);
copyFileSync(join(root, "Cargo.lock"), join(dir, "Cargo.lock"));
execFileSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    join(dir, "Cargo.toml"),
    "--release",
    "--offline",
    "--target",
    "wasm32-unknown-unknown",
  ],
  {
    env: {
      ...process.env,
      CARGO_TARGET_DIR: join(root, "target"),
    },
    stdio: "inherit",
  },
);

const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(
  join(dir, "provenance.json"),
  JSON.stringify(
    {
      deployable: false,
      funding_mode: "synthetic-test-only",
      source_sha256: sha(join(dir, "src/lib.rs")),
      lock_sha256: sha(join(dir, "Cargo.lock")),
      wasm_sha256: sha(
        join(
          root,
          "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
        ),
      ),
    },
    null,
    2,
  ) + "\n",
);
