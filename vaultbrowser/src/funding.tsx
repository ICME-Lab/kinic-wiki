import { useEffect, useState, useRef } from "react";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@icp-sdk/core/candid";
import type { VaultClient } from "@kinic/vault-client";
import { ok } from "@kinic/vault-client";
import type {
  Payment,
  ReconciliationProgress,
} from "@kinic/vault-client/contracts";
import { loadConfig } from "./config";
import { VaultButton } from "./vault/ui";
const ledgerIDL: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const Error = IDL.Variant({
    BadFee: IDL.Record({
      expected_fee: IDL.Nat,
    }),
    InsufficientFunds: IDL.Record({
      balance: IDL.Nat,
    }),
    AllowanceChanged: IDL.Record({
      current_allowance: IDL.Nat,
    }),
    Expired: IDL.Record({
      ledger_time: IDL.Nat64,
    }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({
      ledger_time: IDL.Nat64,
    }),
    Duplicate: IDL.Record({
      duplicate_of: IDL.Nat,
    }),
    TemporarilyUnavailable: IDL.Null,
    GenericError: IDL.Record({
      error_code: IDL.Nat,
      message: IDL.Text,
    }),
  });
  return IDL.Service({
    icrc2_approve: IDL.Func(
      [
        IDL.Record({
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          spender: Account,
          amount: IDL.Nat,
          expected_allowance: IDL.Opt(IDL.Nat),
          expires_at: IDL.Opt(IDL.Nat64),
          fee: IDL.Opt(IDL.Nat),
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
        }),
      ],
      [
        IDL.Variant({
          Ok: IDL.Nat,
          Err: Error,
        }),
      ],
      [],
    ),
  });
};
export function Funding({
  client,
  onFunded,
}: {
  client: VaultClient;
  onFunded: () => Promise<void>;
}) {
  const alive = useRef(true),
    working = useRef(false),
    approved = useRef(false);
  const currentClient = useRef(client);
  currentClient.current = client;
  const stopped = useRef(false);
  const run = useRef(0);
  const [progress, setProgress] = useState<ReconciliationProgress>();
  const [scanning, setScanning] = useState(false);
  const [fundingMode, setFundingMode] = useState<string>();
  const fundingEnabled =
    fundingMode === "production" || fundingMode === "synthetic-test-only";
  const [amount, setAmount] = useState("1");
  const [quote, setQuoteState] = useState<Payment>();
  const [savedPayments, setSavedPayments] = useState<Payment[]>([]);
  const setQuote = (payment?: Payment) => {
    setQuoteState(payment);
    if (payment)
      setSavedPayments((saved) =>
        saved.map((existing) =>
          Array.from(existing.request.operation).join() ===
          Array.from(payment.request.operation).join()
            ? payment
            : existing,
        ),
      );
  };
  const [historyReady, setHistoryReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const work = (f: (check: () => void) => Promise<void>) => {
    if (working.current) return;
    const attempt = ++run.current;
    const owner = client.identity.getPrincipal().toText();
    working.current = true;
    setBusy(true);
    setMessage("");
    const generation = client.session.capture();
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
    void f(check)
      .catch(() => {
        if (
          alive.current &&
          currentClient.current === client &&
          attempt === run.current &&
          owner === client.identity.getPrincipal().toText() &&
          client.session.capture() === generation
        )
          setMessage(
            "Request did not complete. Check the saved payment status before attempting another payment.",
          );
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
    approved.current = false;
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
          const pending = ok(result).filter(
            (p) =>
              "Unknown" in p.status ||
              "InFlight" in p.status ||
              "Quoted" in p.status,
          );
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
      run.current++;
      alive.current = false;
      stopped.current = true;
    };
  }, [client]);
  const refresh = async (check: () => void) => {
    if (!quote) return;
    const p = ok(await client.actor.payment_status(quote.request.operation))[0];
    check();
    if (p) setQuote(p);
    await onFunded();
  };
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
    <div className="grid gap-3">
      <p className="text-sm">
        {fundingEnabled
          ? "Approve only the displayed quote. Uncertain payments can be checked against ledger history; do not send replacement payments."
          : "Production funding is unavailable in this configuration. Existing payment records remain available; do not send replacement payments."}
      </p>
      {fundingMode === "synthetic-test-only" ? (
        <output>Synthetic ledger test build only. Never use real funds.</output>
      ) : null}
      {savedPayments.length > 1 ? (
        <label className="grid gap-1 text-sm">
          Saved payment
          <select
            disabled={busy}
            value={
              quote
                ? savedPayments.findIndex(
                    (p) =>
                      Array.from(p.request.operation).join() ===
                      Array.from(quote.request.operation).join(),
                  )
                : -1
            }
            onChange={(event) => {
              const payment = savedPayments[Number(event.target.value)];
              if (!payment) return;
              approved.current = false;
              setProgress(undefined);
              setQuote(payment);
            }}
          >
            {savedPayments.map((payment, index) => (
              <option key={index} value={index}>
                {Array.from(payment.request.operation)
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("")}{" "}
                · {Object.keys(payment.status)[0]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="grid gap-1 text-sm">
        KINIC amount
        <input
          aria-label="KINIC amount"
          inputMode="decimal"
          className="rounded border border-line p-2"
          value={amount}
          disabled={busy || !!quote || !fundingEnabled}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      {!quote ? (
        <VaultButton
          disabled={busy || !historyReady || !fundingEnabled}
          onClick={() =>
            work(async (check) => {
              if (!fundingEnabled) throw Error("FundingUnavailable");
              if (!/^\d+(\.\d{1,8})?$/.test(amount))
                throw Error("InvalidAmount");
              const [whole, frac = ""] = amount.split(".");
              const e8s =
                BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, "0"));
              if (e8s <= 0n) throw Error("InvalidAmount");
              const p = ok(
                await client.actor.quote_purchase({
                  operation: crypto.getRandomValues(new Uint8Array(16)),
                  beneficiary: client.identity.getPrincipal(),
                  amount_e8s: e8s,
                  min_credits: 20_000_000n,
                  created_at_time: BigInt(Date.now()) * 1_000_000n,
                }),
              );
              check();
              setQuote(p);
            })
          }
        >
          Get quote
        </VaultButton>
      ) : (
        <>
          <p className="text-sm">
            Credit: {quote.credits.toString()} cycles. Transfer fee:{" "}
            {quote.fee.toString()} e8s. Approval also costs{" "}
            {quote.fee.toString()} e8s.
          </p>
          <p className="break-all text-xs">
            Ledger: {quote.config.ledger.toText()} · Recipient:{" "}
            {quote.config.recipient.toText()}
          </p>
          <p className="break-all text-xs">
            Payment ID:{" "}
            {Array.from(quote.request.operation)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")}
          </p>
          <output>{Object.keys(quote.status)[0]}</output>
          {"Quoted" in quote.status ? (
            <VaultButton
              disabled={busy || !fundingEnabled}
              onClick={() =>
                work(async (check) => {
                  const config = await loadConfig();
                  check();
                  if (
                    config.fundingMode !== "production" &&
                    config.fundingMode !== "synthetic-test-only"
                  )
                    throw Error("FundingUnavailable");
                  const agent = HttpAgent.createSync({
                    host: config.host,
                    identity: client.identity,
                  });
                  if (config.local) await agent.fetchRootKey();
                  check();
                  const ledger = Actor.createActor<{
                    icrc2_approve: (arg: unknown) => Promise<
                      | {
                          Ok: bigint;
                        }
                      | {
                          Err: unknown;
                        }
                    >;
                  }>(ledgerIDL, {
                    agent,
                    canisterId: quote.config.ledger,
                  });
                  if (!approved.current) {
                    const result = await ledger.icrc2_approve({
                      from_subaccount: [],
                      spender: {
                        owner: Principal.fromText(config.canister),
                        subaccount: [],
                      },
                      amount: quote.request.amount_e8s + quote.fee,
                      expected_allowance: [],
                      expires_at: [quote.created_at_time + 300_000_000_000n],
                      fee: [quote.fee],
                      memo: [quote.memo],
                      created_at_time: [quote.created_at_time],
                    });
                    check();
                    if (
                      "Err" in result &&
                      !(
                        typeof result.Err === "object" &&
                        result.Err !== null &&
                        "Duplicate" in result.Err
                      )
                    )
                      throw Error("ApprovalFailed");
                    approved.current = true;
                  }
                  const paid = ok(
                    await client.actor.pay_purchase(quote.request.operation),
                  );
                  check();
                  setQuote(paid);
                  await onFunded();
                })
              }
            >
              {approved.current
                ? "Pay approved quote"
                : "Approve and pay this quote"}
            </VaultButton>
          ) : null}
          {"Unknown" in quote.status || "InFlight" in quote.status ? (
            <>
              <p className="text-sm">
                The ledger outcome is unknown. Scan ledger history for this
                exact payment. Each click makes at most ten sequential requests.
                Stopping the scan does not cancel the payment or create a
                replacement.
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
                  work(async (check) => {
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
                          await onFunded();
                          check();
                          break;
                        }
                        if (!result.can_continue) break;
                      }
                    } finally {
                      if (alive.current && currentClient.current === client)
                        setScanning(false);
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
              <VaultButton
                disabled={busy || !fundingEnabled}
                onClick={() =>
                  work(async (check) => {
                    if (!fundingEnabled) throw Error("FundingUnavailable");
                    const paid = ok(
                      await client.actor.pay_purchase(quote.request.operation),
                    );
                    check();
                    setQuote(paid);
                    await onFunded();
                  })
                }
              >
                Retry same payment
              </VaultButton>
            </>
          ) : null}
          <VaultButton disabled={busy} onClick={() => work(refresh)}>
            Check payment status
          </VaultButton>
          {"Quoted" in quote.status ? (
            <VaultButton
              disabled={busy}
              onClick={() =>
                work(async (check) => {
                  const cancelled = ok(
                    await client.actor.cancel_quote(quote.request.operation),
                  );
                  check();
                  setQuote(cancelled);
                })
              }
            >
              Cancel unpaid quote
            </VaultButton>
          ) : null}
          {[
            "Paid",
            "BadFee",
            "InsufficientFunds",
            "InsufficientAllowance",
            "Rejected",
            "Expired",
          ].some((k) => k in quote.status) ? (
            <VaultButton
              disabled={busy}
              onClick={() => {
                approved.current = false;
                setProgress(undefined);
                setQuote(
                  savedPayments.find(
                    (payment) =>
                      "Unknown" in payment.status ||
                      "InFlight" in payment.status ||
                      "Quoted" in payment.status,
                  ),
                );
              }}
            >
              New quote
            </VaultButton>
          ) : null}
        </>
      )}
      {message ? (
        <p role="alert" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
