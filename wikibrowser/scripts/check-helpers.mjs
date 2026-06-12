import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function readProjectFile(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

export function assertNoAppBalanceSurface(source) {
  assert.doesNotMatch(
    source,
    /App balance|App KINIC balance|seller proceeds|internal balance|Deposit KINIC|kinicGetBalance|kinicDepositBalance|kinicWithdrawBalance|kinicFundDatabaseCycles|kinicListPendingOperations|depositKinicBalance|kinic_deposit_balance|kinic_withdraw_balance|kinic_fund_database_cycles|kinic_get_balance|kinic_list_pending_operations/
  );
}
