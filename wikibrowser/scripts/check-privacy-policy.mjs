import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const policy = readFileSync(new URL("../../docs/legal/privacy-policy.md", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/privacy-policy-page.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/routes/privacy-policy.tsx", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../app/sitemap.ts", import.meta.url), "utf8");

const headings = policy.match(/^##\s+\d+\.\s+.+$/gm) ?? [];
assert.equal(headings.length, 11, "privacy policy must retain its 11 numbered sections");
assert.match(policy, /Last Updated: August 5, 2026/);
assert.match(policy, /Effective Date: August 5, 2026/);
assert.match(policy, /Material changes posted after this Policy's Effective Date take effect 30 days after posting/);
assert.match(policy, /Ask AI transient processing/);
assert.match(policy, /Internet Computer canister state/);
assert.match(policy, /SEV-SNP/);
assert.match(policy, /discarded after the request completes, fails, or is cancelled/);
assert.match(policy, /Settings > Delete Account/);
assert.match(policy, /Internet Identity is a separate service and is not deleted/);
assert.match(policy, /initial free database grant was used/);
assert.match(policy, /https:\/\/x\.com\/kinic_app/);
assert.match(page, /privacy-policy\.md\?raw/, "page must render the policy source instead of copying its body");
assert.match(page, /rel=\{external \? "noreferrer noopener"/, "external policy links must be isolated");
assert.match(route, /https:\/\/wiki\.kinic\.xyz\/privacy-policy/);
assert.match(sitemap, /"\/privacy-policy"/);

console.log("Privacy Policy source, route, links, and sitemap OK");
