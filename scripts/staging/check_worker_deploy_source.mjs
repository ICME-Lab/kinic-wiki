#!/usr/bin/env node
// Where: scripts/staging/check_worker_deploy_source.mjs
// What: Refuse staging Worker deploys from stale, conflicted, or unacknowledged dirty sources.
// Why: Wrangler replaces the complete Worker with the current worktree, regardless of branch age.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const REQUIRED_PUBLIC_NODE_FILES = [
  "wikibrowser/app/p/[publicId]/page.tsx",
  "wikibrowser/components/node-publication-controls.tsx",
  "wikibrowser/lib/vfs-client.ts",
  "wikibrowser/src/routes/p.$publicId.tsx",
  "wikibrowser/app/p/[publicId]/page.test.tsx"
];

export function checkWorkerDeploySource({
  root = repoRoot,
  allowDirty = process.env.KINIC_STAGING_DEPLOY_ALLOW_DIRTY === "1",
  run = runCommand,
  fileExists = existsSync
} = {}) {
  requireSuccess(run("git", ["fetch", "--quiet", "origin", "main"], root), "could not fetch origin/main");

  const head = outputOf(run("git", ["rev-parse", "--short", "HEAD"], root), "could not resolve HEAD");
  const upstream = outputOf(
    run("git", ["rev-parse", "--short", "FETCH_HEAD"], root),
    "could not resolve fetched origin/main"
  );
  const ancestry = run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], root);
  if (ancestry.status !== 0) {
    throw new Error(`HEAD ${head} does not contain current origin/main ${upstream}; merge main before deploying`);
  }

  const conflicts = outputOf(
    run("git", ["diff", "--name-only", "--diff-filter=U"], root),
    "could not inspect unresolved paths"
  );
  if (conflicts) {
    throw new Error(`unresolved paths remain:\n${conflicts}`);
  }

  const worktree = outputOf(
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root),
    "could not inspect the worktree"
  );
  if (worktree && !allowDirty) {
    throw new Error(
      "the worktree is dirty; review git diff and rerun with KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1 to acknowledge deploying uncommitted content"
    );
  }

  const missing = REQUIRED_PUBLIC_NODE_FILES.filter((path) => !fileExists(join(root, path)));
  if (missing.length > 0) {
    throw new Error(`public-node files are missing:\n${missing.join("\n")}`);
  }

  requireSuccess(
    run(
      "pnpm",
      ["--dir", join(root, "wikibrowser"), "exec", "vitest", "run", "app/p/[publicId]/page.test.tsx"],
      root
    ),
    "public-node component test failed"
  );

  return { head, upstream, dirty: Boolean(worktree) };
}

function runCommand(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function requireSuccess(result, message) {
  if (result.status !== 0) {
    throw new Error(detail(message, result));
  }
}

function outputOf(result, message) {
  requireSuccess(result, message);
  return result.stdout.trim();
}

function detail(message, result) {
  const output = [result.stderr, result.stdout].map((value) => value?.trim()).filter(Boolean).join("\n");
  return output ? `${message}: ${output}` : message;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkWorkerDeploySource();
    console.error(
      `staging Worker deploy source validated: HEAD=${result.head} origin/main=${result.upstream} dirty=${result.dirty}`
    );
  } catch (error) {
    console.error(`staging Worker deploy blocked: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
