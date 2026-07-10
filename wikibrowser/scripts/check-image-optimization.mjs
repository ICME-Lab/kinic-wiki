// Where: wikibrowser/scripts/check-image-optimization.mjs
// What: Verify that Next.js and Cloudflare image transformation stay disabled.
// Why: A public /_next/image endpoint previously caused millions of billed transformations.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nextConfigSource = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const robotsSource = readFileSync(new URL("../app/robots.ts", import.meta.url), "utf8");
const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wranglerConfig = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

assert.match(nextConfigSource, /images:\s*\{\s*unoptimized:\s*true\s*\}/);
assert.match(robotsSource, /disallow:\s*\[[^\]]*"\/_next\/image"/);
assert.equal(Object.hasOwn(wranglerConfig, "images"), false);
assert.match(packageConfig.scripts.deploy, /wrangler deploy --minify --autoconfig false$/);
assert.match(packageConfig.scripts["deploy:production"], /wrangler deploy --minify --autoconfig false$/);

console.log("Image optimization safeguards OK");
