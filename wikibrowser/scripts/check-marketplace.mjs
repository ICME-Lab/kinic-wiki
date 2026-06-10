// Where: wikibrowser/scripts/check-marketplace.mjs
// What: guards marketplace UI wiring with a small static and parser harness.
// Why: marketplace balance ownership must stay II-principal scoped.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const appHeader = readFileSync(new URL("../app/app-header.tsx", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../components/admin-shell.tsx", import.meta.url), "utf8");
const listingDetail = readFileSync(new URL("../app/marketplace/[listingId]/listing-detail-client.tsx", import.meta.url), "utf8");
const sellerPage = readFileSync(new URL("../app/marketplace/seller/[principal]/page.tsx", import.meta.url), "utf8");
const sellerProfileClient = readFileSync(new URL("../app/marketplace/seller/[principal]/seller-profile-client.tsx", import.meta.url), "utf8");
const dashboardUi = readFileSync(new URL("../app/dashboard/dashboard-ui.tsx", import.meta.url), "utf8");
const vfsTypes = readFileSync(new URL("../lib/types.ts", import.meta.url), "utf8");
const vfsIdl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const marketplaceLayout = readFileSync(new URL("../app/marketplace/layout.tsx", import.meta.url), "utf8");
const marketplace = readFileSync(new URL("../app/marketplace/marketplace-client.tsx", import.meta.url), "utf8");
const marketplaceSeed = readFileSync(new URL("../scripts/seed-marketplace-fixtures.mjs", import.meta.url), "utf8");
const setupIiE2e = readFileSync(new URL("../../scripts/setup-wikibrowser-ii-e2e.sh", import.meta.url), "utf8");
const kinicDeposit = await importTs("../lib/kinic-deposit.ts");
const marketplaceRoutes = await importTs("../lib/marketplace-routes.ts");

assert.doesNotMatch(appHeader, /depositKinicBalanceWithIdentity/);
assert.doesNotMatch(appHeader, /Login with Internet Identity first/);
assert.doesNotMatch(appHeader, /Deposit KINIC/);
assert.doesNotMatch(appHeader, /parseKinicAmount/);
assert.doesNotMatch(appHeader, /aria-label="App KINIC balance"/);
assert.doesNotMatch(appHeader, /<span>Deposit<\/span>/);
assert.match(appHeader, /pathname\.startsWith\("\/dashboard\/"\)/);
assert.match(appHeader, /pathname === "\/profile"/);
assert.match(appHeader, /pathname === "\/cli"/);
assert.match(appHeader, /title="Console"/);
assert.doesNotMatch(appHeader, /Kinic marketplace/);
assert.doesNotMatch(appHeader, /: "KINIC balance"/);
assert.doesNotMatch(appHeader, /depositKinicBalanceWithOisy|depositKinicBalanceWithPlug/);
assert.doesNotMatch(appHeader, /Connect OISY or Plug first/);

assert.match(adminShell, /ADMIN_NAV_ITEMS/);
assert.match(adminShell, /href: "\/dashboard"/);
assert.match(adminShell, /href: "\/marketplace"/);
assert.match(adminShell, /href: "\/cycles"/);
assert.match(adminShell, /href: "\/profile"/);
assert.match(adminShell, /href: "\/cli"/);
assert.match(adminShell, /AdminAccountControls/);
assert.match(adminShell, /aria-label="Account"/);
assert.match(adminShell, /aria-label="App KINIC balance"[\s\S]*onClick=\{\(\) => setDepositOpen\(true\)\}/);
assert.match(adminShell, /aria-label="Log out"/);
assert.match(adminShell, /<PowerOff aria-hidden size=\{16\} \/>/);
assert.match(adminShell, /Deposit KINIC/);
assert.match(adminShell, /event\.target === event\.currentTarget\) setDepositOpen\(false\)/);
assert.match(adminShell, /depositKinicBalanceWithIdentity/);
assert.match(adminShell, /parseKinicAmount/);
assert.match(adminShell, /pathname\.startsWith\("\/marketplace\/"\)/);
assert.doesNotMatch(adminShell, /pathname\.startsWith\("\/db\/"\)/);

assert.match(listingDetail, /marketPurchaseAccess/);
assert.match(listingDetail, /marketPreviewPurchase/);
assert.match(listingDetail, /preview\.alreadyEntitled \? "success" : "idle"/);
assert.match(listingDetail, /marketPurchaseAccess\(canisterId, identity, listing\.listingId, listing\.priceE8s\)/);
assert.match(listingDetail, /refreshKinicBalance/);
assert.match(listingDetail, /hrefForPath\(canisterId, listing\.databaseId, "\/Wiki"\)/);
assert.match(listingDetail, /Open database/);
assert.match(listingDetail, /FactsSidebar/);
assert.doesNotMatch(listingDetail, /Verified stats/);
assert.match(listingDetail, /label="Overview"/);
assert.match(listingDetail, /label="Contents"/);
assert.match(listingDetail, /label="Graph"/);
assert.match(listingDetail, /label="Details"/);
assert.match(listingDetail, /NodeSizeDetails/);
assert.match(listingDetail, /contentChars/);
assert.match(listingDetail, /No Wiki node size details\./);
assert.match(listingDetail, /preview\.excerpts/);
assert.match(listingDetail, /Top-level paths/);
assert.match(listingDetail, /Relationship graph/);
assert.match(listingDetail, /Seller \{listing\.sellerPrincipal\}/);
assert.match(listingDetail, /marketSellerPath\(listing\.sellerPrincipal\)/);
assert.match(listingDetail, /Login with Internet Identity first/);
assert.doesNotMatch(listingDetail, /Questions/);
assert.doesNotMatch(listingDetail, new RegExp(`sampleQuestionsJson|sample_questions_json|Sample\\s+excerpts`));
assert.doesNotMatch(listingDetail, /kinicGetBalance/);
assert.doesNotMatch(listingDetail, /purchaseMarketAccessWithOisy|purchaseMarketAccessWithPlug/);
assert.doesNotMatch(listingDetail, /revision \{listing\.revision\}/);
assert.doesNotMatch(listingDetail, /Listing ID|Database ID|listing\.revision|listing\.updatedAtMs|listing\.createdAtMs/);
assert.match(dashboardUi, /expectedRevision: selected\.revision/);
assert.match(vfsClient, /expected_revision: BigInt\(request\.expectedRevision\)/);

