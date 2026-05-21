#!/usr/bin/env node
// Where: scripts/build-icp-cli-login.mjs
// What: Generate the canister-hosted CLI login HTML from the shared II helper.
// Why: The canister serves static certified HTML, but auth constants and validation stay shared.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { build } = require(resolve(root, "extensions/wiki-clipper/node_modules/esbuild"));
const entryPoint = resolve(root, "crates/vfs_canister/src/icp_cli_login.js");
const nodeModulesPath = resolve(root, "extensions/wiki-clipper/node_modules");
const templatePath = resolve(root, "crates/vfs_canister/src/icp_cli_login.template.html");
const outputPath = resolve(root, "crates/vfs_canister/src/icp_cli_login.html");

const [templateSource, bundled] = await Promise.all([
  readFile(templatePath, "utf8"),
  build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020", "chrome120", "firefox115", "safari17"],
    minify: true,
    legalComments: "none",
    nodePaths: [nodeModulesPath],
    logLevel: "silent"
  })
]);

const script = bundled.outputFiles[0]?.text;
if (!script) {
  throw new Error("esbuild did not return bundled login script");
}
const output = templateSource.replace("/* __ICP_CLI_LOGIN_SCRIPT__ */", script.trim());

if (output === templateSource) {
  throw new Error("template placeholder was not found");
}

await writeFile(outputPath, `${output.trimEnd()}\n`);
console.log(`generated ${outputPath}`);
