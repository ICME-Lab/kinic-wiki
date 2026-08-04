import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const guide = readFileSync(new URL("../app/docs/clipper/page.tsx", import.meta.url), "utf8");
const docsData = readFileSync(new URL("../app/docs/docs-data.ts", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../components/admin-shell.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/docs.clipper.tsx", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../app/sitemap.ts", import.meta.url), "utf8");

assert.match(home, /href="\/docs\/clipper"/, "home page must link to the Clipper guide");
assert.match(home, /ChatGPT and Claude conversations or the active web page/, "home page must explain what Clipper captures");
assert.match(home, /Wiki Clipper[\s\S]*Dashboard[\s\S]*CLI/, "home page must distinguish the three product surfaces");

assert.match(guide, /ChatGPT or Claude session/, "guide must explain the provider session");
assert.match(guide, /Clipper Internet Identity session/, "guide must explain the Clipper write session");
assert.match(guide, /Dashboard Internet Identity session/, "guide must explain the separate Dashboard session");
assert.match(guide, /same Internet Identity/, "guide must tell users how to reach the same principal");
assert.match(guide, /does not have writer access/, "guide must state writer-access failure behavior");
assert.match(guide, /no destination database is selected/, "guide must state database-selection failure behavior");

assert.match(docsData, /href: "\/docs\/clipper"/, "docs index must list the Clipper guide");
assert.match(adminShell, /href: "\/docs\/clipper"/, "docs navigation must list the Clipper guide");
assert.match(route, /createFileRoute\("\/docs\/clipper"\)/, "TanStack Router must expose the Clipper guide");
assert.match(route, /routeHead\("Kinic Wiki Clipper"/, "Clipper route must define SEO metadata");
assert.match(sitemap, /"\/docs\/clipper"/, "sitemap must include the Clipper guide");

console.log("Wiki Clipper public guide and navigation OK");
