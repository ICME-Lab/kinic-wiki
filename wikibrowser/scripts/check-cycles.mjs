import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const client = readProjectFile("../app/cycles/cycles-client.tsx");
const dashboardHome = readProjectFile("../app/dashboard/dashboard-home-client.tsx");
const wallet = readProjectFile("../lib/kinic-wallet.ts");
const vfsClient = readProjectFile("../lib/vfs-client.ts");
const idl = readProjectFile("../lib/vfs-idl.ts");

assert.match(client, /purchaseCyclesWithWallet/);
assert.match(client, /listDatabasesAuthenticated/);
assert.match(client, /Purchase cycles with OISY/);
assert.match(client, /Purchase cycles with Plug/);
assertNoAppBalanceSurface(client);
assert.doesNotMatch(client, /paymentSource === "kinic"/);

assert.match(dashboardHome, /Create with wallet/);
assert.match(dashboardHome, /purchaseCyclesWithWallet/);
assertNoAppBalanceSurface(dashboardHome);
assert.doesNotMatch(dashboardHome, /refreshKinicBalance|createPaymentSource/);

assert.match(wallet, /export async function purchaseCyclesWithOisy/);
assert.match(wallet, /export async function purchaseCyclesWithPlug/);
assert.match(wallet, /approveParams\(canisterId/);
assert.match(wallet, /runOisyAllowanceCall/);
assert.match(wallet, /runPlugAllowanceCall/);
assertNoAppBalanceSurface(wallet);

assertNoAppBalanceSurface(vfsClient);
assertNoAppBalanceSurface(idl);

console.log("Cycles direct funding checks passed");
