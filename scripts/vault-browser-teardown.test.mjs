import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// Run the runner's actual finalizer without provisioning canisters or II.
// Only infrastructure process shutdown and the injected filesystem failure are
// substituted; the receipts, fixture files and other removals use real files.
const source = readFileSync(new URL("../pocketic-tests/scripts/run-vault-browser-acceptance.mjs", import.meta.url), "utf8");
const marker = "\n} finally {\n";
const offset = source.lastIndexOf(marker);
assert.ok(offset >= 0);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const finalize = new AsyncFunction(
  "assert", "vite", "started", "run", "project", "root", "teamEmbeds",
  "port", "wikiPort", "rmSync", "join", "createServer", "writeFileSync", "existsSync",
  source.slice(offset + marker.length).trimEnd().slice(0, -1),
);

async function scenario(teamEmbeds, failRemoval = false) {
  const root = mkdtempSync(join(tmpdir(), "vault-teardown-test-"));
  const project = join(root, "owned-network");
  mkdirSync(join(root, "target"));
  mkdirSync(join(project, "cli-home", "identity"), { recursive: true });
  writeFileSync(join(project, "controller-seed.txt"), "test-only");
  try {
    let failure;
    try {
      await finalize(assert, undefined, false, () => assert.fail("No network started"), project, root, teamEmbeds,
        0, 0, (path, options) => {
          if (failRemoval && path === project) throw Error("Injected project removal failure");
          rmSync(path, options);
        }, join, createServer, writeFileSync, existsSync);
    } catch (error) {
      failure = error;
    }
    const receipt = JSON.parse(readFileSync(join(root, "target", teamEmbeds ? "vault-team-teardown.json" : "vault-browser-teardown.json"), "utf8"));
    return { failure, receipt, projectExists: existsSync(project), seedExists: existsSync(join(project, "controller-seed.txt")) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a failed final project removal is recorded and fails acceptance", async () => {
  const result = await scenario(true, true);
  assert.ok(result.failure);
  assert.equal(result.projectExists, true);
  assert.equal(result.receipt.fixtureIdentityRemoved, true);
  assert.equal(result.seedExists, false);
  assert.ok(result.receipt.errors.some((error) => error.includes("Injected project removal failure")));
});

test("team teardown records successful removal after deleting its owned project", async () => {
  const result = await scenario(true);
  assert.equal(result.failure, undefined);
  assert.equal(result.projectExists, false);
  assert.equal(result.receipt.fixtureIdentityRemoved, true);
  assert.deepEqual(result.receipt.errors, []);
});

test("general teardown retains diagnostics while removing the fixture identity and seed", async () => {
  const result = await scenario(false);
  assert.equal(result.failure, undefined);
  assert.equal(result.projectExists, true);
  assert.equal(result.seedExists, false);
  assert.equal(result.receipt.fixtureIdentityRemoved, true);
  assert.deepEqual(result.receipt.errors, []);
});
