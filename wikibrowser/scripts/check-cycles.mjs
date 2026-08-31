import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const client = readProjectFile("../app/cycles/cycles-client.tsx");
const dashboardHome = readProjectFile("../app/dashboard/dashboard-home-client.tsx");
const wallet = readProjectFile("../lib/kinic-wallet.ts");
const vfsClientFiles = [
  "../lib/vfs-client.ts",
  "../lib/vfs-client/raw-types.ts",
  "../lib/vfs-client/actor.ts",
  "../lib/vfs-client/cycles.ts",
  "../lib/vfs-client/market.ts"
];
const vfsClient = vfsClientFiles.map((p) => readProjectFile(p)).join("\n");
const idl = readProjectFile("../../packages/vfs-candid/index.ts");

assert.match(client, /purchaseCyclesWithFundingSource/);
assert.match(client, /listDatabasesAuthenticated/);
assert.match(client, /data-tid="cycles-login-button"/);
assert.match(client, /Sign in with Internet Identity/);
assert.match(client, /Purchase cycles with OISY/);
assert.match(client, /Purchase cycles with Plug/);
assert.match(client, /Purchase cycles with Internet Identity/);
assert.match(client, /requiredKinicBalanceE8s/);
assertNoAppBalanceSurface(client);
assert.doesNotMatch(client, /paymentSource === "kinic"/);

assert.match(dashboardHome, /Create with \$\{fundingProviderLabel/);
assert.match(dashboardHome, /purchaseCyclesWithFundingSource/);
assertNoAppBalanceSurface(dashboardHome);
assert.doesNotMatch(dashboardHome, /refreshKinicBalance|createPaymentSource/);

assert.match(wallet, /export async function purchaseCyclesWithOisy/);
assert.match(wallet, /export async function purchaseCyclesWithPlug/);
assert.match(wallet, /export async function purchaseCyclesWithIdentity/);
assert.match(wallet, /export async function purchaseCyclesWithFundingSource/);
assert.match(wallet, /approveParams\(canisterId/);
assert.match(wallet, /runOisyAllowanceCall/);
assert.match(wallet, /runPlugAllowanceCall/);
assertNoAppBalanceSurface(wallet);

assertNoAppBalanceSurface(vfsClient);
assertNoAppBalanceSurface(idl);

console.log("Cycles direct funding checks passed");
