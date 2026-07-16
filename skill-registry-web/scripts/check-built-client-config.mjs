import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedCanisterId = process.argv[2]?.trim();
assert.ok(expectedCanisterId, "expected canister ID argument is required");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientDirectory = path.join(packageRoot, "dist/client");
const assets = await clientAssetFiles(clientDirectory);
assert.ok(assets.length > 0, "dist/client does not contain any built client assets");

let configuredAsset = null;
for (const asset of assets) {
  const source = await readFile(asset, "utf8");
  if (source.includes(expectedCanisterId)) {
    configuredAsset = path.relative(packageRoot, asset);
    break;
  }
}

assert.ok(
  configuredAsset,
  `built client does not contain configured canister ID ${expectedCanisterId}`,
);
process.stdout.write(`Built client configuration found in ${configuredAsset}\n`);

async function clientAssetFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await clientAssetFiles(entryPath));
    } else if (/\.(?:js|mjs|html)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}
