// Where: scripts/next-with-ts5.cjs
// What: Runs the package-local Next CLI while pinning Next's internal TypeScript imports to TS 5.9.3.
// Why: Next 16.2.6 still probes `typescript/lib/typescript.js`, while package-local typecheck uses TS7.
"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const cwdRequirePaths = [process.cwd()];
let compatTypescriptEntry;
let compatTypescriptPackageJson;
let compatTypescriptLegacyEntry;

try {
  compatTypescriptEntry = require.resolve("typescript-eslint-compat", { paths: [__dirname] });
  compatTypescriptPackageJson = require.resolve("typescript-eslint-compat/package.json", { paths: [__dirname] });
  compatTypescriptLegacyEntry = require.resolve("typescript-eslint-compat/lib/typescript.js", { paths: [__dirname] });
} catch (error) {
  throw new Error(`typescript-eslint-compat is required for Next build: ${error instanceof Error ? error.message : String(error)}`);
}

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function nextTs5ResolveFilename(request, parent, isMain, options) {
  if (request === "typescript") {
    return compatTypescriptEntry;
  }
  if (request === "typescript/package.json") {
    return compatTypescriptPackageJson;
  }
  if (request === "typescript/lib/typescript.js") {
    return compatTypescriptLegacyEntry;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const nextPackageJsonPath = require.resolve("next/package.json", { paths: cwdRequirePaths });
const nextPackageJson = JSON.parse(fs.readFileSync(nextPackageJsonPath, "utf8"));
const nextBin = typeof nextPackageJson.bin === "string" ? nextPackageJson.bin : nextPackageJson.bin?.next;

if (typeof nextBin !== "string" || nextBin.length === 0) {
  throw new Error("next package does not expose a next bin entry");
}

require(path.resolve(path.dirname(nextPackageJsonPath), nextBin));
