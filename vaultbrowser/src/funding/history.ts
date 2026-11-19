import { PaymentFailure } from "@kinic/payments/errors";
import { withRecoveryLock, recoveryTargetKey, type RecoveryStore } from "@kinic/payments/recovery-store";
import type { FundingAccount, PaymentCheck, PaymentScope } from "@kinic/payments/types";
import type { Payment } from "@kinic/vault-candid";
import type { BrowserConfig } from "../config";
import { decodeVaultRecoveryRecord, type VaultHistoryStatus, type VaultPaymentAdapter } from "./adapter";

export function savedVaultLedger(config: BrowserConfig, payer: FundingAccount, beneficiary: string, store: RecoveryStore) {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith("kinic.payments.v1:")) continue;
      const [origin, host, ledger, spender, target] = JSON.parse(key.slice("kinic.payments.v1:".length));
      if (origin !== location.origin || host !== new URL(config.host).origin || spender !== config.canister ||
          target?.kind !== "vault" || target.beneficiary !== beneficiary) continue;
      const scope: PaymentScope = {origin, host, ledger, spender, target, payer};
      if (recoveryTargetKey(scope) !== key) throw new PaymentFailure("StorageUnavailable");
      const record = store.list(scope)[0];
      if (record) {
        decodeVaultRecoveryRecord(record, scope);
        return ledger as string;
      }
    }
  } catch { throw new PaymentFailure("StorageUnavailable"); }
  return undefined;
}

export function readOnlyStatusLabel(result: PaymentCheck | VaultHistoryStatus) {
  if (result.kind === "paid") return "Payment complete. Credited " + result.receipt.creditedCycles + " cycles.";
  if (result.kind === "quoted") return "Status checked. The service reports a quote. Review the original payment to verify the debit.";
  if (result.kind === "unsubmitted") return "Status checked. This payment is still unpaid.";
  if (result.kind === "rejected") return "Status checked. This payment was rejected.";
  return "Status checked. Review the original payment.";
}

// Adopt only authenticated history, preserving a stronger local dispatch marker.
export async function inspectVaultHistory(adapter: VaultPaymentAdapter, store: RecoveryStore, payment: Payment, isCurrent: () => boolean) {
  const original = adapter.recordFor(payment);
  const locks = navigator.locks;
  if (!locks) return readOnlyStatusLabel(await adapter.check(original));
  await withRecoveryLock(locks, adapter.scope, async lock => {
    if (!lock || !isCurrent()) throw new PaymentFailure("Unavailable");
    const previous = store.list(adapter.scope)[0];
    if (!previous) store.put(original);
    else if (previous.id !== original.id) throw new PaymentFailure("AccountChanged");
  });
  return null;
}
