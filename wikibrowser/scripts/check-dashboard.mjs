import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const dashboardClient = readProjectFile("../app/dashboard/dashboard-client.tsx");
const dashboardUi = readProjectFile("../app/dashboard/dashboard-ui.tsx");
const dashboardHome = readProjectFile("../app/dashboard/dashboard-home-client.tsx");
const createDialog = readProjectFile("../app/create-database-dialog.tsx");
const appSession = readProjectFile("../app/app-session-provider.tsx");
const adminShell = readProjectFile("../components/admin-shell.tsx");
const profile = readProjectFile("../app/profile/profile-client.tsx");

assert.match(dashboardClient, /const canViewCyclesHistory = \(database\?\.role === "writer" \|\| database\?\.role === "owner"\) && isActiveDatabase/);
assert.match(dashboardUi, /canViewCyclesHistory/);
assert.match(dashboardClient, /setActiveTab\("access"\)/);

assert.match(dashboardHome, /Create with wallet/);
assert.match(dashboardHome, /purchaseCyclesWithWallet/);
assertNoAppBalanceSurface(dashboardHome);
assert.doesNotMatch(dashboardHome, /refreshKinicBalance|createPaymentSource|createDialogPaymentSources|paymentSources|onPaymentSourceChange|walletBalanceDetail/);
assert.match(createDialog, /Wallet approval pays directly from ledger balance/);
assertNoAppBalanceSurface(createDialog);
assert.doesNotMatch(createDialog, /app-balance|Payment source|CreateDatabasePaymentSource|PaymentSourceOption|paymentSource|paymentSources|onPaymentSourceChange/);

assert.match(appSession, /getConnectedWalletKinicBalance/);
assertNoAppBalanceSurface(appSession);
assert.doesNotMatch(appSession, /kinicBalance|refreshKinicBalance/);
assertNoAppBalanceSurface(adminShell);
assert.match(profile, /Ledger KINIC balance/);
assertNoAppBalanceSurface(profile);
assert.doesNotMatch(profile, /Deposit|Withdraw/);

console.log("Dashboard direct funding checks passed");
