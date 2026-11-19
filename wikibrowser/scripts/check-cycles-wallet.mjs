import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const wallet = readProjectFile("../lib/kinic-wallet.ts");
const runtime = readProjectFile("../lib/wallet-runtime.ts");
const adapter = readProjectFile("../lib/payments/cycles-adapter.ts");
const appSession = readProjectFile("../app/app-session-provider.tsx");

assert.match(wallet, /type MarketPurchaseResult = \{[\s\S]*approveBlockIndex: string \| null;[\s\S]*approvedAllowanceE8s: string;[\s\S]*ledgerBlockIndex: string;/);
assert.match(wallet, /async function prepareMarketPurchase\(request: MarketPurchaseRequest, payer: string\): Promise<PreparedKinicAllowance>/);
assert.match(wallet, /runExternalAllowanceCall[\s\S]*transport\.approve\(/);
assert.match(wallet, /callWikiWithPayer\(transport, request\.canisterId, "market_purchase_access"/);
assert.match(wallet, /market_purchase_access\(rawMarketPurchaseRequest\(request\)\)/);
assert.match(runtime, /transport\.call\([\s\S]*IDL\.decode\(signature\.retTypes, reply\)/);
assert.match(adapter, /assertLedgerFee\(terms\.feeE8s, KINIC_LEDGER_FEE_E8S\)/);
assert.match(wallet, /ledgerBlockIndex: raw\.ledger_block_index\.toString\(\)/);
assertNoAppBalanceSurface(wallet);
assert.doesNotMatch(wallet, /decodeOisyKinicDepositResult/);
assert.doesNotMatch(appSession, /useState<ConnectedKinicWallet \| null>\(\(\) => readStoredWallet\(\)\)/);
assert.match(appSession, /owner\(createWikiWalletSession\)/);
assert.match(readProjectFile("../src/routes/__root.tsx"), /<WikiWalletLifetime>/);
assert.match(appSession, /walletSession\.restore\(\)/);
assert.match(appSession, /walletSession\.hasScopes\(wikiPaymentScopes/);
assert.doesNotMatch(appSession, /readStoredWallet|sessionStorage\.getItem/);
assert.doesNotMatch(wallet, /Certificate\.create|requestIdOf|openOisyWallet/);

console.log("Wallet direct market purchase checks passed");
