import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const listingDetail = readProjectFile("../app/marketplace/[listingId]/listing-detail-client.tsx");
const wallet = readProjectFile("../lib/kinic-wallet.ts");
const types = readProjectFile("../lib/types.ts");
const idl = readProjectFile("../lib/vfs-idl.ts");

assert.match(listingDetail, /whitespace-pre-wrap/);
assert.match(listingDetail, /Ledger block \$\{order\.ledgerBlockIndex\}/);
assert.match(listingDetail, /purchaseMarketAccessWithWallet/);
assertNoAppBalanceSurface(listingDetail);
assert.doesNotMatch(listingDetail, /marketPurchaseAccess|refreshKinicBalance|KINIC balance updated|buyerBalanceE8s/);

assert.match(wallet, /runOisyAllowanceCall[\s\S]*wallet\.approve\(/);
assert.match(wallet, /runPlugAllowanceCall[\s\S]*icrc2_approve/);
assert.match(wallet, /market_purchase_access/);
assert.match(wallet, /purchaseMarketAccessWithWallet/);
assert.match(types, /ledgerBlockIndex: string;/);
assertNoAppBalanceSurface(types);
assert.doesNotMatch(types, /buyerBalanceE8s|KinicDepositResult|KinicFundDatabaseCyclesResult/);
assert.match(idl, /ledger_block_index: idl\.Nat64/);
assertNoAppBalanceSurface(idl);
assert.doesNotMatch(idl, /buyer_balance_e8s/);

console.log("Marketplace direct purchase checks passed");
