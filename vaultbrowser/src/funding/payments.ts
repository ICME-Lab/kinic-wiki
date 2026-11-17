import type { Payment } from "@kinic/vault-client/contracts";

const E8S = 100_000_000n;

export function formatKinic(amount: bigint): string {
  const fraction = (amount % E8S).toString().padStart(8, "0").replace(/0+$/, "");
  return `${amount / E8S}${fraction ? `.${fraction}` : ""}`;
}

export function parseKinic(value: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw Error("InvalidAmount");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * E8S + BigInt(fraction.padEnd(8, "0"));
  if (amount <= 0n) throw Error("InvalidAmount");
  return amount;
}

export function paymentId(payment: Payment): string {
  return Array.from(payment.request.operation, b => b.toString(16).padStart(2, "0")).join("");
}

export function isPendingPayment({ status }: Payment): boolean {
  return "Quoted" in status || "Unknown" in status || "InFlight" in status;
}

export function isTerminalPayment(payment: Payment): boolean {
  return !isPendingPayment(payment);
}
