// Exact current production assets/Wasm; isolated outputs, no local-origin flags.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, "target/vault-ii-acceptance");
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  CARGO_TARGET_DIR:
    process.env.VAULT_BUILD_CACHE ?? resolve(out, "production-build"),
};
for (const key of [
  "VAULT_LOCAL_ORIGIN",
  "VAULT_LOCAL_HOST",
  "VAULT_LOCAL_II",
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
])
  delete env[key];
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, env, stdio: "inherit" });
run("pnpm", ["--dir", "vaultbrowser", "build"]);
run("cargo", [
  "build",
  "-p",
  "vault-canister",
  "-p",
  "vfs-canister",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--locked",
]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const assets = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else assets[path.slice(root.length + 1)] = sha(readFileSync(path));
  }
}
walk(resolve(root, "vaultbrowser/dist"));
const artifacts = {};
for (const name of ["vault_canister", "vfs_canister"]) {
  const path = resolve(out, name + ".wasm");
  copyFileSync(
    resolve(
      env.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown/release",
      name + ".wasm",
    ),
    path,
  );
  artifacts[name] = { path, sha256: sha(readFileSync(path)) };
}
writeFileSync(
  resolve(out, "production.json"),
  JSON.stringify(
    {
      source_commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      diff_sha256: sha(
        execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: root }),
      ),
      funding_mode: "unavailable",
      assets,
      artifacts,
    },
    null,
    2,
  ) + "\n",
);
