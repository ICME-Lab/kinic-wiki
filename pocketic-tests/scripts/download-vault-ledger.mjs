// Reproducible official DFINITY release; never substitute a synthetic ledger.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const dir = resolve(import.meta.dirname, "../../target/tools");
mkdirSync(dir, { recursive: true });
const release = "ledger-suite-icrc-2026-03-09";
for (const [name, digest] of Object.entries({
  "ic-icrc1-ledger.wasm.gz":
    "354dd6ecfdc72b5409805b31dea22c9db11df6e14095a5a68924eb63535e6d8a",
  "ic-icrc1-archive.wasm.gz":
    "f7f48f402a128cbd18dc7734c7f149f2814c8181766f39897a66d514d47ccf11",
})) {
  const path = resolve(dir, name);
  if (!existsSync(path))
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        `https://github.com/dfinity/ic/releases/download/${release}/${name}`,
        "--output",
        path,
      ],
      { stdio: "inherit" },
    );
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== digest) throw Error(`${name}: SHA256 mismatch ${actual}`);
  console.log(`${release}/${name} SHA256 ${actual}`);
}
