import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const guide = readFileSync(new URL("../app/docs/clipper/page.tsx", import.meta.url), "utf8");
const docsData = readFileSync(new URL("../app/docs/docs-data.ts", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../components/admin-shell.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/docs.clipper.tsx", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../app/sitemap.ts", import.meta.url), "utf8");
const storeUrl = "https://chromewebstore.google.com/detail/kinic-wiki-clipper/moebdnadaffhlddnhifmmdoecifhcbdi";

assert.match(home, /href="\/docs\/clipper"/, "home page must link to the Clipper guide");
assert.ok(home.includes(storeUrl), "home page must link to the Chrome Web Store listing");
assert.match(home, /href=\{CLIPPER_STORE_URL\}[\s\S]*Install Clipper/, "home page must render the Chrome Web Store install call to action");
assert.match(home, /selected ChatGPT and Claude conversations or the active page/, "home page must explain what Clipper captures");
for (const surface of ["Wiki Clipper", "Dashboard", "Kinic VFS CLI"]) {
  assert.ok(home.includes(surface), `home page must distinguish the ${surface} surface`);
}

assert.match(guide, /ChatGPT or Claude session/, "guide must explain the provider session");
assert.match(guide, /Clipper Internet Identity session/, "guide must explain the Clipper write session");
assert.match(guide, /Dashboard Internet Identity session/, "guide must explain the separate Dashboard session");
assert.match(guide, /same Internet Identity/, "guide must tell users how to reach the same principal");
assert.match(guide, /does not have writer access/, "guide must state writer-access failure behavior");
assert.match(guide, /no destination database is selected/, "guide must state database-selection failure behavior");
assert.match(guide, /does not have enough write cycles/, "guide must state write-cycles failure behavior");
assert.ok(guide.includes(storeUrl), "guide must link to the Chrome Web Store listing");
assert.match(guide, /href=\{CLIPPER_STORE_URL\}[\s\S]*Add to Chrome/, "guide must render the Chrome Web Store install call to action");

assert.match(docsData, /href: "\/docs\/clipper"/, "docs index must list the Clipper guide");
assert.match(adminShell, /href: "\/docs\/clipper"/, "docs navigation must list the Clipper guide");
assert.match(route, /createFileRoute\("\/docs\/clipper"\)/, "TanStack Router must expose the Clipper guide");
assert.match(route, /routeHead\("Kinic Wiki Clipper"/, "Clipper route must define SEO metadata");
assert.match(sitemap, /"\/docs\/clipper"/, "sitemap must include the Clipper guide");

console.log("Wiki Clipper public guide and navigation OK");
