import { useCallback, useEffect, useState, useRef } from "react";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { formatKinicExact, parseKinic } from "@kinic/payments/amounts";
import { classifyPaymentFailure, formatPaymentFailure, PaymentFailure } from "@kinic/payments/errors";
import type { PaymentFailureDetails, PaymentPhase } from "@kinic/payments/types";
import { ledgerIDL } from "./funding/ledger";
import { paymentStatusLabel, paymentId, isPendingPayment, isTerminalPayment } from "./funding/payments";
import type { VaultClient } from "@kinic/vault-client";
import { ok } from "@kinic/vault-client";
import type {
  Payment,
  ReconciliationProgress,
} from "@kinic/vault-client/contracts";
import { loadConfig } from "./config";
import { VaultButton, VaultField } from "./vault/ui";

const quoteDeadline = (payment: Payment) => payment.created_at_time + 300_000_000_000n;
const quoteExpired = (payment: Payment) => BigInt(Date.now()) * 1_000_000n >= quoteDeadline(payment);

function quoteKey(payment: Payment): string {
  return JSON.stringify([
    paymentId(payment),
    payment.wallet.toText(),
    payment.request.beneficiary.toText(),
    payment.request.amount_e8s.toString(),
    payment.request.min_credits.toString(),
    payment.request.created_at_time.toString(),
    payment.config.ledger.toText(),
    payment.config.recipient.toText(),
    payment.config.cycles_per_kinic.toString(),
    payment.fee.toString(),
    payment.credits.toString(),
    Array.from(payment.memo),
    payment.created_at_time.toString(),
  ]);
}

const stageCopy: Partial<Record<PaymentPhase, string>> = {
  preparing: "Preparing payment",
  approving: "Approving",
  paying: "Paying",
  checking: "Checking payment",
  refreshing: "Updating balance",
};

type Advance = (stage: PaymentPhase) => void;
type PendingFailure = PaymentFailureDetails & { confirmUnsubmitted?: true };
const pendingFailureMessage = (failure: PendingFailure) =>
  formatPaymentFailure(failure, failure.confirmUnsubmitted ? "failed" : "unresolved");

