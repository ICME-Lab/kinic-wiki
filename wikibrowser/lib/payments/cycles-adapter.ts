import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { PaymentFailure } from "@kinic/payments/errors";
import { assertLedgerFee, readLedgerTerms } from "@kinic/payments/ledger";
import { samePaymentScope, type RecoveryStore } from "@kinic/payments/recovery-store";
import { freezeTerms, normalizePaymentScope } from "@kinic/payments/terms";
import type { FundingAccount, PaymentAdapter, PaymentCheck, PreparedPayment, PaymentErrorCode, RecoveryRecord } from "@kinic/payments/types";
import type { WalletSessionManager } from "@kinic/payments/wallet-session";
import { z } from "zod";
import { cyclesForPaymentAmountE8s, KINIC_LEDGER_FEE_E8S, MAX_CANISTER_I64 } from "../cycles";
import type { CyclesBillingConfig, DatabaseCycleEntry } from "../types";
import { getCyclesBillingConfig, listDatabaseCycleEntries, listDatabaseCyclesPendingPurchasesAuthenticated, listDatabasesAuthenticated } from "../vfs-client";
import { DecodedCanisterError } from "../vfs-client/actor";
import type { DatabaseCyclesPurchaseRequest } from "../vfs-client/raw-types";
import { callWikiWithPayer, configuredIcHost, wikiPaymentScopes } from "../wallet-runtime";

export { wikiPaymentScopes };
const recipient = "isz6c-6c4pl-oba7w-ikjex-472yu-rf3fe-valdh-lfazm-5f3ep-v474i-qae";
const nowNs = () => BigInt(Date.now()) * 1000000n;
const approvalLifetime = 30n * 60n * 1000000000n;
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const savedContext = z.strictObject({
  version: z.literal(1), id: z.string().min(1), databaseId: z.string().min(1), managerPrincipal: z.string(),
  ledger: z.string(), payer: z.strictObject({ provider: z.enum(["ii", "plug", "oisy"]), owner: z.string() }),
  amount: decimal, credits: decimal, rate: decimal, fee: decimal, previousAllowance: decimal, approvalRequired: z.boolean(),
  createdAtNs: decimal, expiresAtNs: decimal.nullable(), baseline: decimal.nullable(), dispatchedAtNs: decimal.nullable(),
  block: decimal.nullable(), operation: decimal.nullable()
});
type Saved = z.infer<typeof savedContext>;
const paidMarker = z.strictObject({
  receipt: z.strictObject({ reference: decimal, creditedCycles: decimal, balanceAfterCycles: decimal.optional() }),
  acknowledged: z.strictObject({
    request: savedContext, termsKey: z.string().min(1), dispatchedAtNs: decimal, block: decimal, creditedCycles: decimal, balanceAfterCycles: decimal.optional()
  })
});
export type WikiCyclesContext = Readonly<{
  request: Readonly<DatabaseCyclesPurchaseRequest>; payer: Readonly<FundingAccount>; ledger: string; rate: bigint;
  baseline: string | null; createdAtNs: bigint; previousAllowance: bigint; managerPrincipal: string;
}>;

export function createWikiBillingClient(config: CyclesBillingConfig) {
  return {
    config, getConfig: getCyclesBillingConfig, ledgerTerms: readLedgerTerms,
    pending: listDatabaseCyclesPendingPurchasesAuthenticated, history: listDatabaseCycleEntries,
    async credit(canisterId: string, identity: Identity, databaseId: string) {
      const databases = await listDatabasesAuthenticated(canisterId, identity);
      const database = databases.find(item => item.databaseId === databaseId);
      if (!database) throw new PaymentFailure("Unavailable");
      return BigInt(database.cyclesBalance);
    }
  };
}

