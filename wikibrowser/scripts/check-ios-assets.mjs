import assert from "node:assert/strict";
import { existsSync } from "node:fs";

for (const asset of ["app-icon.webp", "save-from-safari.webp", "browse-knowledge.webp", "ask-with-sources.webp"]) {
  assert.ok(existsSync(new URL(`../public/ios/${asset}`, import.meta.url)), `missing public iOS asset: ${asset}`);
}

console.log("Public iOS assets OK");
