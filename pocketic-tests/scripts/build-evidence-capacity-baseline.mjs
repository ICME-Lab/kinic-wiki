// Build the immutable pre-capacity schema as a real Wasm upgrade fixture.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const baseline = "3bec30e8c454edc09b2a7d7a1ebc29c3cd79cfcb";
const source = mkdtempSync(join(root, ".evidence-capacity-baseline-"));
// Historical crates must not overwrite the current workspace's compiled packages.
const target = join(root, "target/evidence-capacity-baseline-build");
const environment = { ...process.env, CARGO_TARGET_DIR: target };
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete environment[name];
try {
  const archive = join(source, "source.tar");
  execFileSync("git", ["-C", root, "archive", "--format=tar", "--output", archive, baseline], { env: environment });
  execFileSync("tar", ["-xf", archive, "-C", source]);
  rmSync(archive);
  execFileSync("cargo", ["build", "-p", "vfs-canister", "--target", "wasm32-unknown-unknown", "--release", "--locked", "--offline"], { cwd: source, env: environment, stdio: "inherit" });
  const output = join(root, "target/evidence-capacity-baseline.wasm");
  writeFileSync(output, readFileSync(join(target, "wasm32-unknown-unknown/release/vfs_canister.wasm")));
  console.log(`Old-schema fixture ${baseline}: ${output}`);
} finally { rmSync(source, { recursive: true, force: true }); }
