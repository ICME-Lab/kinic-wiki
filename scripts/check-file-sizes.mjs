// Where: scripts/check-file-sizes.mjs
// What: Ratchet guard against oversized source files.
// Why: The 2026-07 refactor split several 2,000+ line monoliths; this stops new ones.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RUST_LIMIT = 2000;
const TS_LIMIT = 1100;

// Existing files over the limit, frozen at their current size.
// Shrink or split them to remove entries; never raise a ratchet value.
const RATCHET = new Map([
  ["crates/vfs_canister/src/lib.rs", 2518],
  ["crates/vfs_canister/src/tests.rs", 3666],
  ["crates/vfs_runtime/tests/database_service.rs", 5483],
  ["crates/vfs_store/tests/fs_store_basic.rs", 3012],
  ["crates/vfs_store/tests/fs_store_vfs.rs", 1771],
  ["crates/vfs_store/tests/fs_store_sync.rs", 1574],
  ["crates/vfs_cli_app/src/skill_registry_tests.rs", 2027],
  ["workers/wiki-mcp/src/index.ts", 1256],
]);

const files = execSync("git ls-files '*.rs' '*.ts' '*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((path) => !path.endsWith(".d.ts"));

const failures = [];
for (const path of files) {
  const limit = path.endsWith(".rs") ? RUST_LIMIT : TS_LIMIT;
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  const ratchet = RATCHET.get(path);
  if (ratchet !== undefined) {
    if (lines > ratchet) {
      failures.push(`${path}: ${lines} lines exceeds its ratchet of ${ratchet}; shrink it instead of growing it`);
    }
    continue;
  }
  if (lines > limit) {
    failures.push(`${path}: ${lines} lines exceeds the ${limit}-line limit; split it or add a justified ratchet entry`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`File size guard OK (${files.length} files)`);
