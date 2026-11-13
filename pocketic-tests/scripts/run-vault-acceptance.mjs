// Current II-only suite. Each process owns its replica and teardown; no live canisters.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "../.."),
  out = resolve(root, "target/vault-ii-acceptance");
const binary = process.env.POCKET_IC_BIN;
if (!binary)
  throw Error(
    "Vault acceptance requires POCKET_IC_BIN pointing to PocketIC 16.1.0",
  );
const version = execFileSync(binary, ["--version"], {
  encoding: "utf8",
}).trim();
if (version !== "pocket-ic-server 16.1.0")
  throw Error(`Expected PocketIC16.1.0; got ${version}`);
const cases = [
  "lifecycle",
  "state",
  "capacity",
  "isolation",
  "physical-isolation",
  "certification",
];
const selected = process.argv.slice(2);
for (const name of selected)
  if (!cases.includes(name)) throw Error(`Unknown acceptance case: ${name}`);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifacts = {};
for (const path of [
  "target/vault-ii-acceptance/vault_canister.wasm",
  "target/vault-ii-acceptance/vfs_canister.wasm",
  "target/vault-ii-acceptance/vault-state.wasm",
  "target/vault-ii-acceptance/vault-old-schema.wasm",
  "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
  "target/vault-ii-acceptance/client/client.mjs",
])
  artifacts[path] = sha(readFileSync(resolve(root, path)));
const harness = {};
for (const dir of [
  "pocketic-tests/scripts",
  "pocketic-tests/helpers",
  "pocketic-tests/integration",
  "pocketic-tests/fixtures",
])
  for (const name of readdirSync(resolve(root, dir)).filter(
    (n) => n.startsWith("vault-") || n.includes("vault-"),
  ))
    harness[dir + "/" + name] = sha(readFileSync(resolve(root, dir, name)));
const report = {
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  working_tree_diff_sha256: sha(
    execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: root }),
  ),
  runtime: { binary, version, sha256: sha(readFileSync(binary)) },
  artifacts,
  harness,
  started: new Date().toISOString(),
  results: [],
};
const reportPath = resolve(
  out,
  selected.length ? "selected-runtime.json" : "runtime.json",
);
try {
  for (const name of cases.filter(
    (n) => !selected.length || selected.includes(n),
  )) {
    console.log(`RUN vault-${name}`);
    const start = Date.now();
    try {
      execFileSync(
        process.execPath,
        [`pocketic-tests/integration/vault-${name}.test.mjs`],
        { cwd: root, stdio: "inherit", env: process.env },
      );
      report.results.push({
        name,
        exit_code: 0,
        milliseconds: Date.now() - start,
      });
    } catch (error) {
      report.results.push({
        name,
        exit_code: error.status ?? -1,
        milliseconds: Date.now() - start,
      });
      throw error;
    }
  }
  console.log(
    `PASS ${report.results.length} selected current II-only acceptance cases including teardown`,
  );
} finally {
  report.finished = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