type Options = {
  canisterId: string; databaseId: string; authIdentity?: Identity; walletSession: WalletSessionManager;
  billingClient: Omit<ReturnType<typeof createWikiBillingClient>, "pending"> & {
    pending(canisterId: string, identity: Identity, databaseId: string): Promise<readonly unknown[]>;
  };
  canRefreshCredit?: boolean; refreshPayer?: () => Promise<void>;
  store: RecoveryStore; source?: FundingAccount["provider"]; origin?: string; isCurrent?: () => boolean;
};

export function createWikiCyclesPaymentAdapter({
  canisterId, databaseId, authIdentity, walletSession, billingClient, store, source, origin, isCurrent, canRefreshCredit, refreshPayer
}: Options): PaymentAdapter<WikiCyclesContext> & { destroy(): void } {
  const ledger = billingClient.config.kinicLedgerCanisterId;
  const scopes = wikiPaymentScopes(canisterId, ledger);
  const selected = walletSession.getSnapshot();
  const identityTransport = authIdentity ? walletSession.getIdentityTransport(scopes) : null;
  const managerPrincipal = authIdentity?.getPrincipal().toText() ?? selected.account?.owner ?? "";
  if (!databaseId || canisterId !== import.meta.env.VITE_KINIC_WIKI_CANISTER_ID
    || (authIdentity && (!identityTransport || identityTransport.account.owner !== managerPrincipal))) throw new PaymentFailure("AccountChanged");
  const transport = (source ?? selected.account?.provider) === "ii" ? identityTransport : selected.transport;
  if (!transport || (source && transport.account.provider !== source)) throw new PaymentFailure("AccountChanged");
  const external = transport.account.provider !== "ii";
  const scope = normalizePaymentScope({ origin: origin ?? window.location.origin, host: configuredIcHost(), ledger,
    spender: canisterId, payer: transport.account, target: { kind: "wiki", databaseId } });
  Object.freeze(scope.target);
  Object.freeze(scope.payer);
  Object.freeze(scope);
  const token = walletSession.capture();
  let destroyed = false;
  let activePayment: PreparedPayment<WikiCyclesContext> | null = null;
  let approvedId: string | null = null;
  let submittedId: string | null = null;
  // Only a reply to this live dispatch can link a server-selected operation
  // or block to the original request. Stored saga identifiers are hints.
  let sagaReply: { id: string; termsKey: string; dispatchedAtNs: string; operation: string; block: string | null } | null = null;
  let liveAcknowledgement: { id:string; termsKey:string; dispatchedAtNs:string; block:string; creditedCycles:string; balanceAfterCycles:string } | null = null;
  let historyCursor: string | null = null;
  let historyOperation: string | null = null;
  let preparationCursor: string | null = null;
  let checkedExpiredId: string | null = null;
  const current = () => !destroyed && walletSession.isCurrent(token) && (!isCurrent || isCurrent())
    && (!external || walletSession.hasScopes(scopes)) && (!authIdentity || authIdentity.getPrincipal().toText() === managerPrincipal);
  const assertCurrent = () => { if (!current()) throw new PaymentFailure("AccountChanged"); };
  const pendingReview = (reference?: string): PaymentCheck =>
    ({ kind: "pending", requiredAction: "review", ...(reference ? {reference} : {}) });
  const emptyPayer = `principal cannot view pending cycle purchases: ${databaseId}`;
  // Both wire spellings come from the decoded VFS result for this exact database.
  // The Wasm SQLite backend adds its error-code prefix.
  const decodedReplyMatches = (message: string, expected: string) => message === expected || message === "sqlite error 1: " + expected;
  const emptyPayerReply = (message: string) => decodedReplyMatches(message, emptyPayer);
  const readPayerPending = () => callWikiWithPayer(transport!, canisterId, "list_database_cycles_pending_purchases", [databaseId], current);

  async function facts() {
    assertCurrent();
    await transport!.revalidate();
    assertCurrent();
    const [config, pending, payerPending] = await Promise.all([billingClient.getConfig(canisterId),
      authIdentity ? billingClient.pending(canisterId, authIdentity, databaseId).catch(error => {
        // Non-owners get this response when they have no visible pending rows.
        // The purchase endpoint still enforces its per-payer pending guard.
        if (error instanceof DecodedCanisterError && emptyPayerReply(error.message)) return [];
        throw error;
      }) : Promise.resolve([]),
      external ? readPayerPending() : null]);
    assertCurrent();
    if (pending.length || (payerPending && ("Err" in payerPending ? !emptyPayerReply(payerPending.Err) : payerPending.Ok.length > 0)))
      throw new PaymentFailure("Unavailable");
    if (config.kinicLedgerCanisterId !== ledger) throw new PaymentFailure("TermsChanged");
    const terms = await billingClient.ledgerTerms({ host: scope.host, ledger, owner: scope.payer.owner, spender: canisterId });
    assertCurrent();
    if (terms.decimals !== 8) throw new PaymentFailure("InvalidReply");
    assertLedgerFee(terms.feeE8s, KINIC_LEDGER_FEE_E8S);
    return { ...terms, rate: BigInt(config.cyclesPerKinic) };
  }
  async function history(after: string | null, match?: (entry: DatabaseCycleEntry) => boolean) {
    if (!authIdentity) throw new PaymentFailure("Unavailable");
    let cursor = after;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      assertCurrent();
      const page = await billingClient.history(canisterId, databaseId, cursor, 100, authIdentity);
      assertCurrent();
      let last = cursor;
      for (const row of page.entries) {
        if (row.databaseId !== databaseId || !decimal.safeParse(row.entryId).success ||
          BigInt(row.entryId) <= BigInt(last ?? 0) || BigInt(row.entryId) > MAX_CANISTER_I64) throw new PaymentFailure("InvalidReply");
        last = row.entryId;
      }
      if (page.nextCursor !== null && (page.nextCursor !== last || last === cursor)) throw new PaymentFailure("InvalidReply");
      const entry = match && page.entries.find(match);
      if (entry || page.nextCursor === null) return { cursor: last, entry };
      cursor = page.nextCursor;
    }
    // A partial baseline is a lower bound. A credit still needs its original
    // certified operation/block and matching database ledger entry.
    return {cursor, entry:undefined};
  }
  function snapshot(s: Saved) {
    if (s.databaseId !== databaseId || s.managerPrincipal !== managerPrincipal || s.ledger !== ledger
      || s.payer.owner !== scope.payer.owner || s.payer.provider !== scope.payer.provider
      || BigInt(s.amount) <= 0n || BigInt(s.amount) > MAX_CANISTER_I64 || BigInt(s.fee) !== KINIC_LEDGER_FEE_E8S
      || BigInt(s.credits) !== cyclesForPaymentAmountE8s(BigInt(s.amount), BigInt(s.rate))
      || (s.approvalRequired && BigInt(s.expiresAtNs ?? 0) !== BigInt(s.createdAtNs) + approvalLifetime)) throw new PaymentFailure("InvalidReply");
    const request = Object.freeze({ database_id: databaseId, payment_amount_e8s: BigInt(s.amount), min_expected_cycles: BigInt(s.credits) });
    const context = Object.freeze({ request, payer: scope.payer, ledger, rate: BigInt(s.rate), baseline: s.baseline,
      createdAtNs: BigInt(s.createdAtNs), previousAllowance: BigInt(s.previousAllowance), managerPrincipal });
    return freezeTerms({ id: s.id, scope, context, recipient, amountE8s: BigInt(s.amount),
      credits: BigInt(s.credits), transferFeeE8s: BigInt(s.fee), approvalRequired: s.approvalRequired,
      approvalFeeE8s: s.approvalRequired ? BigInt(s.fee) : 0n, allowanceE8s: BigInt(s.amount) + BigInt(s.fee),
      expiresAtNs: s.expiresAtNs === null ? null : BigInt(s.expiresAtNs) },
      JSON.stringify([s.rate, s.previousAllowance, s.createdAtNs, s.managerPrincipal, s.baseline]));
  }
  function decode(record: RecoveryRecord) {
    if (!samePaymentScope(record.scope, scope)) throw new PaymentFailure("AccountChanged");
    const result = savedContext.safeParse(record.context);
    if (!result.success || result.data.id !== record.id) throw new PaymentFailure("InvalidReply");
    const s = result.data;
    if (record.stage === "quote-dispatched" || record.stage === "paid"
      || ((record.stage === "approval-dispatched" || record.stage === "approved")
        && (!s.approvalRequired || s.dispatchedAtNs !== null || s.operation !== null || s.block !== null))
      || ((s.operation !== null || s.block !== null) && s.dispatchedAtNs === null)
      || (s.block !== null && s.operation === null)) throw new PaymentFailure("InvalidReply");
    return { saved: s, payment: snapshot(s) };
  }
  function recoverAcknowledgement(record: RecoveryRecord): PaymentCheck {
    const original = store.list(scope)[0];
    if (!original || original.stage !== "paid" || record.id !== original.id || !samePaymentScope(record.scope, scope)) return pendingReview();
    const parsed = paidMarker.safeParse(record.context);
    const durable = paidMarker.safeParse(original.context);
    if (!parsed.success || !durable.success || JSON.stringify(parsed.data) !== JSON.stringify(durable.data)) return pendingReview();
    const { acknowledged, receipt } = parsed.data;
    const live = liveAcknowledgement;
    const s = acknowledged.request;
    const p = snapshot(s);
    if (!live || live.id !== s.id || live.termsKey !== acknowledged.termsKey
      || live.dispatchedAtNs !== acknowledged.dispatchedAtNs || live.block !== acknowledged.block
      || live.creditedCycles !== acknowledged.creditedCycles || live.balanceAfterCycles !== acknowledged.balanceAfterCycles
      || s.id !== record.id || s.dispatchedAtNs === null || s.operation !== null || s.block !== null
      || BigInt(s.dispatchedAtNs) < BigInt(s.createdAtNs)
      || (p.expiresAtNs !== null && BigInt(s.dispatchedAtNs) >= p.expiresAtNs)
      || acknowledged.dispatchedAtNs !== s.dispatchedAtNs || acknowledged.termsKey !== p.termsKey || receipt.reference !== acknowledged.block
      || receipt.creditedCycles !== acknowledged.creditedCycles || receipt.balanceAfterCycles !== acknowledged.balanceAfterCycles
      || BigInt(receipt.creditedCycles) < p.credits) return pendingReview();
    return { kind: "paid", receipt: { reference: receipt.reference, creditedCycles: BigInt(receipt.creditedCycles),
      ...(receipt.balanceAfterCycles === undefined ? {} : {balanceAfterCycles: BigInt(receipt.balanceAfterCycles)}) },
      acknowledgedContext: acknowledged };
  }
  function encode(p: PreparedPayment<WikiCyclesContext>): Saved {
    return { version: 1, id: p.id, databaseId: p.context.request.database_id, managerPrincipal: p.context.managerPrincipal,
      ledger: p.context.ledger, payer: p.scope.payer, amount: p.amountE8s.toString(), credits: p.credits.toString(),
      rate: p.context.rate.toString(), fee: p.transferFeeE8s.toString(), previousAllowance: p.context.previousAllowance.toString(),
      approvalRequired: p.approvalRequired, createdAtNs: p.context.createdAtNs.toString(), expiresAtNs: p.expiresAtNs?.toString() ?? null,
      baseline: p.context.baseline, dispatchedAtNs: null, block: null, operation: null };
  }
  function acknowledge(p: PreparedPayment<WikiCyclesContext>, dispatchedAtNs: string, block: string, creditedCycles: bigint, balanceAfterCycles: bigint): PaymentCheck {
    const request = { ...encode(p), dispatchedAtNs };
    liveAcknowledgement = {id:p.id, termsKey:p.termsKey, dispatchedAtNs, block, creditedCycles:creditedCycles.toString(), balanceAfterCycles:balanceAfterCycles.toString()};
    return { kind: "paid", receipt: { reference: block, creditedCycles, balanceAfterCycles },
      acknowledgedContext: { request, termsKey: p.termsKey, dispatchedAtNs, block, creditedCycles: creditedCycles.toString(), balanceAfterCycles:balanceAfterCycles.toString() } };
  }
  function dispatchGuard(p: PreparedPayment<WikiCyclesContext>, deadline: PaymentFailure) {
    return () => {
      assertCurrent();
      if (p.expiresAtNs !== null && nowNs() >= p.expiresAtNs) throw deadline;
      return true;
    };
  }
  function refreshPayerBalance() {
    if (current() && refreshPayer) void refreshPayer().catch(() => {});
  }
  function dispatchRecord(p: PreparedPayment<WikiCyclesContext>, stage: RecoveryRecord["stage"]) {
    assertCurrent();
    const record = store.list(scope)[0];
    if (!record || record.stage !== stage || record.id !== p.id || p !== activePayment
      || decode(record).payment.termsKey !== p.termsKey) throw new PaymentFailure("AccountChanged");
    return record;
  }
  return {
    scope, capabilities: { get silentCheck() { return current() && transport.silentCheck; }, get cancelUnsubmitted() { return checkedExpiredId !== null; }, refreshCredit: !!authIdentity && canRefreshCredit !== false, scan: false },
    destroy() { destroyed = true; }, encode,
    async prepare(amount) {
      if (amount <= 0n || amount > MAX_CANISTER_I64) throw new PaymentFailure("InvalidReply");
      if (store.hasTargetConflict(scope) || store.list(scope).length) throw new PaymentFailure("Unavailable");
      const terms = await facts();
      const required = amount + terms.feeE8s;
      const time = nowNs();
      const approval = terms.allowanceE8s < required || (terms.allowanceExpiresAtNs !== null && terms.allowanceExpiresAtNs <= time);
      if (terms.balanceE8s < required + (approval ? terms.feeE8s : 0n)) throw new PaymentFailure("InsufficientFunds");
      const { cursor } = authIdentity ? await history(preparationCursor).catch(error => {
        // Readers can fund a linked database without access to its ledger.
        // A lost purchase reply will remain unresolved without that evidence.
        if (error instanceof DecodedCanisterError && (decodedReplyMatches(error.message, `principal lacks required database role: ${databaseId}`)
          || decodedReplyMatches(error.message, `principal has no access to database: ${databaseId}`)))
          return { cursor: null };
        throw error;
      }) : { cursor: null };
      preparationCursor = cursor;
      checkedExpiredId = null;
      activePayment = snapshot({ version: 1, id: crypto.randomUUID(), databaseId, managerPrincipal, ledger, payer: scope.payer,
        amount: amount.toString(), credits: cyclesForPaymentAmountE8s(amount, terms.rate).toString(), rate: terms.rate.toString(),
        fee: terms.feeE8s.toString(), previousAllowance: terms.allowanceE8s.toString(), approvalRequired: approval, createdAtNs: time.toString(),
        expiresAtNs: (approval ? time + approvalLifetime : terms.allowanceExpiresAtNs)?.toString() ?? null,
        baseline: cursor, dispatchedAtNs: null, block: null, operation: null });
      return activePayment;
    },
    async revalidate(p) {
      if (!current() || activePayment !== p || !samePaymentScope(p.scope, scope)) return "changed";
      const t = await facts();
      const saved = store.list(scope)[0];
      if (store.hasTargetConflict(scope) || (saved && (saved.id !== p.id || saved.stage !== "approved"))) return "changed";
      if (saved && decode(saved).payment.termsKey !== p.termsKey) return "changed";
      const alreadyApproved = saved?.stage === "approved";
      const usable = t.allowanceE8s >= p.allowanceE8s && (t.allowanceExpiresAtNs === null || t.allowanceExpiresAtNs > nowNs());
      if (t.rate !== p.context.rate || (p.expiresAtNs !== null && p.expiresAtNs <= nowNs())) return "changed";
      if (t.balanceE8s < p.allowanceE8s + (alreadyApproved ? 0n : p.approvalFeeE8s)) throw new PaymentFailure("InsufficientFunds");
      if (alreadyApproved) return usable ? "unchanged" : "changed";
      return usable === !p.approvalRequired && t.allowanceE8s === p.context.previousAllowance
        && (p.approvalRequired || t.allowanceExpiresAtNs === p.expiresAtNs) ? "unchanged" : "changed";
    },
    async approve(p) {
      dispatchRecord(p, "approval-dispatched");
      if (!p.approvalRequired || p.expiresAtNs === null || approvedId === p.id) throw new PaymentFailure("TermsChanged");
      approvedId = p.id;
      await transport.approve(ledger, { spender: { owner: Principal.fromText(canisterId), subaccount: [] }, from_subaccount: [],
        amount: p.allowanceE8s, expected_allowance: [p.context.previousAllowance], fee: [p.approvalFeeE8s], memo: [],
        expires_at: [p.expiresAtNs], created_at_time: [p.context.createdAtNs] }, { isCurrent: dispatchGuard(p, new PaymentFailure("Expired")) });
      refreshPayerBalance();
    },
    async submit(p) {
      const record = dispatchRecord(p, "purchase-dispatched");
      const saved = decode(record).saved;
      if (submittedId === p.id || saved.dispatchedAtNs !== null) throw new PaymentFailure("Unknown");
      submittedId = p.id;
      saved.dispatchedAtNs = nowNs().toString();
      store.put({ ...record, context: saved });
      const deadline = new PaymentFailure("Expired");
      let result;
      try {
        result = await callWikiWithPayer(transport, canisterId, "purchase_database_cycles", [p.context.request], dispatchGuard(p, deadline));
      } catch (error) {
        if (error === deadline) return {kind:"rejected", code:"Expired"};
        throw error;
      }
      assertCurrent();
      if ("Ok" in result) {
        if (result.Ok.amount_cycles < p.credits) throw new PaymentFailure("InvalidReply");
        refreshPayerBalance();
        return acknowledge(p, saved.dispatchedAtNs, result.Ok.block_index.toString(), result.Ok.amount_cycles, result.Ok.balance_cycles);
      }
      // The saga can return Err after the ledger transferred funds. Only definite
      // ledger refusals clear the marker. Preserve certified correlation evidence.
      const refused = definitePurchaseRefusal(result.Err, p.credits);
      if (refused) return {kind:"rejected", code:refused};
      const applied = /^cycles purchase payment completed at ledger block (\d+) but local cycles application failed; pending operation (\d+) remains completed for billing authority review:/.exec(result.Err);
      const ambiguous = /^icrc2_transfer_from result ambiguous for operation_id (\d+);/.exec(result.Err);
      if (applied || ambiguous) {
        sagaReply = { id: p.id, termsKey: p.termsKey, dispatchedAtNs: saved.dispatchedAtNs,
          block: applied?.[1] ?? null, operation: applied?.[2] ?? ambiguous![1] };
        store.put({ ...record, context: { ...saved, block: sagaReply.block, operation: sagaReply.operation } });
      }
      return pendingReview(sagaReply?.id === p.id ? sagaReply.operation : undefined);
    },
    async check(record) {
      assertCurrent();
      checkedExpiredId = null;
      if (record.stage === "paid") return recoverAcknowledgement(record);
      const { saved, payment } = decode(record);
      const evidence = sagaReply && saved.id === sagaReply.id && payment.termsKey === sagaReply.termsKey
        && saved.dispatchedAtNs === sagaReply.dispatchedAtNs && saved.operation === sagaReply.operation
        && saved.block === sagaReply.block ? sagaReply : null;
      try {
        const result = await readPayerPending();
        assertCurrent();
        const empty = "Err" in result ? emptyPayerReply(result.Err) : result.Ok.length === 0;
        if (record.stage === "approved" && empty) {
          const expired = payment.expiresAtNs !== null && payment.expiresAtNs <= nowNs();
          if (expired) checkedExpiredId = record.id;
          return { kind: "unsubmitted", expired };
        }
        if (("Err" in result && !empty) || !evidence) return pendingReview(evidence?.operation);
        const rows = "Ok" in result ? result.Ok : [];
        const known = rows.find(row => row.operation_id.toString() === saved.operation && row.database_id === databaseId
          && row.payment_amount_e8s === payment.amountE8s && row.amount_cycles >= payment.credits);
        if (known) {
          const block = known.ledger_block_index[0]?.toString();
          if (block && (!evidence.block || evidence.block === block)) {
            evidence.block = block;
            store.put({ ...record, context: { ...saved, block } });
          }
          return { kind: "pending", requiredAction: "review", reference: evidence.operation };
        }
        if (!saved.block) return pendingReview(evidence.operation);
        if (historyOperation !== record.id) {
          historyOperation = record.id;
          historyCursor = saved.baseline;
        }
        const { entry, cursor } = await history(historyCursor, e => e.kind === "cycles_purchase" && e.method === "purchase_database_cycles"
          && e.databaseId === databaseId && e.caller === scope.payer.owner && e.ledgerBlockIndex === saved.block
          && e.paymentAmountE8s === saved.amount && BigInt(e.amountCycles) >= payment.credits);
        historyCursor = cursor;
        if (entry) refreshPayerBalance();
        return entry ? acknowledge(payment, evidence.dispatchedAtNs, saved.block, BigInt(entry.amountCycles), BigInt(entry.balanceAfterCycles)) : pendingReview(evidence.operation);
      } catch { return pendingReview(evidence?.operation); }
    },
    async restore(record) {
      assertCurrent();
      if (record.stage !== "approved") return null;
      activePayment = decode(record).payment;
      return activePayment;
    },
    async cancel(p) {
      dispatchRecord(p, "approved");
      if (checkedExpiredId !== p.id || p.expiresAtNs === null || nowNs() < p.expiresAtNs) throw new PaymentFailure("Unavailable");
      checkedExpiredId = null;
    },
    async refreshCredit() {
      assertCurrent();
      if (!authIdentity) throw new PaymentFailure("Unavailable");
      const balance = await billingClient.credit(canisterId, authIdentity, databaseId);
      assertCurrent();
      return balance;
    }
  };
}


