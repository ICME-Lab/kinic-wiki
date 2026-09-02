import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const listingDetail = readProjectFile("../app/marketplace/[listingId]/listing-detail-client.tsx");
const wallet = readProjectFile("../lib/kinic-wallet.ts");
const vfsClientFiles = [
  "../lib/vfs-client.ts",
  "../lib/vfs-client/raw-types.ts",
  "../lib/vfs-client/actor.ts",
  "../lib/vfs-client/cycles.ts",
  "../lib/vfs-client/market.ts"
];
const client = vfsClientFiles.map((p) => readProjectFile(p)).join("\n");
const types = readProjectFile("../lib/types.ts");
const idl = readProjectFile("../../packages/vfs-candid/index.ts");

assert.match(listingDetail, /whitespace-pre-wrap/);
assert.match(listingDetail, /Purchase complete\. Ledger block \$\{order\.ledgerBlockIndex\}\./);
assert.doesNotMatch(listingDetail, /Order \$\{order\.orderId\}/);
assert.match(listingDetail, /setPurchaseState\(preview\.alreadyEntitled \? "success" : "idle"\)/);
assert.doesNotMatch(listingDetail, /setPurchaseState\("success"\);[\s\S]{0,120}void loadPurchasePreview\(\);/);
assert.match(listingDetail, /purchaseMarketAccessWithFundingSource/);
assert.match(listingDetail, /marketPreviewPurchase\(canisterId, identityAtSubmit, listingAtSubmit\.listingId\)/);
assert.match(listingDetail, /Listing price changed\. Reload the listing before purchasing\./);
assert.match(listingDetail, /accessPrincipal: principalAtSubmit/);
assert.doesNotMatch(listingDetail, /localStorage|storeMarketPurchase|readStoredMarketPurchase|PURCHASED_MARKET_LISTING/);
assert.doesNotMatch(listingDetail, /walletPrincipal|order\.buyerPrincipal/);
assert.doesNotMatch(listingDetail, /String\(cause\)/);
assertNoAppBalanceSurface(listingDetail);
assert.doesNotMatch(listingDetail, /marketPurchaseAccess|refreshKinicBalance|KINIC balance updated|buyerBalanceE8s/);

assert.match(wallet, /runOisyAllowanceCall[\s\S]*wallet\.approve\(/);
assert.match(wallet, /runPlugAllowanceCall[\s\S]*icrc2_approve/);
assert.match(wallet, /market_purchase_access/);
assert.match(wallet, /purchaseMarketAccessWithFundingSource/);
assert.match(wallet, /purchaseMarketAccessWithIdentity/);
assert.match(wallet, /access_principal: request\.accessPrincipal/);
assert.match(wallet, /payout_principal/);
assert.match(wallet, /Purchase did not complete after KINIC approval/);
assert.match(wallet, /temporary allowance may remain until expiry/);
assert.doesNotMatch(client, /export async function marketPurchaseAccess/);
assert.match(client, /market_purchase_access: \(request: RawMarketPurchaseRequest\)/);
assert.match(client, /market_list_seller_listings: \(sellerPrincipal: string, cursor: \[\] \| \[string\], limit: number\)/);
assert.match(client, /export async function marketListSellerListings/);
assert.match(client, /access_principal: string/);
assert.match(client, /payout_principal: request\.payoutPrincipal/);
assert.match(types, /ledgerBlockIndex: string;/);
assert.match(types, /payoutPrincipal: string;/);
assertNoAppBalanceSurface(types);
assert.doesNotMatch(types, /buyerBalanceE8s|KinicDepositResult|KinicFundDatabaseCyclesResult/);
assert.match(idl, /ledger_block_index: idl\.Nat64/);
assert.match(idl, /payout_principal: idl\.Text/);
assert.match(idl, /market_list_seller_listings: idl\.Func\(\[idl\.Text, idl\.Opt\(idl\.Text\), idl\.Nat32\]/);
assertNoAppBalanceSurface(idl);
assert.doesNotMatch(idl, /buyer_balance_e8s/);

console.log("Marketplace direct purchase checks passed");
