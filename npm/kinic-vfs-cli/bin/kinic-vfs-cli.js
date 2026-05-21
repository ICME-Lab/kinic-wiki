#!/usr/bin/env node
// Where: npm/kinic-vfs-cli/bin/kinic-vfs-cli.js
// What: npm executable wrapper for the release-built kinic-vfs-cli binary.
// Why: npm users need a stable JS entrypoint while the real CLI remains Rust.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const binaryPath = path.resolve(__dirname, "..", "vendor", "kinic-vfs-cli");

if (!fs.existsSync(binaryPath)) {
  console.error("kinic-vfs-cli binary is missing. Reinstall the npm package to download it.");
  process.exit(127);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`failed to execute kinic-vfs-cli: ${error.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
