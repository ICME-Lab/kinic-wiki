import { Principal } from "@icp-sdk/core/principal";
import type { PaymentScope, PreparedPayment } from "./types";

export function normalizePaymentScope(scope: PaymentScope): PaymentScope {
  return {
    origin: new URL(scope.origin).origin,
    host: new URL(scope.host).origin,
    ledger: Principal.fromText(scope.ledger).toText(),
    spender: Principal.fromText(scope.spender).toText(),
    payer: {
      provider: scope.payer.provider,
      owner: Principal.fromText(scope.payer.owner).toText(),
    },
    target: scope.target.kind === "vault"
      ? { kind: "vault", beneficiary: Principal.fromText(scope.target.beneficiary).toText() }
      : { kind: "wiki", databaseId: scope.target.databaseId },
  };
}

// Adapters own the context and its deterministic key. The shared snapshot
// copies the summary and scope without changing the adapter's context type.
export function freezeTerms<C>(
  input: Omit<PreparedPayment<C>, "termsKey">,
  contextKey: string,
): PreparedPayment<C> {
  const scope = normalizePaymentScope(input.scope);
  Object.freeze(scope.payer);
  Object.freeze(scope.target);
  Object.freeze(scope);
  const recipient = Principal.fromText(input.recipient).toText();
  const termsKey = JSON.stringify([
    input.id,
    scope,
    recipient,
    input.amountE8s.toString(),
    input.transferFeeE8s.toString(),
    input.approvalFeeE8s.toString(),
    input.allowanceE8s.toString(),
    input.approvalRequired,
    input.credits.toString(),
    input.expiresAtNs?.toString() ?? null,
    contextKey,
  ]);
  return Object.freeze({ ...input, scope, recipient, termsKey });
}
