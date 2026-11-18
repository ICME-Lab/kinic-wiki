import type { Payment } from "@kinic/vault-client/contracts";

export function paymentId(payment: Payment): string {
  return Array.from(payment.request.operation, b => b.toString(16).padStart(2, "0")).join("");
}

export function isPendingPayment({ status }: Payment): boolean {
  return "Quoted" in status || "Unknown" in status || "InFlight" in status;
}

export function isTerminalPayment(payment: Payment): boolean {
  return !isPendingPayment(payment);
}

export function paymentStatusLabel(payment:Payment):string {
 const labels={Quoted:"Awaiting approval",InsufficientAllowance:"Approval required",Paid:"Paid",BadFee:"Fee changed",Rejected:"Payment rejected",InFlight:"Processing payment",Unknown:"Needs status check",Expired:"Quote expired",InsufficientFunds:"Insufficient funds"};
 return labels[Object.keys(payment.status)[0] as keyof typeof labels] ?? "Payment status unavailable";
}
