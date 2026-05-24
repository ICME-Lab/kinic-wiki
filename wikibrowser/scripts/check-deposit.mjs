import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/deposit/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/deposit/deposit-client.tsx", import.meta.url), "utf8");
const wallet = readFileSync(new URL("../lib/deposit-wallet.ts", import.meta.url), "utf8");
const url = readFileSync(new URL("../lib/deposit-url.ts", import.meta.url), "utf8");
const idl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");

assert.match(page, /\/deposit/);
assert.match(page, /canister_id \?\? params\.canisterId/);
assert.match(client, /depositWithOisy/);
assert.match(client, /depositWithPlug/);
assert.match(wallet, /icrc2_approve/);
assert.match(wallet, /icrc1_fee/);
assert.match(wallet, /top_up_database/);
assert.match(wallet, /function allowanceForTopUp\(amountE8s: bigint, transferFeeE8s: bigint\)/);
assert.match(wallet, /return amountE8s \+ transferFeeE8s/);
assert.match(wallet, /rawApproveArgs\(request\.canisterId, approvedAllowanceE8s\)/);
assert.match(wallet, /top_up_database\(request\.databaseId, request\.amountE8s\)/);
assert.match(wallet, /spender: \{ owner: Principal\.fromText\(canisterId\), subaccount: \[\] \}/);
assert.match(wallet, /DEFAULT_OISY_SIGNER_URL/);
assert.match(client, /DB credited/);
assert.match(client, /approved allowance/);
assert.match(client, /transfer fee/);
assert.match(url, /amount_e8s must be an integer/);
assert.match(url, /database_id is required/);
assert.match(idl, /get_billing_config/);
assert.match(idl, /top_up_database/);
assert.match(vfsClient, /export async function getBillingConfig/);

console.log("Deposit checks OK");
