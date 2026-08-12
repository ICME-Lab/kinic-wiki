import assert from "node:assert/strict";
import test from "node:test";
import {
  deployStagingV4Migration,
  V4_MIGRATION_STEPS
} from "./deploy-staging-v4-migration.mjs";

test("runs the V4 migration guard, dry runs, and deploys in order", () => {
  const calls = [];
  deployStagingV4Migration({
    run(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    },
    log() {}
  });

  assert.deepEqual(
    calls,
    V4_MIGRATION_STEPS.map(({ command, args }) => [command, args])
  );
});

test("stops before deployment when a dry run fails", () => {
  const calls = [];
  assert.throws(
    () =>
      deployStagingV4Migration({
        run(command, args) {
          calls.push([command, args]);
          return { status: calls.length === 2 ? 1 : 0 };
        },
        log() {}
      }),
    /transitional configuration dry run failed/u
  );
  assert.equal(calls.length, 2);
});

test("reports the explicit retry after the final V4 deployment fails", () => {
  let callCount = 0;
  assert.throws(
    () =>
      deployStagingV4Migration({
        run() {
          callCount += 1;
          return { status: callCount === V4_MIGRATION_STEPS.length ? 1 : 0 };
        },
        log() {}
      }),
    /transitional version remains active.*wrangler deploy --config wrangler\.staging\.jsonc/us
  );
  assert.equal(callCount, V4_MIGRATION_STEPS.length);
});
