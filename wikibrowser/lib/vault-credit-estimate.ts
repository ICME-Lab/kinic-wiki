import type { VaultTransfer } from "@kinic/credit-bridge-candid";
/** Quote-only estimates: later billing/fees can change actual reservation values. */
export function quoteEstimate(transfer: VaultTransfer) {
  const balance = transfer.balance_at_quote;
  const fee = transfer.estimated_execution_fee_cycles;
  if ("All" in transfer.requested) {
    return {
      recipient: balance > fee ? balance - fee : 0n,
      sourceDebit: balance,
      remaining: 0n,
    };
  }
  const recipient = transfer.requested.Exact;
  const sourceDebit = recipient + fee;
  return {
    recipient,
    sourceDebit,
    remaining: balance > sourceDebit ? balance - sourceDebit : 0n,
  };
}
