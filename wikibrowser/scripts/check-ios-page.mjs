import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/ios-page.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/ios.tsx", import.meta.url), "utf8");
const guide = readFileSync(new URL("../app/docs/ios/page.tsx", import.meta.url), "utf8");
const guideRoute = readFileSync(new URL("../src/routes/docs.ios.tsx", import.meta.url), "utf8");
const docsData = readFileSync(new URL("../app/docs/docs-data.ts", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../components/admin-shell.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../app/sitemap.ts", import.meta.url), "utf8");

assert.match(route, /createFileRoute\("\/ios"\)/, "iOS page must own the /ios route");
assert.match(route, /KinicWiki for iPhone and iPad/, "iOS route must provide product-specific metadata");
assert.match(route, /https:\/\/wiki\.kinic\.xyz\/ios/, "iOS route must provide its canonical URL");
assert.match(page, /https:\/\/apps\.apple\.com\/us\/app\/kinicwiki-ai-memory\/id6785718977/, "iOS page must link to the published App Store listing");
assert.match(page, /Save from Safari/);
assert.match(page, /Browse your wiki/);
assert.match(page, /Ask with evidence/);
assert.match(page, /Internet Identity/);
assert.match(page, /Ask AI history stays on your device/);
assert.match(page, /href="\/privacy-policy"/);
assert.match(page, /rel="noreferrer noopener"/);
assert.match(home, /href="\/ios"/, "home page must link to the iOS introduction");
assert.match(sitemap, /"\/ios"/, "sitemap must include the iOS introduction");

assert.match(guideRoute, /createFileRoute\("\/docs\/ios"\)/, "iOS guide must own the /docs/ios route");
assert.match(guideRoute, /https:\/\/wiki\.kinic\.xyz\/docs\/ios/, "iOS guide must provide its canonical URL");
assert.match(guideRoute, /KinicWiki iOS Setup Guide/, "iOS guide route must provide specific metadata");
assert.ok(guide.includes("https://apps.apple.com/us/app/kinicwiki-ai-memory/id6785718977"), "iOS guide must link to the App Store listing");
assert.match(guide, /iOS 18 or later/);
assert.match(guide, /Owner or Writer/);
assert.match(guide, /Reader access is enough for Browse/);
assert.match(guide, /on-device queue/);
assert.match(guide, /Ask AI is scoped to the database you select/);
assert.match(guide, /Ask AI history is stored on this device/);
assert.match(guide, /Generation request data is discarded after processing/);
assert.match(guide, /href="\/ios"/, "iOS guide must link back to the product overview");
assert.match(docsData, /href: "\/docs\/ios"/, "docs index must list the iOS guide");
assert.match(adminShell, /href: "\/docs\/ios"/, "docs navigation must list the iOS guide");
assert.match(sitemap, /"\/docs\/ios"/, "sitemap must include the iOS guide");
for (const asset of ["app-icon.webp", "save-from-safari.webp", "browse-knowledge.webp", "ask-with-sources.webp"]) {
  assert.ok(existsSync(new URL(`../public/ios/${asset}`, import.meta.url)), `missing public iOS asset: ${asset}`);
}

console.log("iOS introduction and setup guide routes, links, claims, metadata, and sitemap OK");
