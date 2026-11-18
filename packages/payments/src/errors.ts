import type { PaymentErrorCode, PaymentFailureDetails, PaymentPhase } from "./types";

const codes = {
  InsufficientFunds: "InsufficientFunds",
  ApprovalRejected: "ApprovalRejected",
  Expired: "Expired",
  TooOld: "Expired",
  BadFee: "BadFee",
  TermsChanged: "TermsChanged",
  AllowanceChanged: "AllowanceChanged",
  InsufficientAllowance: "AllowanceChanged",
  Unavailable: "Unavailable",
  TemporarilyUnavailable: "Unavailable",
  Busy: "Unavailable",
  AccountChanged: "AccountChanged",
  UnsupportedAccount: "UnsupportedAccount",
  InvalidReply: "InvalidReply",
  CoordinationUnavailable: "CoordinationUnavailable",
  StorageUnavailable: "StorageUnavailable",
  Storage: "StorageUnavailable",
  Unknown: "Unknown",
} as const satisfies Record<string, PaymentErrorCode>;

export class PaymentFailure extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(code);
    this.name = "PaymentFailure";
  }
}

export function classifyPaymentFailure(stage: PaymentPhase, error: unknown): PaymentFailureDetails {
  if (error instanceof PaymentFailure) return { stage, code: error.code };
  if (typeof error === "object" && error !== null && !(error instanceof Error)) {
    const [variant, ...rest] = Object.keys(error);
    if (variant && rest.length === 0 && Object.hasOwn(codes, variant))
      return { stage, code: codes[variant as keyof typeof codes] };
  }
  return { stage, code: "Unknown" };
}

const stageLabels: Record<PaymentPhase, string> = {
  editing: "Amount validation",
  preparing: "Payment preparation",
  ready: "Payment confirmation",
  approving: "Approval",
  paying: "Payment",
  checking: "Status check",
  refreshing: "Balance update",
  complete: "Payment completion",
  unresolved: "Payment recovery",
  failed: "Payment",
};

const errorMessages: Record<PaymentErrorCode, string> = {
  InsufficientFunds: "There is not enough KINIC to cover the amount and fees.",
  ApprovalRejected: "The wallet or ledger rejected the approval.",
  Expired: "The quote has expired.",
  BadFee: "The ledger fee changed. Review the payment terms.",
  TermsChanged: "The payment terms changed. Review the current terms and confirm again.",
  AllowanceChanged: "The ledger allowance changed. Review the payment terms.",
  Unavailable: "The service is temporarily unavailable.",
  AccountChanged: "The funding account changed. Review the payment terms.",
  UnsupportedAccount: "Use a default ledger account for funding.",
  InvalidReply: "The service returned an unexpected reply.",
  CoordinationUnavailable: "This browser cannot safely coordinate payments across tabs. Use a browser with Web Locks support.",
  StorageUnavailable: "The payment record could not be saved or read.",
  Unknown: "Check the saved payment status before trying again.",
};

export function formatPaymentFailure(
  { stage, code }: PaymentFailureDetails,
  outcome: "failed" | "unresolved" = "failed",
): string {
  if (outcome === "unresolved") {
    const details = code === "Unknown" ? "" : ` ${errorMessages[code]}`;
    return `${stageLabels[stage]} outcome is unknown.${details} Check the saved payment status.`;
  }
  return `${stageLabels[stage]} failed. ${errorMessages[code]}`;
}
