import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const baselines = JSON.parse(
  readFileSync(resolve(root, "pocketic-tests/fixtures/vault-baselines.json")),
);
export function verifyVaultBaseline(path) {
  const name = basename(path, ".wasm");
  assert.ok(baselines[name], `Unpinned baseline ${name}`);
  const metadata = JSON.parse(
    readFileSync(resolve(root, `target/${name}.json`)),
  );
  assert.equal(metadata.source_commit, baselines[name]);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex"),
    metadata.wasm_sha256,
  );
  return metadata;
}