export function Funding({
  client,
  onFunded,
}: {
  client: VaultClient;
  onFunded: () => Promise<void>;
}) {
  const alive = useRef(true), working = useRef(false);
  const approved = useRef(new Map<string, string>());
  const unresolved = useRef(new Map<string, PendingFailure>());
  const expiredByServer = useRef(new Set<string>());
  const currentClient = useRef(client);
  currentClient.current = client;
  const stopped = useRef(false);
  const run = useRef(0);
  const invalidateRequests = useCallback(() => {
    run.current++;
    alive.current = false;
    stopped.current = true;
  }, []);
  const [progress, setProgress] = useState<ReconciliationProgress>();
  const [scanning, setScanning] = useState(false);
  const [fundingMode, setFundingMode] = useState<string>();
  const fundingEnabled =
    fundingMode === "production" || fundingMode === "synthetic-test-only";
  const [draftAmount, setDraftAmount] = useState("1");
  const [quote, setQuoteState] = useState<Payment>();
  const [savedPayments, setSavedPayments] = useState<Payment[]>([]);
  const setQuote = (payment?: Payment) => {
    setQuoteState(payment);
    if (payment)
      setSavedPayments((saved) =>
        saved.map((existing) =>
          paymentId(existing) === paymentId(payment)
            ? payment
            : existing,
        ),
      );
  };
  const [historyReady, setHistoryReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const work = (
    initialStage: PaymentPhase,
    f: (check: () => void, advance: Advance) => Promise<void>,
  ) => {
    if (working.current) return;
    const attempt = ++run.current;
    const owner = client.identity.getPrincipal().toText();
    working.current = true;
    setBusy(true);
    setMessage("");
    const generation = client.session.capture();
    let stage = initialStage;
    const check = () => {
      if (
        !alive.current ||
        currentClient.current !== client ||
        owner !== client.identity.getPrincipal().toText() ||
        attempt !== run.current ||
        generation !== client.session.capture()
      )
        throw Error("Locked");
    };
    const advance: Advance = (next) => {
      check();
      stage = next;
      setStatusMessage(stageCopy[stage] ?? "");
    };
    void (async () => {
      advance(initialStage);
      await f(check, advance);
    })()
      .catch((error: unknown) => {
        if (
          alive.current &&
          currentClient.current === client &&
          attempt === run.current &&
          owner === client.identity.getPrincipal().toText() &&
          client.session.capture() === generation
        ) {
          setStatusMessage("");
          const pending = quote && unresolved.current.get(paymentId(quote));
          const failure = formatPaymentFailure(classifyPaymentFailure(stage, error));
          if (!pending) setMessage(failure);
          else {
            const paymentMessage = pendingFailureMessage(pending);
            setMessage(pending.stage === stage ? paymentMessage : `${failure} ${paymentMessage}`);
          }
        }
      })
      .finally(() => {
        if (attempt === run.current) {
          working.current = false;
          if (alive.current && currentClient.current === client) setBusy(false);
        }
      });
  };
  useEffect(() => {
    let active = true;
    alive.current = true;
    const generation = client.session.capture();
    const owner = client.identity.getPrincipal().toText();
    const valid = () =>
      active &&
      currentClient.current === client &&
      owner === client.identity.getPrincipal().toText() &&
      generation === client.session.capture();
    setQuote(undefined);
    setSavedPayments([]);
    setProgress(undefined);
    setHistoryReady(false);
    setFundingMode(undefined);
    setBusy(false);
    setScanning(false);
    working.current = false;
    approved.current.clear();
    unresolved.current.clear();
    expiredByServer.current.clear();
    setMessage("");
    setStatusMessage("");
    void loadConfig()
      .then((config) => {
        if (valid()) setFundingMode(config.fundingMode);
      })
      .catch(() => {
        if (valid()) setFundingMode(undefined);
      });
    void client.actor
      .list_payments()
      .then((result) => {
        if (valid()) {
          const pending = ok(result).filter(isPendingPayment);
          setSavedPayments(pending);
          if (pending[0]) setQuote(pending[0]);
          setHistoryReady(true);
        }
      })
      .catch(() => {
        if (valid())
          setMessage(
            "Could not load previous payments. Check payment history before funding.",
          );
      });
    return () => {
      active = false;
      invalidateRequests();
    };
  }, [client, invalidateRequests]);
  const readPaymentStatus = async (payment: Payment, check: () => void) => {
    const result = await client.actor.payment_status(payment.request.operation);
    check();
    if ("Err" in result)
      throw new PaymentFailure(classifyPaymentFailure("checking", result.Err).code);
    const current = result.Ok[0];
    if (
      !current || paymentId(current) !== paymentId(payment) ||
      current.wallet.toText() !== client.identity.getPrincipal().toText()
    ) throw new PaymentFailure("InvalidReply");
    return current;
  };
  const updateBalance = async (
    check: () => void,
    advance: Advance,
    completionMessage: string,
  ) => {
    advance("refreshing");
    setStatusMessage(`${completionMessage} Updating balance.`);
    try {
      await onFunded();
    } catch {
      check();
      setMessage((previous) =>
        previous ? `${previous} Balance could not be updated.` : "Balance could not be updated.",
      );
    }
    check();
    setStatusMessage(completionMessage);
  };
  const refresh = async (check: () => void, advance: Advance) => {
    if (!quote) return;
    const payment = await readPaymentStatus(quote, check);
    const id = paymentId(payment);
    const pending = unresolved.current.get(id);
    if (
      isTerminalPayment(payment) ||
      (pending?.confirmUnsubmitted && "Quoted" in payment.status &&
        !payment.uncertain && !payment.preparing && quoteKey(payment) === quoteKey(quote))
    ) unresolved.current.delete(id);
    setQuote(payment);
    const stillPending = unresolved.current.get(id);
    setMessage(stillPending ? pendingFailureMessage(stillPending) : "");
    await updateBalance(check, advance, `Status check complete: ${paymentStatusLabel(payment)}.`);
  };
  const submitPurchase = async (payment: Payment, check: () => void, advance: Advance) => {
    advance("paying");
    const id = paymentId(payment);
    const result = await client.actor.pay_purchase(payment.request.operation).catch((error: unknown) => {
      check();
      unresolved.current.set(id, classifyPaymentFailure("paying", error));
      throw error;
    });
    check();
    if ("Err" in result) {
      const failure = classifyPaymentFailure("paying", result.Err);
      if ("Quoted" in payment.status && "Expired" in result.Err) {
        expiredByServer.current.add(id);
      } else {
        // Vault returns Busy from the lease check before beginning a debit.
        const confirmUnsubmitted = "Quoted" in payment.status && "Busy" in result.Err;
        unresolved.current.set(id, confirmUnsubmitted ? { ...failure, confirmUnsubmitted: true } : failure);
      }
      throw new PaymentFailure(failure.code);
    }
    const paid = result.Ok;
    if (paymentId(paid) !== id) {
      unresolved.current.set(id, { stage: "paying", code: "InvalidReply" });
      throw new PaymentFailure("InvalidReply");
    }
    setQuote(paid);
    if ("Unknown" in paid.status || "InFlight" in paid.status) {
      setStatusMessage("");
      setMessage(formatPaymentFailure({ stage: "paying", code: "Unknown" }, "unresolved"));
      return;
    }
    if ("Quoted" in paid.status) throw new PaymentFailure("Unavailable");
    if (!("Paid" in paid.status))
      throw new PaymentFailure(classifyPaymentFailure("paying", paid.status).code);
    await updateBalance(check, advance, "Payment complete.");
  };
  const payQuote = async (payment: Payment, check: () => void, advance: Advance) => {
    const config = await loadConfig();
    check();
    if (config.fundingMode !== "production" && config.fundingMode !== "synthetic-test-only")
      throw new PaymentFailure("Unavailable");
    const id = paymentId(payment);
    const terms = quoteKey(payment);
    const recheck = async () => {
      const current = await readPaymentStatus(payment, check);
      if (!("Quoted" in current.status) || quoteKey(current) !== terms) {
        setQuote(current);
        setStatusMessage("");
        setMessage("The payment terms changed. Review the current payment status and terms.");
        return false;
      }
      if (quoteExpired(current)) throw new PaymentFailure("Expired");
      return true;
    };

    if (unresolved.current.has(id) || expiredByServer.current.has(id)) return;
    if (!await recheck()) return;
    const approvalKey = approved.current.get(id);
    if (approvalKey && approvalKey !== terms) {
      setStatusMessage("");
      setMessage("The payment terms changed after approval. Check the saved payment status.");
      return;
    }
    if (!approvalKey) {
      const agent = HttpAgent.createSync({ host: config.host, identity: client.identity });
      if (config.local) await agent.fetchRootKey();
      advance("approving");
      if (quoteExpired(payment)) throw new PaymentFailure("Expired");
      const ledger = Actor.createActor<{
        icrc2_approve: (arg: unknown) => Promise<{ Ok: bigint } | { Err: unknown }>;
      }>(ledgerIDL, { agent, canisterId: payment.config.ledger });
      const result = await ledger.icrc2_approve({
        from_subaccount: [],
        spender: { owner: Principal.fromText(config.canister), subaccount: [] },
        amount: payment.request.amount_e8s + payment.fee,
        expected_allowance: [],
        expires_at: [quoteDeadline(payment)],
        fee: [payment.fee],
        memo: [payment.memo],
        created_at_time: [payment.created_at_time],
      }).catch((error: unknown) => {
        check();
        unresolved.current.set(id, classifyPaymentFailure("approving", error));
        throw error;
      });
      check();
      if ("Err" in result && !(result.Err && typeof result.Err === "object" && "Duplicate" in result.Err)) {
        const { code } = classifyPaymentFailure("approving", result.Err);
        throw new PaymentFailure(code === "Unknown" ? "ApprovalRejected" : code);
      }
      approved.current.set(id, terms);
      advance("checking");
      if (!await recheck()) return;
    }
    await submitPurchase(payment, check, advance);
  };
  const quoted = !!quote && "Quoted" in quote.status;
  const quoteId = quote && paymentId(quote);
  const pendingFailure = quoteId && unresolved.current.get(quoteId);
  const expired = quoted && !!quote && (quoteExpired(quote) || expiredByServer.current.has(paymentId(quote)));
  const savedCursor = quote?.reconciliation[0];
  const scanProgress =
    progress ??
    (quote && savedCursor
      ? {
          payment: quote,
          scanned: 0n,
          next: savedCursor.next,
          end: savedCursor.end,
          can_continue: savedCursor.next < savedCursor.end,
        }
      : undefined);
  return (
    <div className="vault-funding">
      <h3>Add prepaid balance</h3>
      {!fundingEnabled ? (
        <p className="vault-notice vault-notice--warn">
          Funding is unavailable. You can still check existing payments.
        </p>
      ) : null}
      {savedPayments.length > 1 ? (
        <label className="vault-field">
          <span>Saved payment</span>
          <select
            className="vault-select"
            disabled={busy}
            value={
              quote
                ? savedPayments.findIndex(
                    (p) =>
                      paymentId(p) === paymentId(quote),
                  )
                : -1
            }
            onChange={(event) => {
              const payment = savedPayments[Number(event.target.value)];
              if (!payment) return;
              const pending = unresolved.current.get(paymentId(payment));
              setMessage(pending ? pendingFailureMessage(pending) : "");
              setStatusMessage("");
              setProgress(undefined);
              setQuote(payment);
            }}
          >
            {savedPayments.map((payment, index) => (
              <option key={paymentId(payment)} value={index}>
                {paymentId(payment)}{" "}
                · {paymentStatusLabel(payment)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <VaultField
        label="KINIC amount"
        inputMode="decimal"
        value={quote ? formatKinicExact(quote.request.amount_e8s) : draftAmount}
        disabled={busy || !!quote || !fundingEnabled}
        onChange={(e) => setDraftAmount(e.target.value)}
      />
      {!quote ? (
        <VaultButton
          disabled={busy || !historyReady || !fundingEnabled}
          onClick={() =>
            work("preparing", async (check) => {
              if (!fundingEnabled) throw new PaymentFailure("Unavailable");
              let amountE8s: bigint;
              try {
                amountE8s = parseKinic(draftAmount);
              } catch {
                setStatusMessage("");
                setMessage("Enter a positive KINIC amount with up to 8 decimal places.");
                return;
              }
              const result = await client.actor.quote_purchase({
                operation: crypto.getRandomValues(new Uint8Array(16)),
                beneficiary: client.identity.getPrincipal(),
                amount_e8s: amountE8s,
                min_credits: 20_000_000n,
                created_at_time: BigInt(Date.now()) * 1_000_000n,
              });
              check();
              if ("Err" in result)
                throw new PaymentFailure(classifyPaymentFailure("preparing", result.Err).code);
              setQuote(result.Ok);
              setStatusMessage("");
            })
          }
        >
          Get quote
        </VaultButton>
      ) : (
        <>
          <p className="text-sm">
            Credit: {quote.credits.toString()} cycles. Transfer fee:{" "}
            {formatKinicExact(quote.fee)} KINIC. Approval also costs{" "}
            {formatKinicExact(quote.fee)} KINIC.
          </p>
          <details className="vault-payment-details text-xs">
            <summary>Payment details</summary>
            <div className="space-y-2 pt-2">
              <p className="break-all">
                Ledger: {quote.config.ledger.toText()} · Recipient: {quote.config.recipient.toText()}
              </p>
              <p className="break-all">Payment ID: {paymentId(quote)}</p>
            </div>
          </details>
          <output>{paymentStatusLabel(quote)}</output>
          {expired && !pendingFailure ? (
            <p className="text-sm">This quote has expired. Prepare a new quote to review current terms.</p>
          ) : null}
          {quoted && !pendingFailure && !expired ? (
            <VaultButton
              disabled={busy || !fundingEnabled}
              onClick={() =>
                work("checking", (check, advance) => payQuote(quote, check, advance))
              }
            >
              {quoteId && approved.current.has(quoteId)
                ? "Pay approved quote"
                : "Approve and pay this quote"}
            </VaultButton>
          ) : null}
          {"Unknown" in quote.status || "InFlight" in quote.status ? (
            <>
              <p className="text-sm">
                {pendingFailure
                  ? "Payment status is uncertain. Check this payment or scan the ledger."
                  : "Payment status is uncertain. Check or retry this payment."}
                {" "}Stopping the scan leaves the payment active.
              </p>
              {scanProgress ? (
                <output aria-live="polite">
                  Ledger scan: next {scanProgress.next.toString()} of{" "}
                  {scanProgress.end.toString()}. Last request scanned{" "}
                  {scanProgress.scanned.toString()} blocks.
                  {!scanProgress.can_continue &&
                  !("Paid" in scanProgress.payment.status)
                    ? " No matching payment evidence found yet."
                    : ""}
                </output>
              ) : null}
              <VaultButton
                disabled={busy || !fundingEnabled}
                onClick={() => {
                  stopped.current = false;
                  setScanning(true);
                  work("checking", async (check, advance) => {
                    try {
                      for (let call = 0; call < 10; call++) {
                        check();
                        if (stopped.current) break;
                        const result = await client.reconcilePurchase(
                          new Uint8Array(quote.request.operation),
                        );
                        check();
                        if (stopped.current) break;
                        setQuote(result.payment);
                        setProgress(result);
                        if ("Paid" in result.payment.status) {
                          await updateBalance(check, advance, "Payment complete.");
                          break;
                        }
                        if (!result.can_continue) break;
                      }
                    } finally {
                      if (alive.current && currentClient.current === client) {
                        setStatusMessage((previous) => previous === stageCopy.checking ? "" : previous);
                        setScanning(false);
                      }
                    }
                  });
                }}
              >
                {scanProgress
                  ? "Resume ledger scan"
                  : "Scan ledger for this payment"}
              </VaultButton>
              {scanning ? (
                <VaultButton
                  onClick={() => {
                    stopped.current = true;
                  }}
                >
                  Stop ledger scan
                </VaultButton>
              ) : null}
              {!pendingFailure ? <VaultButton
                disabled={busy || !fundingEnabled}
                onClick={() =>
                  work("paying", async (check, advance) => {
                    if (!fundingEnabled) throw new PaymentFailure("Unavailable");
                    await submitPurchase(quote, check, advance);
                  })
                }
              >
                Retry same payment
              </VaultButton> : null}
            </>
          ) : null}
          <VaultButton disabled={busy} onClick={() => work("checking", refresh)}>
            Check payment status
          </VaultButton>
          {/* Approval uncertainty has not dispatched a purchase. The server can
              cancel that quote safely; purchase uncertainty must stay fenced. */}
          {quoted && (!pendingFailure || pendingFailure.stage === "approving") ? (
            <VaultButton
              disabled={busy}
              onClick={() =>
                work("checking", async (check) => {
                  const result = await client.actor.cancel_quote(quote.request.operation);
                  check();
                  if ("Err" in result)
                    throw new PaymentFailure(classifyPaymentFailure("checking", result.Err).code);
                  const cancelled = result.Ok;
                  if (paymentId(cancelled) !== quoteId || !("Expired" in cancelled.status))
                    throw new PaymentFailure("InvalidReply");
                  unresolved.current.delete(paymentId(cancelled));
                  setQuote(cancelled);
                  if (expired) {
                    setDraftAmount(formatKinicExact(quote.request.amount_e8s));
                    setQuote(savedPayments.find((p) => paymentId(p) !== quoteId && isPendingPayment(p)));
                  }
                  setStatusMessage("");
                })
              }
            >
              {expired ? "Prepare a new quote" : "Cancel unpaid quote"}
            </VaultButton>
          ) : null}
          {isTerminalPayment(quote) ? (
            <VaultButton
              disabled={busy}
              onClick={() => {
                setMessage("");
                setStatusMessage("");
                setProgress(undefined);
                setQuote(
                  savedPayments.find(isPendingPayment),
                );
              }}
            >
              New quote
            </VaultButton>
          ) : null}
        </>
      )}
      <output aria-label="Payment progress" aria-live="polite">{statusMessage}</output>
      {message ? (
        <p role="alert" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
