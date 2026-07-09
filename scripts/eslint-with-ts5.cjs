// Where: scripts/eslint-with-ts5.cjs
// What: Runs the package-local ESLint CLI while pinning bare `typescript` imports to TS 5.9.3.
// Why: @typescript-eslint is not TS7-compatible yet, but typecheck/build should keep using TS7.
"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const cwdRequirePaths = [process.cwd()];
let compatTypescriptEntry;

try {
  compatTypescriptEntry = require.resolve("typescript-eslint-compat", { paths: [__dirname] });
} catch (error) {
  throw new Error(`typescript-eslint-compat is required for lint: ${error instanceof Error ? error.message : String(error)}`);
}

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function eslintTs5ResolveFilename(request, parent, isMain, options) {
  if (request === "typescript") {
    return compatTypescriptEntry;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const eslintPackageJsonPath = require.resolve("eslint/package.json", { paths: cwdRequirePaths });
const eslintPackageJson = JSON.parse(fs.readFileSync(eslintPackageJsonPath, "utf8"));
const eslintBin = typeof eslintPackageJson.bin === "string" ? eslintPackageJson.bin : eslintPackageJson.bin?.eslint;

if (typeof eslintBin !== "string" || eslintBin.length === 0) {
  throw new Error("eslint package does not expose an eslint bin entry");
}

require(path.resolve(path.dirname(eslintPackageJsonPath), eslintBin));
