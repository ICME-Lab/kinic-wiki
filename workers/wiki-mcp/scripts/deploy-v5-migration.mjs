#!/usr/bin/env node
// Deploy V5 in two phases so Cloudflare sees V4 unbound before its class is deleted.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TARGETS = {
  staging: {
    unbindConfig: "wrangler.staging-v5-unbind.jsonc",
    finalConfig: "wrangler.staging.jsonc"
  },
  private: {
    unbindConfig: "wrangler.private-v5-unbind.jsonc",
    finalConfig: "wrangler.private.jsonc"
  }
};

export function v5MigrationSteps(target) {
  const config = TARGETS[target];
  if (!config) throw new Error("target must be staging or private");
  return [
    {
      label: "source validation",
      command: "node",
      args: ["../../scripts/staging/check_worker_deploy_source.mjs"]
    },
    {
      label: "transitional configuration dry run",
      command: "pnpm",
      args: ["exec", "wrangler", "deploy", "--dry-run", "--config", config.unbindConfig]
    },
    {
      label: "V5 configuration dry run",
      command: "pnpm",
      args: ["exec", "wrangler", "deploy", "--dry-run", "--config", config.finalConfig]
    },
    {
      label: "V4 binding removal",
      command: "pnpm",
      args: ["exec", "wrangler", "deploy", "--config", config.unbindConfig]
    },
    {
      label: "V5 Durable Object deployment",
      command: "pnpm",
      args: ["exec", "wrangler", "deploy", "--config", config.finalConfig]
    }
  ];
}

export function deployV5Migration(target, { run = runCommand, log = console.error } = {}) {
  const steps = v5MigrationSteps(target);
  for (const [index, step] of steps.entries()) {
    log(`MCP V5 migration (${target}): ${step.label}`);
    const result = run(step.command, step.args);
    if (result.status === 0) continue;
    if (index === steps.length - 1) {
      throw new Error(
        `V5 deploy failed after ${target} removed MCP_AUTH_STATE. ` +
          `The transitional version remains active; fix the error and retry ` +
          `\`pnpm exec wrangler deploy --config ${TARGETS[target].finalConfig}\`.`
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
    deployV5Migration(process.argv[2]);
  } catch (error) {
    console.error(`MCP V5 migration blocked: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
