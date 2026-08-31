import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const dashboardClient = readProjectFile("../app/dashboard/dashboard-client.tsx");
const dashboardUi = readProjectFile("../app/dashboard/dashboard-ui.tsx");
const dashboardHome = readProjectFile("../app/dashboard/dashboard-home-client.tsx");
const databaseDangerZone = readProjectFile("../app/dashboard/database-danger-zone.tsx");
const createDialog = readProjectFile("../app/create-database-dialog.tsx");
const modalDialog = readProjectFile("../components/use-modal-dialog.ts");
const appSession = readProjectFile("../app/app-session-provider.tsx");
const adminShell = readProjectFile("../components/admin-shell.tsx");
const profile = readProjectFile("../app/profile/profile-client.tsx");
const metrics = readProjectFile("../app/metrics/metrics-client.tsx");

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source section start: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source section end: ${endMarker}`);
  return source.slice(start, end);
}

function assertOrdered(source, markers) {
  let cursor = 0;
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor);
    assert.notEqual(index, -1, `Missing or out-of-order source marker: ${marker}`);
    cursor = index + marker.length;
  }
}

const refreshDatabasesSource = sourceSection(
  dashboardHome,
  "const refreshDatabases = useCallback",
  "useEffect(() => {"
);
const createDatabaseSource = sourceSection(
  dashboardHome,
  "async function createDatabase()",
  "const myDatabases ="
);

assert.match(dashboardClient, /const canViewCyclesHistory = \(database\?\.role === "writer" \|\| database\?\.role === "owner"\) && isActiveDatabase/);
assert.match(dashboardUi, /canViewCyclesHistory/);
assert.match(dashboardClient, /setActiveTab\("access"\)/);
assert.match(dashboardClient, /cyclePageCursors/);
assert.match(dashboardClient, /loadCyclesHistory\(cyclePageIndex \+ 1, cycleNextCursor, false\)/);
assert.match(dashboardUi, /Previous page/);
assert.match(dashboardUi, /Next page/);
assert.doesNotMatch(dashboardUi.match(/export function CyclesHistoryPanel[\s\S]*?function DashboardTabButton/)?.[0] ?? "", /onLoadMore|Load more/);

assert.match(dashboardHome, /Create with wallet/);
assert.match(dashboardHome, /getInitialFreeDatabaseGrantStatus/);
assert.match(dashboardHome, /freeGrantError/);
assert.match(dashboardHome, /Initial free database grant status unavailable/);
assert.match(dashboardHome, /Retry free grant check/);
assert.match(dashboardHome, /Free grant available/);
assert.match(dashboardHome, /Wallet payment required/);
assert.match(dashboardHome, /wallet approval is not required/);
assert.match(dashboardHome, /wallet approval pays directly from ledger balance/);
assert.match(dashboardHome, /purchaseCyclesWithWallet/);
assert.match(dashboardHome, /toast\.success\(fundingSuccessMessage\)/);
assert.match(dashboardHome, /router\.replace\("\/dashboard"\)/);
assert.doesNotMatch(dashboardHome, /fundingSuccessMessage \? <StatusPanel/);
assert.match(dashboardHome, /result\.initial_free_grant_applied \|\| result\.status === "active"/);
assert.match(dashboardHome, /Database created pending\. Fund it from Cycles before opening \/Knowledge\./);
assert.doesNotMatch(dashboardHome, /if \(freeGrantAvailable\) \{/);
assert.doesNotMatch(dashboardHome, /if \(!freeGrantAvailable && \(!wallet \|\| !walletPaymentAvailable\)\) return/);
assert.match(dashboardHome, /const fundingModeAtSubmit = freeGrantStatus\.available \? "free-grant" : "wallet"/);
assert.match(createDatabaseSource, /} else {\s*if \(walletBusyProvider !== null \|\| !wallet \|\| !walletPaymentAvailable\) return;\s*fundingAtSubmit = \{ mode: fundingModeAtSubmit, wallet \};/);
assert.match(createDatabaseSource, /if \(fundingAtSubmit\.mode === "free-grant"\) \{/);
assert.match(dashboardHome, /walletRequiredForCreate && walletBusyProvider !== null/);
assertOrdered(refreshDatabasesSource, [
  "await Promise.allSettled",
  "if (!isCurrentRefresh()) return;",
  "setFreeGrantStatus(",
  'if (freeGrantResult.status === "rejected")',
  "setFreeGrantError(",
  "setCreateDialogOpen(false);",
  "setFreeGrantError(null);",
  'if (publicResult.status === "rejected" && memberResult.status === "rejected")'
]);
assertOrdered(createDatabaseSource, [
  'const fundingModeAtSubmit = freeGrantStatus.available ? "free-grant" : "wallet";',
  "walletBusyProvider !== null || !wallet || !walletPaymentAvailable",
  "fundingAtSubmit = { mode: fundingModeAtSubmit, wallet };",
  "const result = await createDatabaseAuthenticated",
  'if (fundingAtSubmit.mode === "free-grant")',
  "await refreshDatabases(authClient);",
  "return;",
  "purchaseCyclesWithWallet"
]);
assert.match(dashboardHome, /KinicAfterApproveError/);
assert.match(dashboardHome, /purchase_database_cycles failed/);
assert.match(dashboardHome, /Retry cycles purchase for the same database from Cycles/);
assert.doesNotMatch(dashboardHome, /setLoadState\("idle"\)/);
assertNoAppBalanceSurface(dashboardHome);
assert.doesNotMatch(dashboardHome, /refreshKinicBalance|createPaymentSource|createDialogPaymentSources|paymentSources|onPaymentSourceChange|walletBalanceDetail/);
assertNoAppBalanceSurface(createDialog);
assert.doesNotMatch(createDialog, /app-balance|Payment source|CreateDatabasePaymentSource|PaymentSourceOption|paymentSource|paymentSources|onPaymentSourceChange/);
assert.doesNotMatch(createDialog, /<dialog\s+open/);
assert.doesNotMatch(dashboardUi, /<dialog\s+open/);
assert.doesNotMatch(databaseDangerZone, /<dialog\s+open/);
assert.match(modalDialog, /dialog\.showModal\(\)/);
assert.match(modalDialog, /previousFocus\?\.isConnected/);

assert.match(appSession, /getConnectedWalletKinicBalance/);
assertNoAppBalanceSurface(appSession);
assert.doesNotMatch(appSession, /kinicBalance|refreshKinicBalance/);
assertNoAppBalanceSurface(adminShell);
assert.match(adminShell, /pathname === "\/metrics"/);
assert.doesNotMatch(adminShell, /href: "\/metrics", label: "Metrics"/);
assert.match(adminShell, /@radix-ui\/react-collapsible/);
assert.match(adminShell, /href: "\/profile", label: "My Profile"[\s\S]*href: "\/docs"[\s\S]*label: "Docs"[\s\S]*href: "\/docs", label: "Overview"[\s\S]*href: "\/docs\/cli", label: "CLI Guide"/);
assert.match(adminShell, /<Collapsible\.Root[\s\S]*open=\{docsOpen\}[\s\S]*onOpenChange=\{setDocsOpen\}/);
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
