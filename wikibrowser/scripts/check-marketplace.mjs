import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const listingDetail = readProjectFile("../app/marketplace/[listingId]/listing-detail-client.tsx");
const wallet = readProjectFile("../lib/kinic-wallet.ts");
const client = readProjectFile("../lib/vfs-client.ts");
const types = readProjectFile("../lib/types.ts");
const idl = readProjectFile("../lib/vfs-idl.ts");

assert.match(listingDetail, /whitespace-pre-wrap/);
assert.match(listingDetail, /Purchase complete\. Ledger block \$\{order\.ledgerBlockIndex\}\./);
assert.doesNotMatch(listingDetail, /Order \$\{order\.orderId\}/);
assert.match(listingDetail, /current === "success" \? "success" : "idle"/);
assert.doesNotMatch(listingDetail, /setPurchaseState\("success"\);[\s\S]{0,120}void loadPurchasePreview\(\);/);
assert.match(listingDetail, /purchaseMarketAccessWithWallet/);
assert.match(listingDetail, /accessPrincipal: principal/);
assert.match(listingDetail, /storeMarketPurchase\(canisterId, order\.listingId, principal\)/);
assert.match(listingDetail, /readStoredMarketPurchase\(canisterId, listingId, principal\)/);
assert.doesNotMatch(listingDetail, /connectedWalletPrincipal|walletPrincipal|order\.buyerPrincipal/);
assert.doesNotMatch(listingDetail, /String\(cause\)/);
assertNoAppBalanceSurface(listingDetail);
assert.doesNotMatch(listingDetail, /marketPurchaseAccess|refreshKinicBalance|KINIC balance updated|buyerBalanceE8s/);

assert.match(wallet, /runOisyAllowanceCall[\s\S]*wallet\.approve\(/);
assert.match(wallet, /runPlugAllowanceCall[\s\S]*icrc2_approve/);
assert.match(wallet, /market_purchase_access/);
assert.match(wallet, /purchaseMarketAccessWithWallet/);
assert.match(wallet, /access_principal: request\.accessPrincipal/);
assert.doesNotMatch(client, /export async function marketPurchaseAccess/);
assert.match(client, /market_purchase_access: \(request: RawMarketPurchaseRequest\)/);
assert.match(client, /access_principal: string/);
assert.match(types, /ledgerBlockIndex: string;/);
assertNoAppBalanceSurface(types);
assert.doesNotMatch(types, /buyerBalanceE8s|KinicDepositResult|KinicFundDatabaseCyclesResult/);
assert.match(idl, /ledger_block_index: idl\.Nat64/);
assertNoAppBalanceSurface(idl);
assert.doesNotMatch(idl, /buyer_balance_e8s/);

console.log("Marketplace direct purchase checks passed");
