// Build fault-injected copies without adding hooks/features to production code.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const target = join(root, "target/bekko-refill-fault-build");
mkdirSync(join(root, ".tmp-test"), { recursive: true });
const source = mkdtempSync(join(root, ".tmp-test/bekko-refill-"));
const environment = { ...process.env, CARGO_TARGET_DIR: target };
const run = () => execFileSync("cargo", ["build", "-p", "vfs-canister", "--target", "wasm32-unknown-unknown", "--release", "--locked", "--offline"], { cwd: source, env: environment, stdio: "inherit" });
const output = name => cpSync(join(target, "wasm32-unknown-unknown/release/vfs_canister.wasm"), join(root, "target", name));
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, `Fault injection anchor changed: ${from}`);
  return text.replace(from, to);
}
try {
  for (const path of ["Cargo.toml", "Cargo.lock", "crates", "vendor"]) cpSync(join(root, path), join(source, path), { recursive: true });
  for (const path of ["packages/vfs-client-core/api-guidance.json", "extensions/wiki-clipper/assets/kinic-logo-transparent.png"]) {
    mkdirSync(resolve(source, path, ".."), { recursive: true });
    cpSync(join(root, path), join(source, path));
  }
  const lib = join(source, "crates/vfs_canister/src/lib.rs");
  const refill = join(source, "crates/vfs_canister/src/bekko_refill.rs");
  const originalLib = readFileSync(lib, "utf8");
  const originalRefill = readFileSync(refill, "utf8");
  // Reuse the pinned workspace dependency graph to build a tiny separate fixture.
  writeFileSync(lib, readFileSync(join(root, "pocketic-tests/fixtures/bekko-refill-faults.rs")));
  run(); output("bekko-refill-fault-fixture.wasm");
  writeFileSync(lib, originalLib);
  // Management cannot delay deposit replies on demand. Substitute only its
  // transport with a relay that performs the real deposit before holding reply.
  writeFileSync(refill, replaceOnce(originalRefill,
    'Call::bounded_wait(Principal::management_canister(), "deposit_cycles")',
    'Call::bounded_wait(Principal::from_text("6dngc-faaaa-aaaay-aackq-cai").unwrap(), "deposit_cycles")'));
  run(); output("bekko-refill-delayed.wasm");
  writeFileSync(refill, replaceOnce(originalRefill,
    'let outcome = deposit_bekko_cycles(amount).await;',
    'let outcome = deposit_bekko_cycles(amount).await;\n        if matches!(outcome, BekkoRefillOutcome::Succeeded) { ic_cdk::trap("injected refill callback trap"); }'));
  run(); output("bekko-refill-callback-trap.wasm");
} finally { rmSync(source, { recursive: true, force: true }); }
