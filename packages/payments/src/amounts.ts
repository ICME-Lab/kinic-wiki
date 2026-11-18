import type { PreparedPayment } from "./types";

const E8S = 100_000_000n;

export function parseKinic(input: string): bigint {
  if (!/^\d+(?:\.\d{1,8})?$/.test(input)) throw new Error("InvalidAmount");
  const [whole, fraction = ""] = input.split(".");
  const amount = BigInt(whole) * E8S + BigInt(fraction.padEnd(8, "0"));
  if (amount <= 0n) throw new Error("InvalidAmount");
  return amount;
}

export function formatKinicExact(e8s: bigint): string {
  const amount = e8s < 0n ? -e8s : e8s;
  const sign = e8s < 0n ? "-" : "";
  const fraction = (amount % E8S).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${amount / E8S}${fraction ? `.${fraction}` : ""}`;
}

export function totalDebit(p: PreparedPayment<unknown>): bigint {
  return p.amountE8s + p.transferFeeE8s + (p.approvalRequired ? p.approvalFeeE8s : 0n);
}
