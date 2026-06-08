// Where: wikibrowser/scripts/check-marketplace.mjs
// What: guards marketplace UI wiring with a small static and parser harness.
// Why: marketplace balance ownership must stay II-principal scoped.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const appHeader = readFileSync(new URL("../app/app-header.tsx", import.meta.url), "utf8");
const listingDetail = readFileSync(new URL("../app/marketplace/[listingId]/listing-detail-client.tsx", import.meta.url), "utf8");
const marketplace = readFileSync(new URL("../app/marketplace/marketplace-client.tsx", import.meta.url), "utf8");
const kinicDeposit = await importTs("../lib/kinic-deposit.ts");

assert.match(appHeader, /depositKinicBalanceWithIdentity/);
assert.match(appHeader, /authClient\.getIdentity\(\)/);
assert.match(appHeader, /Login with Internet Identity first/);
assert.match(appHeader, /Enter an amount greater than 0 KINIC/);
assert.match(appHeader, /Deposit KINIC/);
assert.match(appHeader, /aria-label="KINIC balance"/);
assert.doesNotMatch(appHeader, /: "KINIC balance"/);
assert.doesNotMatch(appHeader, /depositKinicBalanceWithOisy|depositKinicBalanceWithPlug/);
assert.doesNotMatch(appHeader, /Connect OISY or Plug first/);

assert.match(listingDetail, /marketPurchaseAccess/);
assert.match(listingDetail, /refreshKinicBalance/);
assert.match(listingDetail, /hrefForPath\(canisterId, listing\.databaseId, "\/Wiki"\)/);
assert.match(listingDetail, /Open database/);
assert.match(listingDetail, /Login with Internet Identity first/);
assert.doesNotMatch(listingDetail, /kinicGetBalance/);
assert.doesNotMatch(listingDetail, /purchaseMarketAccessWithOisy|purchaseMarketAccessWithPlug|marketPreviewPurchase/);

assert.match(marketplace, /Filter loaded listings/);
assert.match(marketplace, /loaded listings/);
assert.doesNotMatch(marketplace, /\/kinic\/wallet/);
assert.doesNotMatch(marketplace, /placeholder="Search"/);

assert.equal(kinicDeposit.parseDepositAmount("1"), "100000000");
assert.equal(kinicDeposit.parseDepositAmount("0.00000001"), "1");
assert.equal(kinicDeposit.parseDepositAmount("0"), null);
assert.equal(kinicDeposit.parseDepositAmount("0.00000000"), null);
assert.equal(kinicDeposit.parseDepositAmount("1.000000001"), null);

console.log("Marketplace checks OK");

async function importTs(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}
