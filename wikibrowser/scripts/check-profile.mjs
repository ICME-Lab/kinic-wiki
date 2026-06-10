// Where: wikibrowser/scripts/check-profile.mjs
// What: guards My Profile App KINIC account UI wiring.
// Why: App KINIC must stay distinct from direct ledger balances and DB cycles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/profile/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/profile/profile-client.tsx", import.meta.url), "utf8");
const header = readFileSync(new URL("../app/app-header.tsx", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../components/admin-shell.tsx", import.meta.url), "utf8");

assert.match(page, /ProfileClient/);
assert.match(page, /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);

assert.match(adminShell, /href: "\/profile", label: "My Profile"/);
assert.match(adminShell, /pathname === "\/profile"/);

assert.doesNotMatch(header, /aria-label="App KINIC balance"/);
assert.doesNotMatch(header, /Deposit KINIC/);
assert.doesNotMatch(header, /depositKinicBalanceWithIdentity/);
assert.doesNotMatch(header, /parseKinicAmount/);
assert.doesNotMatch(header, /<span>Deposit<\/span>/);
assert.doesNotMatch(header, /parseDepositAmount/);
assert.match(adminShell, /AdminAccountControls/);
assert.match(adminShell, /aria-label="Account"/);
assert.match(adminShell, /aria-label="App KINIC balance"[\s\S]*onClick=\{\(\) => setDepositOpen\(true\)\}/);
assert.match(adminShell, /aria-label="Log out"/);
assert.match(adminShell, /<PowerOff aria-hidden size=\{16\} \/>/);
assert.match(adminShell, /Deposit KINIC/);
assert.match(adminShell, /event\.target === event\.currentTarget\) setDepositOpen\(false\)/);
assert.match(adminShell, /depositKinicBalanceWithIdentity/);
assert.match(adminShell, /parseKinicAmount/);

assert.doesNotMatch(client, /AdminPageHeader|title="My Profile"|Manage App KINIC for marketplace purchases/);
assert.match(client, /mx-auto flex w-full max-w-3xl flex-col gap-6/);
assert.doesNotMatch(client, /!principal \? \(\s*<AdminPanel/);
assert.match(client, /App KINIC balance/);
assert.match(client, /label="App KINIC balance"[\s\S]*label="Refresh profile"/);
assert.match(client, /Deposit KINIC/);
assert.match(client, /Withdraw KINIC/);
assert.match(client, /kinicGetBalance\(canisterId, identity\)/);
assert.match(client, /depositKinicBalanceWithIdentity/);
assert.match(client, /kinicWithdrawBalance/);
assert.match(client, /parsePrincipalText/);
assert.match(client, /Enter a valid recipient principal/);
assert.match(client, /Recipient receives amount\. App balance decreases by amount plus ledger fee\./);
assert.match(client, /Direct ledger transfers are not credited to App balance\./);
assert.doesNotMatch(client, /kinicListPendingOperations|Pending operations|No pending operations|OperationRow/);
assert.doesNotMatch(client, /Login with Internet Identity to manage App KINIC\./);
assert.doesNotMatch(client, /Withdraw is not available/);
assert.doesNotMatch(client, /break-all.*principal|caller.*principal/i);

console.log("Profile checks OK");
