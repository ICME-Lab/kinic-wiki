// Where: scripts/check-staging-worker-deploy.mjs
// What: Verify the staging Worker source guard rejects stale and accidental worktrees.
// Why: The deploy command must fail before Wrangler can replace the complete staging Worker.

import assert from "node:assert/strict";
import { checkWorkerDeploySource, REQUIRED_PUBLIC_NODE_FILES } from "./staging/check_worker_deploy_source.mjs";

assert.deepEqual(checkWorkerDeploySource({ run: successfulRun(), fileExists: () => true }), {
  head: "feature123",
  upstream: "main456",
  dirty: false
});

assert.throws(
  () => checkWorkerDeploySource({ run: successfulRun({ fetchStatus: 1 }), fileExists: () => true }),
  /could not fetch origin\/main/
);
assert.throws(
  () => checkWorkerDeploySource({ run: successfulRun({ ancestorStatus: 1 }), fileExists: () => true }),
  /HEAD feature123 does not contain current origin\/main main456/
);
assert.throws(
  () => checkWorkerDeploySource({ run: successfulRun({ conflicts: "wikibrowser/app/page.tsx" }), fileExists: () => true }),
  /unresolved paths remain/
);
assert.throws(
  () => checkWorkerDeploySource({ run: successfulRun({ worktree: " M wikibrowser/app/page.tsx" }), fileExists: () => true }),
  /KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1/
);
assert.deepEqual(
  checkWorkerDeploySource({
    allowDirty: true,
    run: successfulRun({ worktree: " M wikibrowser/app/page.tsx" }),
    fileExists: () => true
  }),
  { head: "feature123", upstream: "main456", dirty: true }
);
assert.throws(
  () =>
    checkWorkerDeploySource({
      run: successfulRun(),
      fileExists: (path) => !path.endsWith(REQUIRED_PUBLIC_NODE_FILES[0])
    }),
  /public-node files are missing/
);
assert.throws(
  () => checkWorkerDeploySource({ run: successfulRun({ publicCheckStatus: 1 }), fileExists: () => true }),
  /public-node regression check failed/
);

console.log("Staging Worker deploy source guard OK");

function successfulRun({
  fetchStatus = 0,
  ancestorStatus = 0,
  conflicts = "",
  worktree = "",
  publicCheckStatus = 0
} = {}) {
  return (command, args) => {
    const operation = `${command} ${args.join(" ")}`;
    if (operation === "git fetch --quiet origin main") return result(fetchStatus);
    if (operation === "git rev-parse --short HEAD") return result(0, "feature123\n");
    if (operation === "git rev-parse --short FETCH_HEAD") return result(0, "main456\n");
    if (operation === "git merge-base --is-ancestor FETCH_HEAD HEAD") return result(ancestorStatus);
    if (operation === "git diff --name-only --diff-filter=U") return result(0, `${conflicts}\n`);
    if (operation === "git status --porcelain=v1 --untracked-files=all") return result(0, `${worktree}\n`);
    if (command === process.execPath && args[0].endsWith("check-public-node-page.mjs")) {
      return result(publicCheckStatus);
    }
    throw new Error(`unexpected command: ${operation}`);
  };
}

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}