assert.match(marketplaceLayout, /marketplace-specific filters now live with the listing content/);
assert.doesNotMatch(marketplaceLayout, /data-tid="marketplace-sidebar"/);
assert.doesNotMatch(marketplaceLayout, /top-36/);
assert.doesNotMatch(marketplaceLayout, /SidebarProvider|SidebarInset|SidebarTrigger/);

assert.doesNotMatch(marketplace, /AdminPageHeader|matching loaded listings|title="Marketplace"/);
assert.match(marketplace, /MarketplaceFilterBar/);
assert.match(marketplace, /Filter loaded listings/);
assert.match(marketplace, /Max price/);
assert.match(marketplace, /const QUICK_FILTERS[\s\S]*All listings/);
assert.doesNotMatch(marketplace, new RegExp(`With\\s+excerpts|preview${"Only"}|hasListing${"Preview"}`));
assert.doesNotMatch(sliceBetween(marketplace, "const QUICK_FILTERS", "const SORT_ITEMS"), /sort: "popular"|sort: "recent"|sort: "price_low"/);
assert.match(marketplace, /sort=\{sort\}/);
assert.doesNotMatch(marketplace, /sort=\{sortParam\}/);
assert.match(marketplace, /inputMode="decimal"/);
assert.match(marketplace, /normalizeKinicDecimalInput/);
assert.match(marketplace, /parseKinicDecimalToE8s/);
assert.match(marketplace, /marketListingPath\(listing\.listingId\)/);
assert.doesNotMatch(marketplace, /parseOptionalBigInt/);
assert.doesNotMatch(marketplace, /\/kinic\/wallet/);
assert.doesNotMatch(marketplace, /href=\{`\/marketplace\/\$\{listing\.listingId\}`\}/);
assert.doesNotMatch(marketplace, /placeholder="Search"/);

assert.match(sellerPage, /SellerProfileClient/);
assert.match(sellerPage, /decodeURIComponent\(principal\)/);
assert.match(sellerProfileClient, /marketListListings\(canisterId, nextCursor, LISTING_PAGE_LIMIT\)/);
assert.match(sellerProfileClient, /listing\.sellerPrincipal === principal/);
assert.match(sellerProfileClient, /Stats use loaded public marketplace listings\./);
assert.match(sellerProfileClient, /SellerStat label="Listings"/);
assert.match(sellerProfileClient, /SellerStat label="Purchases"/);
assert.match(sellerProfileClient, /No loaded public listings for this seller\./);
assert.match(sellerProfileClient, /Load more/);
assert.match(sellerProfileClient, /marketListingPath\(listing\.listingId\)/);

assert.match(marketplaceSeed, /purchase_database_cycles/);
assert.match(marketplaceSeed, /market_create_listing/);
assert.doesNotMatch(marketplaceSeed, /market_publish_listing/);
assert.doesNotMatch(vfsTypes, /MarketListingStatus = "Draft"/);
assert.doesNotMatch(vfsIdl, /Draft: idl\.Null/);
assert.doesNotMatch(vfsClient, /return "Draft"/);
assert.match(marketplaceSeed, /--canister-id/);
assert.match(marketplaceSeed, /DEFAULT_PAYMENT_E8S/);
assert.match(marketplaceSeed, /DEFAULT_ALLOWANCE_E8S/);
assert.match(marketplaceSeed, /icrc2_approve/);

assert.match(setupIiE2e, /scripts\/local\/setup_kinic_ledger\.sh/);
assert.match(setupIiE2e, /scripts\/local\/deploy_wiki\.sh/);
assert.match(setupIiE2e, /wiki ledger mismatch/);
assert.match(setupIiE2e, /--deploy-wiki/);
assert.match(setupIiE2e, /skipping wiki deploy/);
assert.match(setupIiE2e, /conflicts with reserved local canister/);

assert.equal(marketplaceRoutes.marketListingPath("ftjtrdothm6fauh"), "/marketplace/ftjtrdothm6fauh");
assert.equal(marketplaceRoutes.marketSellerPath("aaaaa-aa"), "/marketplace/seller/aaaaa-aa");

assert.equal(kinicDeposit.parseKinicAmount("1"), "100000000");
assert.equal(kinicDeposit.parseKinicAmount("0.00000001"), "1");
assert.equal(kinicDeposit.parseKinicAmount("0"), null);
assert.equal(kinicDeposit.parseKinicAmount("0.00000000"), null);
assert.equal(kinicDeposit.parseKinicAmount("1.000000001"), null);

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

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `${startText} not found`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${endText} not found`);
  return source.slice(start, end);
}
