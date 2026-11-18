export type FundingAccount = { provider: "ii" | "oisy" | "plug"; owner: string };

export type CreditTarget =
  | { kind: "vault"; beneficiary: string }
  | { kind: "wiki"; databaseId: string };

export type PaymentScope = {
  origin: string;
  host: string;
  ledger: string;
  spender: string;
  payer: FundingAccount;
  target: CreditTarget;
};

export type PaymentErrorCode =
  | "InsufficientFunds"
  | "ApprovalRejected"
  | "PaymentRejected"
  | "Expired"
  | "BadFee"
  | "TermsChanged"
  | "AllowanceChanged"
  | "Unavailable"
  | "AccountChanged"
  | "UnsupportedAccount"
  | "InvalidReply"
  | "CoordinationUnavailable"
  | "StorageUnavailable"
  | "Unknown";

export type PreparedPayment<C> = Readonly<{
  id: string;
  scope: Readonly<PaymentScope & {
    payer: Readonly<FundingAccount>;
    target: Readonly<CreditTarget>;
  }>;
  context: C;
  recipient: string;
  amountE8s: bigint;
  transferFeeE8s: bigint;
  approvalFeeE8s: bigint;
  allowanceE8s: bigint;
  approvalRequired: boolean;
  credits: bigint;
  expiresAtNs: bigint | null;
  termsKey: string;
}>;

export type PaymentReceipt = { reference: string; creditedCycles: bigint };

export type PaymentCheck =
  | { kind: "paid"; receipt: PaymentReceipt; acknowledgedContext?: unknown }
  | { kind: "unsubmitted"; expired: boolean }
  | { kind: "pending"; reference?: string; requiredAction: "check" | "review" }
  | { kind: "rejected"; code: PaymentErrorCode };

export type RecoveryRecord = {
  version: 1;
  scope: PaymentScope;
  id: string;
  stage:
    | "quote-dispatched"
    | "approval-dispatched"
    | "approved"
    | "purchase-dispatched"
    | "paid";
  context: unknown;
};

export interface PaymentAdapter<C> {
  scope: PaymentScope;
  capabilities: { silentCheck: boolean; cancelUnsubmitted: boolean; scan: boolean };
  prepare(amountE8s: bigint): Promise<PreparedPayment<C>>;
  revalidate(p: PreparedPayment<C>): Promise<"unchanged" | "changed">;
  approve(p: PreparedPayment<C>): Promise<void>;
  submit(p: PreparedPayment<C>): Promise<PaymentCheck>;
  check(record: RecoveryRecord): Promise<PaymentCheck>;
  refreshCredit(): Promise<bigint>;
  encode(p: PreparedPayment<C>): unknown;
  restore(record: RecoveryRecord): Promise<PreparedPayment<C> | null>;
  cancel?(p: PreparedPayment<C>): Promise<void>;
}

export type PaymentPhase =
  | "editing"
  | "preparing"
  | "ready"
  | "approving"
  | "paying"
  | "checking"
  | "refreshing"
  | "complete"
  | "unresolved"
  | "failed";

export type PaymentSummary = Omit<PreparedPayment<unknown>, "context">;
export type PaymentFailureDetails = { stage: PaymentPhase; code: PaymentErrorCode };

export type PaymentViewState = {
  phase: PaymentPhase;
  summary?: PaymentSummary;
  receipt?: PaymentReceipt;
  balance?: bigint;
  error?: PaymentFailureDetails;
  balanceUnavailable?: true;
};
