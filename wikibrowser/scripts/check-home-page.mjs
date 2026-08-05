import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

assert.match(home, /AI memory with visible sources/);
assert.match(home, /AI memory that keeps its sources\./);
assert.match(home, /href="\/dashboard"[\s\S]*Open Dashboard/, "hero must lead to the Dashboard");
assert.match(home, /href="#memory-flow"[\s\S]*See how it works/, "hero must link to the memory flow");
assert.match(home, /<MemoryMap \/>/, "hero must render the memory map");
assert.match(home, /label="iOS" marker="IOS"[\s\S]*label="Clipper" marker="WEB"[\s\S]*label="CLI" marker="CLI"/, "memory map must give each capture input a distinct marker");
assert.match(home, /path="\/Sources"[\s\S]*path="\/Knowledge"[\s\S]*path="cited answer"/, "memory map must preserve the evidence route");
assert.match(home, /path="cited answer"[^>]*citation/, "cited answer must retain its restrained citation accent");
assert.doesNotMatch(home, /bg-\[#2d68ff\]/, "cited answer must not use a solid Citation Blue background");
assert.match(home, /badge="Dashboard"/, "memory map must show where the wiki is managed");
assert.doesNotMatch(home, /<article className="[^"]*transition-colors[^"]*"/, "product cards must not add color transitions");

for (const href of ["/docs/ios", "/docs/clipper", "/docs/cli", "/dashboard"]) {
  assert.ok(home.includes(`href="${href}"`), `home page must link to ${href}`);
}

assert.match(home, /href=\{APP_STORE_URL\}[\s\S]*rel="noopener noreferrer"[\s\S]*target="_blank"/);
assert.match(home, /href=\{CLIPPER_STORE_URL\}[\s\S]*rel="noopener noreferrer"[\s\S]*target="_blank"/);
assert.match(home, /nativeAuthHashRedirectScript/, "home page must preserve native auth hash routing");

console.log("Root AI memory landing page, product routes, and calls to action OK");
