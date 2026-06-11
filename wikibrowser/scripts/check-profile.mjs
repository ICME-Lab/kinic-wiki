import assert from "node:assert/strict";
import { assertNoAppBalanceSurface, readProjectFile } from "./check-helpers.mjs";

const profile = readProjectFile("../app/profile/profile-client.tsx");
const sellerProfile = readProjectFile("../app/marketplace/seller/[principal]/seller-profile-client.tsx");
const adminShell = readProjectFile("../components/admin-shell.tsx");

assert.match(profile, /marketListEntitlements/);
assert.match(profile, /marketListSellerListings/);
assert.doesNotMatch(profile, /marketListListings/);
assert.match(profile, /Purchased databases/);
assert.match(profile, /Seller listings/);
assert.match(profile, /Total sales/);
assert.match(profile, /Ledger KINIC balance/);
assert.match(profile, /ledgerError/);
assert.match(profile, /Ledger balance unavailable/);
assert.match(profile, /Send KINIC/);
assert.match(profile, /getPrincipalKinicLedgerBalance/);
assert.match(profile, /transferKinicFromIdentity/);
assertNoAppBalanceSurface(profile);
assert.doesNotMatch(profile, /Deposit|Withdraw/);
assert.match(sellerProfile, /marketListSellerListings/);
assert.doesNotMatch(sellerProfile, /marketListListings/);
assert.doesNotMatch(sellerProfile, /sellerListings/);
assert.match(sellerProfile, /Loaded seller listings/);
assertNoAppBalanceSurface(adminShell);

console.log("Profile marketplace summary checks passed");
