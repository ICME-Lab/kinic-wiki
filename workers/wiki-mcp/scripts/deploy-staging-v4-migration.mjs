#!/usr/bin/env node
// Where: workers/wiki-mcp/scripts/deploy-staging-v4-migration.mjs
// What: Perform the one-time V3-to-V4 Durable Object staging deployment in two explicit phases.
// Why: Cloudflare rejects deleting a Durable Object class while the active Worker version still binds it.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const V4_MIGRATION_STEPS = [
  {
    label: "staging source validation",
    command: "node",
    args: ["../../scripts/staging/check_worker_deploy_source.mjs"]
  },
  {
    label: "transitional configuration dry run",
    command: "pnpm",
    args: ["run", "build:staging:v4-unbind"]
  },
  {
    label: "V4 configuration dry run",
    command: "pnpm",
    args: ["run", "build:staging"]
  },
  {
    label: "transitional V3 binding removal",
    command: "pnpm",
    args: ["exec", "wrangler", "deploy", "--config", "wrangler.staging-v4-unbind.jsonc"]
  },
  {
    label: "V4 Durable Object deployment",
    command: "pnpm",
    args: ["exec", "wrangler", "deploy", "--config", "wrangler.staging.jsonc"]
  }
];

export function deployStagingV4Migration({ run = runCommand, log = console.error } = {}) {
  for (const [index, step] of V4_MIGRATION_STEPS.entries()) {
    log(`MCP V4 migration: ${step.label}`);
    const result = run(step.command, step.args);
    if (result.status === 0) continue;

    if (index === V4_MIGRATION_STEPS.length - 1) {
      throw new Error(
        "V4 deploy failed after the transitional version removed MCP_AUTH_STATE. " +
          "That transitional version remains active; fix the error and retry " +
          "`pnpm exec wrangler deploy --config wrangler.staging.jsonc`."
      );
    }
    throw new Error(`${step.label} failed; no later migration step was run`);
  }
}

function runCommand(command, args) {
  return spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    deployStagingV4Migration();
  } catch (error) {
    console.error(`MCP V4 migration blocked: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