// Only the decoded service result enters here. Post-transfer failures carry a
// distinct saga prefix, even when their diagnostic contains a ledger error.
function definitePurchaseRefusal(message: string, credits: bigint): PaymentErrorCode | null {
  const changed = /^(?:sqlite error 1: )?cycles purchase quote changed: amount_cycles (\d+) is below min_expected_cycles (\d+)$/.exec(message);
  if (changed && BigInt(changed[2]) === credits && BigInt(changed[1]) < credits) return "TermsChanged";
  const prefix = "icrc2_transfer_from failed: ";
  if (!message.startsWith(prefix)) return null;
  const refusal = message.slice(prefix.length);
  if (/^BadFee expected fee \d+; re-approve with the current ledger fee and retry$/.test(refusal)) return "BadFee";
  if (/^InsufficientFunds \{ balance: Nat\(\d+\) \}$/.test(refusal)) return "InsufficientFunds";
  if (/^InsufficientAllowance \{ allowance: Nat\(\d+\) \}$/.test(refusal)) return "AllowanceChanged";
  if (refusal === "TemporarilyUnavailable") return "Unavailable";
  if (refusal === "TooOld" || /^CreatedInFuture \{ ledger_time: \d+ \}$/.test(refusal)) return "Expired";
  if (/^BadBurn \{ min_burn_amount: Nat\(\d+\) \}$/.test(refusal)
    || /^GenericError \{ error_code: Nat\(\d+\), message: "(?:[^"\\]|\\.)*" \}$/.test(refusal)) return "PaymentRejected";
  return null;
}
