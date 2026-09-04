// Where: wikibrowser/scripts/check-image-optimization.mjs
// What: Verify that the Vite app cannot re-enable framework or Cloudflare image transforms.
// Why: A public framework image endpoint previously caused millions of billed transformations.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wranglerConfig = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

assert.equal(Object.hasOwn(wranglerConfig, "images"), false);
assert.equal(Object.hasOwn(packageConfig.dependencies, "next"), false);
assert.equal(Object.hasOwn(packageConfig.dependencies, "@opennextjs/cloudflare"), false);

console.log("Image optimization safeguards OK");
