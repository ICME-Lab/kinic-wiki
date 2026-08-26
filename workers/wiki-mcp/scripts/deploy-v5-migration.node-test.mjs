import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deployV5Migration, v5MigrationSteps } from "./deploy-v5-migration.mjs";

const DEPLOYMENT_CONFIGS = [
  "wrangler.staging.jsonc",
  "wrangler.private.jsonc",
  "wrangler.staging-v5-unbind.jsonc",
  "wrangler.private-v5-unbind.jsonc"
];

test("keeps the review identity principal out of deployment vars", () => {
  for (const config of DEPLOYMENT_CONFIGS) {
    const source = readFileSync(new URL(`../${config}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /MCP_REVIEW_IDENTITY_PRINCIPAL/u, config);
  }
});

for (const target of ["staging", "private"]) {
  test(`runs the ${target} V5 migration in order`, () => {
    const calls = [];
    deployV5Migration(target, {
      run(command, args) {
        calls.push([command, args]);
        return { status: 0 };
      },
      log() {}
    });
    assert.deepEqual(calls, v5MigrationSteps(target).map(({ command, args }) => [command, args]));
  });
}

test("stops before deployment when a V5 dry run fails", () => {
  let calls = 0;
  assert.throws(
    () => deployV5Migration("staging", {
      run() {
        calls += 1;
        return { status: calls === 2 ? 1 : 0 };
      },
      log() {}
    }),
    /transitional configuration dry run failed/u
  );
  assert.equal(calls, 2);
});

test("reports the explicit retry after the final V5 deployment fails", () => {
  let calls = 0;
  const total = v5MigrationSteps("private").length;
  assert.throws(
    () => deployV5Migration("private", {
      run() {
        calls += 1;
        return { status: calls === total ? 1 : 0 };
      },
      log() {}
    }),
    /transitional version remains active.*wrangler deploy --config wrangler\.private\.jsonc/us
  );
  assert.equal(calls, total);
});
