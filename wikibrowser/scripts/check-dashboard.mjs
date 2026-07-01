import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const dashboardClient = readProjectFile("../app/dashboard/dashboard-client.tsx");
const dashboardUi = readProjectFile("../app/dashboard/dashboard-ui.tsx");
const dashboardHome = readProjectFile("../app/dashboard/dashboard-home-client.tsx");
const createDialog = readProjectFile("../app/create-database-dialog.tsx");
const appSession = readProjectFile("../app/app-session-provider.tsx");
const adminShell = readProjectFile("../components/admin-shell.tsx");
const profile = readProjectFile("../app/profile/profile-client.tsx");
const metrics = readProjectFile("../app/metrics/metrics-client.tsx");

assert.match(dashboardClient, /const canViewCyclesHistory = \(database\?\.role === "writer" \|\| database\?\.role === "owner"\) && isActiveDatabase/);
assert.match(dashboardUi, /canViewCyclesHistory/);
assert.match(dashboardClient, /setActiveTab\("access"\)/);

assert.match(dashboardHome, /Create with wallet/);
assert.match(dashboardHome, /getInitialFreeDatabaseGrantStatus/);
assert.match(dashboardHome, /無料枠あり/);
assert.match(dashboardHome, /wallet 支払い必要/);
assert.match(dashboardHome, /wallet approval is not required/);
assert.match(dashboardHome, /wallet approval pays directly from ledger balance/);
assert.match(dashboardHome, /purchaseCyclesWithWallet/);
assert.match(dashboardHome, /result\.initial_free_grant_applied \|\| result\.status === "active"/);
assert.match(dashboardHome, /Database created pending\. Fund it from Cycles before opening \/Knowledge\./);
assert.doesNotMatch(dashboardHome, /if \(freeGrantAvailable\) \{/);
assert.match(dashboardHome, /KinicAfterApproveError/);
assert.match(dashboardHome, /purchase_database_cycles failed/);
assert.match(dashboardHome, /Retry cycles purchase for the same database from Cycles/);
assert.doesNotMatch(dashboardHome, /setLoadState\("idle"\)/);
assertNoAppBalanceSurface(dashboardHome);
assert.doesNotMatch(dashboardHome, /refreshKinicBalance|createPaymentSource|createDialogPaymentSources|paymentSources|onPaymentSourceChange|walletBalanceDetail/);
assertNoAppBalanceSurface(createDialog);
assert.doesNotMatch(createDialog, /app-balance|Payment source|CreateDatabasePaymentSource|PaymentSourceOption|paymentSource|paymentSources|onPaymentSourceChange/);

assert.match(appSession, /getConnectedWalletKinicBalance/);
assertNoAppBalanceSurface(appSession);
assert.doesNotMatch(appSession, /kinicBalance|refreshKinicBalance/);
assertNoAppBalanceSurface(adminShell);
assert.match(adminShell, /pathname === "\/metrics"/);
assert.doesNotMatch(adminShell, /href: "\/metrics", label: "Metrics"/);
assert.match(adminShell, /href: "\/profile", label: "My Profile"[\s\S]*href: "\/cli", label: "CLI Guide"/);
assert.match(profile, /Marketplace access/);
assert.match(profile, /Purchased databases/);
assert.match(profile, /Ledger KINIC balance/);
assertNoAppBalanceSurface(profile);
assert.doesNotMatch(profile, /Deposit|Withdraw/);

assert.match(metrics, /wikiMetrics/);
assert.match(metrics, /wikiMetricsSeries\(canisterId, 7\)/);
assert.match(metrics, /MetricChart/);
assert.match(metrics, /<svg/);
assert.match(metrics, /No activity in this period/);
assert.match(metrics, /Activity/);
assert.match(metrics, /KINIC charge rolling 30d/);
assert.match(metrics, /title="Public Metrics"/);
assert.match(metrics, /Public usage and KINIC charge totals/);
assert.match(metrics, /chartNumberFromDecimal\(value: string, divisor = 1n\): number \| null/);
assert.match(metrics, /BigInt\(value\)/);
assert.match(metrics, /Number\.MAX_SAFE_INTEGER/);
assert.match(metrics, /chargedKinic30dE8s, 100_000_000n/);
assert.match(metrics, /formatNullableChartValue/);
assert.doesNotMatch(metrics, /chargedKinic30dE8s\) \/ 100_000_000/);
assert.doesNotMatch(metrics, /\bnumberFromDecimal\(/);
assert.doesNotMatch(metrics, /<input|<textarea|contentEditable/);
assert.doesNotMatch(metrics, /queryIndexSqlJson|buildWikiMetricsSql|useAppSession/);

console.log("Dashboard direct funding checks passed");
