import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const support = readFileSync(new URL("../../docs/legal/support.md", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/support-page.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/support.tsx", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../app/sitemap.ts", import.meta.url), "utf8");

assert.match(support, /https:\/\/x\.com\/kinic_app/, "support page must include a contact method");
assert.match(support, /\[Privacy Policy\]\(\/privacy-policy\)/, "support page must link to the Privacy Policy");
assert.match(support, /Do not send passwords, private keys, seed phrases, API keys, or authentication tokens/);
assert.match(page, /support\.md\?raw/, "page must render the support source instead of copying its body");
assert.match(page, /rel=\{external \? "noreferrer noopener"/, "external support links must be isolated");
assert.match(route, /https:\/\/wiki\.kinic\.xyz\/support/, "support route must use the canonical production URL");
assert.match(sitemap, /"\/support"/, "sitemap must include the support route");

console.log("Support source, route, links, and sitemap OK");
