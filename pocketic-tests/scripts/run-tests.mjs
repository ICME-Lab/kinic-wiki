// Where: pocketic-tests/scripts/run-tests.mjs
// What: Resolve PocketIC before running the Node test files.
// Why: Fresh environments should fail with an actionable setup error, not a missing binary trace.
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "..");

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePocketIcBin() {
  const candidates = [];
  if (process.env.POCKET_IC_BIN) {
    candidates.push(resolve(process.cwd(), process.env.POCKET_IC_BIN));
  }
  candidates.push(join(repoRoot, ".canbench", "pocket-ic"));

  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }

  throw new Error(
    "PocketIC runtime not found. Set POCKET_IC_BIN or run `bash scripts/setup_canbench_ci.sh` from the repository root."
  );
}

const pocketIcBin = await resolvePocketIcBin();
const testFiles = (await readdir(join(packageRoot, "tests")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("tests", name));

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: packageRoot,
  env: {
    ...process.env,
    POCKET_IC_BIN: pocketIcBin,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
