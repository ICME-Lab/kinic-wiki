import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const wallet = readProjectFile("../lib/kinic-wallet.ts");
const appSession = readProjectFile("../app/app-session-provider.tsx");

assert.match(wallet, /type MarketPurchaseResult = \{[\s\S]*approveBlockIndex: string \| null;[\s\S]*approvedAllowanceE8s: string;[\s\S]*ledgerBlockIndex: string;/);
assert.match(wallet, /async function prepareMarketPurchase\(request: MarketPurchaseRequest, payer: string\): Promise<PreparedKinicAllowance>/);
assert.match(wallet, /runOisyAllowanceCall[\s\S]*wallet\.approve\(/);
assert.match(wallet, /runPlugAllowanceCall[\s\S]*ledgerActor\.icrc2_approve/);
assert.match(wallet, /market_purchase_access\(rawMarketPurchaseRequest\(request\)\)/);
assert.match(wallet, /ledger_block_index: IDL\.Nat64/);
assert.match(wallet, /ledgerBlockIndex: raw\.ledger_block_index\.toString\(\)/);
assertNoAppBalanceSurface(wallet);
assert.doesNotMatch(wallet, /decodeOisyKinicDepositResult/);
assert.doesNotMatch(appSession, /useState<ConnectedKinicWallet \| null>\(\(\) => readStoredWallet\(\)\)/);
assert.match(appSession, /queueMicrotask\(\(\) => \{[\s\S]*const storedWallet = readStoredWallet\(\);[\s\S]*if \(storedWallet\) setWallet\(storedWallet\);[\s\S]*\}\);/);

console.log("Wallet direct market purchase checks passed");
