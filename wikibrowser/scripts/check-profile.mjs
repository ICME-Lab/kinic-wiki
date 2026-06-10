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
assert.match(client, /Login with Internet Identity to view your principal and manage App KINIC\./);
assert.match(client, /disabled=\{!authReady \|\| authLoading\}/);
assert.match(client, /App KINIC balance/);
assert.match(client, /label="App KINIC balance"[\s\S]*label="Refresh profile"/);
assert.match(client, /Deposit KINIC/);
assert.doesNotMatch(client, /Credit App balance from this Internet Identity ledger balance\. Use mainly for seller proceeds or internal balance workflows\./);
assert.match(client, /getPrincipalKinicLedgerBalance\(canisterId, principal\)/);
assert.match(client, /principalLedgerBalanceLabel/);
assert.match(client, /II principal balance: \{principalLedgerBalanceLabel\}/);
assert.match(client, /const totalDepositDebit = parsedAmount \? BigInt\(parsedAmount\) \+ KINIC_LEDGER_FEE_E8S \* 2n : null;/);
assert.match(client, /const maxDepositAmountE8s = principalLedgerBalanceE8s !== null && principalLedgerBalanceE8s > KINIC_LEDGER_FEE_E8S \* 2n \? principalLedgerBalanceE8s - KINIC_LEDGER_FEE_E8S \* 2n : 0n;/);
assert.match(client, /function useMaxDepositAmount\(\)/);
assert.match(client, /Deposit requires \$\{formatTokenAmountFromE8s\(totalDepositDebit\.toString\(\)\)\} in II principal balance\./);
assert.match(client, /disabled=\{depositBusy \|\| Boolean\(amountError\) \|\| Boolean\(depositBalanceError\) \|\| principalLedgerBalanceLoading\}/);
assert.match(client, /disabled=\{depositBusy \|\| principalLedgerBalanceLoading \|\| maxDepositAmountE8s <= 0n\}/);
assert.match(client, /Total II principal debit: \{totalDepositDebit \? formatTokenAmountFromE8s\(totalDepositDebit\.toString\(\)\) : "-"\}/);
assert.match(client, /Withdraw KINIC/);
assert.match(client, /useMaxWithdrawAmount/);
assert.match(client, /Max/);
assert.match(client, /Balance: \{currentBalance\}/);
assert.doesNotMatch(client, /Ledger fee:/);
assert.match(client, /kinicGetBalance\(canisterId, identity\)/);
assert.match(client, /depositKinicBalanceWithIdentity/);
assert.match(client, /kinicWithdrawBalance/);
assert.match(client, /parsePrincipalText/);
assert.match(client, /Enter a valid recipient principal/);
assert.doesNotMatch(client, /Use Deposit and Withdraw for App balance movements\./);
assert.doesNotMatch(client, /not an App KINIC deposit address/);
assert.doesNotMatch(client, /Subaccount hex|parseSubaccountHex|withdrawSubaccount|toSubaccount/);
assert.doesNotMatch(client, /kinicListPendingOperations|Pending operations|No pending operations|OperationRow/);
assert.doesNotMatch(client, /Login with Internet Identity to manage App KINIC\./);
assert.doesNotMatch(client, /Withdraw is not available/);
assert.doesNotMatch(client, /break-all.*principal|caller.*principal/i);

console.log("Profile checks OK");
