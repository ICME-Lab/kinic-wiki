import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWorkerSecrets, secretFileNames, preserveSecretBindings } from "./secrets.mjs";

function withSecrets(data, action) {
  const dir = mkdtempSync(join(tmpdir(), "kinic-cf-secrets-test-"));
  const previous = process.env.CLOUDFLARE_SECRETS_FILE;
  try {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    process.env.CLOUDFLARE_SECRETS_FILE = file;
    action();
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_SECRETS_FILE;
    else process.env.CLOUDFLARE_SECRETS_FILE = previous;
    rmSync(dir, { recursive: true });
  }
}
test("complete external secret names permit provisioning before a Worker exists", () => {
  withSecrets({ TOKEN: "fixture-value" }, () => {
    assert.deepEqual(secretFileNames(), new Set(["TOKEN"]));
    assertWorkerSecrets("/does-not-exist", "worker", ["TOKEN"]);
  });
});
test("empty and malformed secret values fail closed", () => {
  for (const data of [{ TOKEN: "" }, { TOKEN: "  " }, { TOKEN: 123 }, [], null]) {
    withSecrets(data, () => assert.throws(() => secretFileNames()));
  }
});

test("existing optional secrets survive while resource bindings remain unchanged", () => {
  const worker = { name: "wiki", env: { DB: { type: "d1", id: "fixture" }, REQUIRED: { type: "secret" } } };
  const result = preserveSecretBindings(worker, ["OPTIONAL", "REQUIRED"]);
  assert.deepEqual(result.env.OPTIONAL, { type: "secret" });
  assert.deepEqual(result.env.DB, worker.env.DB);
  assert.equal(worker.env.OPTIONAL, undefined);
  assert.throws(() => preserveSecretBindings(worker, ["DB"]), /conflicts/);
});
