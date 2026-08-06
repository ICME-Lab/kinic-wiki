import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const support = readFileSync(new URL("../../docs/legal/support.md", import.meta.url), "utf8");
const policy = readFileSync(new URL("../../docs/legal/privacy-policy.md", import.meta.url), "utf8");
const supportPage = readFileSync(new URL("../app/support-page.tsx", import.meta.url), "utf8");
const policyPage = readFileSync(new URL("../app/privacy-policy-page.tsx", import.meta.url), "utf8");

assert.match(support, /https:\/\/x\.com\/kinic_app/, "support page must include a contact method");
assert.match(support, /\[Privacy Policy\]\(\/privacy-policy\)/, "support page must link to the Privacy Policy");
assert.match(support, /Do not send passwords, private keys, seed phrases, API keys, or authentication tokens/);
assert.match(
  supportPage,
  /from\s+["']\.\.\/\.\.\/docs\/legal\/support\.md\?raw["']/,
  "support page must render the canonical support Markdown"
);

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
assert.match(
  policyPage,
  /from\s+["']\.\.\/\.\.\/docs\/legal\/privacy-policy\.md\?raw["']/,
  "privacy page must render the canonical policy Markdown"
);

console.log("Support and Privacy Policy content contracts OK");
