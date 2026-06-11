import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const profile = readProjectFile("../app/profile/profile-client.tsx");
const adminShell = readProjectFile("../components/admin-shell.tsx");

assert.match(profile, /Ledger KINIC balance/);
assert.match(profile, /getPrincipalKinicLedgerBalance/);
assertNoAppBalanceSurface(profile);
assert.doesNotMatch(profile, /Deposit|Withdraw/);
assertNoAppBalanceSurface(adminShell);

console.log("Profile direct balance checks passed");
