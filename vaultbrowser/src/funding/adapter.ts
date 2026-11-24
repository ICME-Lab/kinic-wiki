import { Actor, AnonymousIdentity, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { classifyPaymentFailure, PaymentFailure } from "@kinic/payments/errors";
import { assertLedgerFee, readLedgerTerms, type LedgerTerms } from "@kinic/payments/ledger";
import { samePaymentScope, type RecoveryStore } from "@kinic/payments/recovery-store";
import { freezeTerms, normalizePaymentScope } from "@kinic/payments/terms";
import type {
  FundingAccount, PaymentAdapter, PaymentCheck, PaymentScope, PreparedPayment, RecoveryRecord,
} from "@kinic/payments/types";
import type { WalletSessionManager } from "@kinic/payments/wallet-session";
import type { FundingTransport, WalletAccess } from "@kinic/payments/wallet-types";
import {
  idlFactory, type _SERVICE, type Error as VaultError, type FundingConfig, type Payment, type PurchaseRequest, type ReconciliationProgress,
} from "@kinic/vault-candid";
import { validateConfig, type BrowserConfig } from "../config";
import { paymentId } from "./payments";

const productionLedger = "73mez-iiaaa-aaaaq-aaasq-cai";
const lifetimeNs = 300_000_000_000n;
const kinic = 100_000_000n;
const minCredits = 20_000_000n;
const maxI64 = (1n << 63n) - 1n;
const maxU64 = (1n << 64n) - 1n;
// Only the quote needs the payer's Vault signature (the approval is a ledger call).
// The beneficiary reads, submits, cancels and reconciles with its own session.
const vaultMethods = ["quote_purchase"] as const;
const service = idlFactory({IDL});
type Method = typeof vaultMethods[number];
type Success<M extends Method> = Extract<Awaited<ReturnType<_SERVICE[M]>>, {Ok: unknown}>["Ok"];

function invalid(): never { throw new PaymentFailure("InvalidReply"); }
function unavailable(): never { throw new PaymentFailure("Unavailable"); }
function checkCurrent(current: () => boolean) {
  if (!current()) throw new PaymentFailure("AccountChanged");
}
function nat(value: unknown, max = maxU64): bigint {
  if (typeof value !== "bigint" || value < 0n || value > max) return invalid();
  return value;
}
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return invalid();
  return nat(BigInt(value));
}
function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function owner(text: unknown): string {
  if (typeof text !== "string") return invalid();
  try {
    const p = Principal.fromText(text);
    if (p.isAnonymous() || p.toText() !== text) return invalid();
    return text;
  } catch { return invalid(); }
}
function hex(bytes: Uint8Array | number[], length: number): string {
  if (bytes.length !== length) return invalid();
  return Array.from(bytes, b => {
    if (!Number.isInteger(b) || b < 0 || b > 255) return invalid();
    return b.toString(16).padStart(2, "0");
  }).join("");
}
function unhex(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) return invalid();
  return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));
}
function validateLedger(config: BrowserConfig, ledger: string) {
  owner(ledger);
  if ((!config.local || config.fundingMode === "production") && ledger !== productionLedger) return invalid();
}
function trustedConfig(config: BrowserConfig) {
  return Object.freeze({...validateConfig(config, globalThis.location?.origin ?? config.origin)});
}
function validateFunding(config: BrowserConfig, funding: FundingConfig) {
  validateLedger(config, funding.ledger.toText());
  owner(funding.recipient.toText());
  if (nat(funding.cycles_per_kinic, maxI64) === 0n) return invalid();
}
function unwrap<T>(result: {Ok: T} | {Err: unknown}): T {
  if ("Ok" in result) return result.Ok;
  throw new PaymentFailure(classifyPaymentFailure("checking", result.Err).code);
}

export async function discoverVaultFundingConfig(config: BrowserConfig): Promise<FundingConfig | null> {
  const trusted = trustedConfig(config);
  if (!enabled(trusted)) return null;
  const agent = HttpAgent.createSync({host: trusted.host, identity: new AnonymousIdentity()});
  if (trusted.local) await agent.fetchRootKey();
  const actor = Actor.createActor<_SERVICE>(idlFactory, {agent, canisterId: trusted.canister});
  const funding = unwrap(await actor.get_funding_config())[0] ?? null;
  if (funding) validateFunding(trusted, funding);
  return funding;
}

function enabled(config: BrowserConfig) {
  return config.fundingMode === "production" || (config.local && config.fundingMode === "synthetic-test-only");
}
export function vaultFundingScopes(canister: string, ledger?: string): WalletAccess[] {
  const scopes: WalletAccess[] = [{canisterId: owner(canister), methods: vaultMethods}];
  if (ledger) scopes.push({canisterId: owner(ledger), methods: ["icrc2_approve"]});
  return scopes;
}

type FundingSession = Pick<WalletSessionManager, "getSnapshot" | "getIdentityTransport" | "revalidate" | "capture" | "isCurrent">;
type PrincipalIdentity = Pick<Identity, "getPrincipal">;
/** The beneficiary's authenticated Vault actor, bound to `beneficiaryIdentity`. */
export interface VaultPaymentReader {
  beneficiary_cancel_quote(wallet: Principal, operation: Uint8Array | number[]): ReturnType<_SERVICE["beneficiary_cancel_quote"]>;
  beneficiary_reconcile_purchase(wallet: Principal, operation: Uint8Array | number[]): ReturnType<_SERVICE["beneficiary_reconcile_purchase"]>;
  beneficiary_payments(wallet: Principal): ReturnType<_SERVICE["beneficiary_payments"]>;
  beneficiary_payment_status(wallet: Principal, operation: Uint8Array | number[]): ReturnType<_SERVICE["beneficiary_payment_status"]>;
  beneficiary_pay_purchase(wallet: Principal, operation: Uint8Array | number[]): ReturnType<_SERVICE["beneficiary_pay_purchase"]>;
}
export interface VaultHistoryOptions {
  config: BrowserConfig;
  beneficiaryIdentity: PrincipalIdentity;
  reader: VaultPaymentReader;
  source: FundingAccount["provider"];
  walletSession: FundingSession;
  isCurrent(): boolean;
  /** Return value of explicit connect("plug", vaultFundingScopes(...)). */
  authorizedPlug?: FundingTransport | null;
}

function payerAccess(options: VaultHistoryOptions, config: BrowserConfig, ledger?: string) {
  const {walletSession, source, beneficiaryIdentity, isCurrent, reader} = options;
  const beneficiary = owner(beneficiaryIdentity.getPrincipal().toText());
  const token = walletSession.capture();
  const scopes = vaultFundingScopes(config.canister, ledger);
  const transport = source === "ii" ? walletSession.getIdentityTransport(scopes) : walletSession.getSnapshot().transport;
  if (!transport || transport.account.provider !== source) return unavailable();
  if (source === "plug" && options.authorizedPlug !== transport) return unavailable();
  const account = {...transport.account, owner: owner(transport.account.owner)};
  if (source === "ii" && account.owner !== beneficiary) throw new PaymentFailure("AccountChanged");
  function current() {
    return isCurrent() && walletSession.isCurrent(token) && beneficiaryIdentity.getPrincipal().toText() === beneficiary;
  }
  async function validate() {
    checkCurrent(current);
    if (source === "ii") await transport!.revalidate();
    else {
      const active = await walletSession.revalidate(scopes);
      if (active.account.provider !== source || active.account.owner !== account.owner)
        throw new PaymentFailure("AccountChanged");
    }
    checkCurrent(current);
  }
  async function callResult<M extends Method>(
    method: M, args: Parameters<_SERVICE[M]>, dispatchCurrent = current,
  ): Promise<{Ok: Success<M>} | {Err: VaultError}> {
    checkCurrent(current);
    const fn = service._fields.find(([name]) => name === method)![1];
    const reply = await transport!.call({
      canisterId: config.canister, interfaceFactory: idlFactory, method, isCurrent: dispatchCurrent,
      mode: fn.annotations.includes("query") ? "query" : "update", arg: IDL.encode(fn.argTypes, args),
    });
    checkCurrent(current);
    let result;
    try { [result] = IDL.decode(fn.retTypes, reply); } catch { return invalid(); }
    return result as unknown as {Ok: Success<M>} | {Err: VaultError};
  }
  async function call<M extends Method>(method: M, ...args: Parameters<_SERVICE[M]>): Promise<Success<M>> {
    return unwrap(await callResult(method, args));
  }
  const wallet = Principal.fromText(account.owner);
  async function read<T>(dispatch: () => Promise<{Ok: T} | {Err: VaultError}>, dispatchCurrent = current): Promise<T> {
    checkCurrent(current);
    checkCurrent(dispatchCurrent);
    const result = await dispatch();
    checkCurrent(current);
    return unwrap(result);
  }
  const beneficiaryCalls = {
    payments: () => read(() => reader.beneficiary_payments(wallet)),
    status: (operation: Uint8Array | number[]) => read(() => reader.beneficiary_payment_status(wallet, operation)),
    pay: (operation: Uint8Array | number[], dispatchCurrent: () => boolean) =>
      read(() => reader.beneficiary_pay_purchase(wallet, operation), dispatchCurrent),
    cancel: (operation: Uint8Array | number[]) => read(() => reader.beneficiary_cancel_quote(wallet, operation)),
    reconcile: (operation: Uint8Array | number[]) => read(() => reader.beneficiary_reconcile_purchase(wallet, operation)),
  };
  return {transport, account, current, validate, call, callResult, beneficiary, ...beneficiaryCalls};
}

function encodeRequest(req: PurchaseRequest) {
  return {
    operation: hex(req.operation, 16), beneficiary: owner(req.beneficiary.toText()),
    amount_e8s: nat(req.amount_e8s, maxI64).toString(), min_credits: nat(req.min_credits).toString(),
    created_at_time: nat(req.created_at_time).toString(),
  };
}
function encodeQuote(p: Payment) {
  return {
    wallet: owner(p.wallet.toText()), ledger: owner(p.config.ledger.toText()), recipient: owner(p.config.recipient.toText()),
    cycles_per_kinic: nat(p.config.cycles_per_kinic, maxI64).toString(), credits: nat(p.credits, maxI64).toString(),
    created_at_time: nat(p.created_at_time, maxU64 - lifetimeNs).toString(), memo: hex(p.memo, 32),
    fee: nat(p.fee).toString(),
  };
}
export function encodeVaultRecoveryContext(request: PurchaseRequest, payment: Payment | null) {
  return {request: encodeRequest(request), quote: payment ? encodeQuote(payment) : null};
}
type SavedQuote = ReturnType<typeof encodeQuote>;
type Decoded = {request: PurchaseRequest; quote: SavedQuote | null};

export function decodeVaultRecoveryRecord(record: RecoveryRecord, scope: PaymentScope): Decoded {
  if (record.version !== 1 || !samePaymentScope(record.scope, scope) || scope.target.kind !== "vault") return invalid();
  const value = record.context;
  if (!keys(value, ["request", "quote"]) || !keys(value.request, ["operation", "beneficiary", "amount_e8s", "min_credits", "created_at_time"]))
    return invalid();
  const req = value.request;
  if (req.operation !== record.id || owner(req.beneficiary) !== scope.target.beneficiary) return invalid();
  const request: PurchaseRequest = {
    operation: unhex(req.operation, 16), beneficiary: Principal.fromText(scope.target.beneficiary),
    amount_e8s: decimal(req.amount_e8s), min_credits: decimal(req.min_credits), created_at_time: decimal(req.created_at_time),
  };
  if (!request.amount_e8s || request.amount_e8s > maxI64 || !request.min_credits) return invalid();
  const q = value.quote;
  if (q === null && record.stage === "quote-dispatched") return {request, quote: null};
  if (!keys(q, ["wallet", "ledger", "recipient", "cycles_per_kinic", "credits", "created_at_time", "memo", "fee"])
    || owner(q.wallet) !== scope.payer.owner || owner(q.ledger) !== scope.ledger) return invalid();
  const rate = decimal(q.cycles_per_kinic), credits = decimal(q.credits);
  if (!rate || rate > maxI64 || credits > maxI64 || credits < minCredits || credits < request.min_credits
    || credits !== request.amount_e8s * rate / kinic || decimal(q.created_at_time) > maxU64 - lifetimeNs) return invalid();
  owner(q.recipient);
  unhex(q.memo, 32);
  decimal(q.fee);
  // Rebuild in a deterministic field order even if storage reordered its JSON.
  const quote: SavedQuote = {
    wallet: scope.payer.owner, ledger: scope.ledger, recipient: q.recipient as string, cycles_per_kinic: rate.toString(),
    credits: credits.toString(), created_at_time: q.created_at_time as string, memo: q.memo as string, fee: q.fee as string,
  };
  return {request, quote};
}
function verifyPayment(p: Payment, scope: PaymentScope, previous?: Decoded) {
  const serialized = encodeVaultRecoveryContext(p.request, p);
  decodeVaultRecoveryRecord({version: 1, id: paymentId(p), scope, stage: "quote-dispatched", context: serialized}, scope);
  if (previous && (JSON.stringify(encodeRequest(previous.request)) !== JSON.stringify(serialized.request)
    || (previous.quote && JSON.stringify(previous.quote) !== JSON.stringify(serialized.quote)))) return invalid();
  if (p.reconciliation[0] && p.reconciliation[0].spender.toText() !== scope.spender) return invalid();
}
function makeScope(config: BrowserConfig, payer: FundingAccount, beneficiary: string, ledger: string) {
  validateLedger(config, ledger);
  const scope = normalizePaymentScope({
    origin: globalThis.location?.origin ?? config.origin, host: config.host, ledger, spender: config.canister,
    payer, target: {kind: "vault", beneficiary},
  });
  Object.freeze(scope.payer);
  Object.freeze(scope.target);
  return Object.freeze(scope);
}
async function history(config: BrowserConfig, access: ReturnType<typeof payerAccess>) {
  const payments = await access.payments();
  return payments.filter(p => {
    if (p.wallet.toText() !== access.account.owner) return invalid();
    if (p.request.beneficiary.toText() !== access.beneficiary) return false;
    verifyPayment(p, makeScope(config, access.account, access.beneficiary, p.config.ledger.toText()));
    return true;
  });
}
export async function listVaultFundingHistory(options: VaultHistoryOptions): Promise<Payment[]> {
  const config = trustedConfig(options.config);
  return history(config, payerAccess(options, config));
}

export type VaultHistoryStatus = Exclude<PaymentCheck, {kind:"unsubmitted"}> | {kind:"quoted"};

/** A status-only lookup for an authenticated history row, independent of local storage. */
export async function readVaultHistoryStatus(options: VaultHistoryOptions, original: Payment): Promise<VaultHistoryStatus> {
  const config = trustedConfig(options.config);
  const access = payerAccess(options, config);
  const scope = makeScope(config, access.account, access.beneficiary, original.config.ledger.toText());
  verifyPayment(original, scope);
  const found = (await access.status(original.request.operation))[0];
  if (!found) return pending(paymentId(original));
  verifyPayment(found, scope, {request:original.request, quote:encodeQuote(original)});
  const result = outcome(found);
  // Without a readable local dispatch marker, Quoted cannot rule out an earlier debit.
  return result.kind === "unsubmitted" ? {kind:"quoted"} : result;
}

export interface VaultFundingContext {
  readonly payment: Payment;
  readonly operation: Uint8Array | number[];
  readonly expectedAllowance: bigint;
}
export interface VaultAdapterOptions extends VaultHistoryOptions {
  fundingConfig: FundingConfig | null;
  /** Canonical ledger from selected historical payment or journal when active config differs/is absent. */
  recoveryLedger?: string;
  ownerClient: {
    identity: PrincipalIdentity; canister: string; session: {capture(): unknown};
    actor: {
      account_balance(): ReturnType<_SERVICE["account_balance"]>;
      get_funding_config(): ReturnType<_SERVICE["get_funding_config"]>;
    };
  };
  store: RecoveryStore;
  readTerms?: typeof readLedgerTerms;
  nowNs?: () => bigint;
}
export interface VaultPaymentAdapter extends PaymentAdapter<VaultFundingContext> {
  readonly fundingEnabled: boolean;
  list(): Promise<Payment[]>;
  recordFor(payment: Payment): RecoveryRecord;
  scan(record: RecoveryRecord): Promise<ReconciliationProgress>;
}

function pending(id: string): Extract<PaymentCheck, {kind:"pending"}> { return {kind: "pending", reference: id, requiredAction: "check"}; }
function outcome(p: Payment): PaymentCheck {
  const status = p.status;
  if ("Paid" in status) return {kind: "paid", receipt: {reference: status.Paid.toString(), creditedCycles: p.credits}};
  if (p.uncertain || p.preparing || "Unknown" in status || "InFlight" in status) return pending(paymentId(p));
  if ("Quoted" in status) return {kind: "unsubmitted", expired: false};
  if ("Rejected" in status) return {kind: "rejected", code: "PaymentRejected"};
  return {kind: "rejected", code: classifyPaymentFailure("paying", status).code};
}

export function createVaultPaymentAdapter(options: VaultAdapterOptions): VaultPaymentAdapter {
  const {ownerClient, store, readTerms = readLedgerTerms, nowNs = () => BigInt(Date.now()) * 1_000_000n} = options;
  const config = trustedConfig(options.config);
  const active = options.fundingConfig;
  if (active) validateFunding(config, active);
  const ledger = options.recoveryLedger ?? active?.ledger.toText() ?? (!config.local ? productionLedger : null);
  if (!ledger) return unavailable();
  const session = ownerClient.session.capture();
  const beneficiary = options.beneficiaryIdentity.getPrincipal().toText();
  const rootGuard = options.isCurrent;
  const access = payerAccess({...options, isCurrent: () => rootGuard() && ownerClient.session.capture() === session
    && ownerClient.identity.getPrincipal().toText() === beneficiary && ownerClient.canister === config.canister}, config, ledger);
  const {current, validate} = access;
  checkCurrent(current);
  const scope = makeScope(config, access.account, beneficiary, ledger);
  const fundingEnabled = enabled(config) && active?.ledger.toText() === ledger;
  const activeRecipient = active?.recipient.toText(), activeRate = active?.cycles_per_kinic;
  function allowMoney(p?: Payment) {
    checkCurrent(current);
    if (!fundingEnabled) return unavailable();
    if (p && (p.config.recipient.toText() !== activeRecipient || p.config.cycles_per_kinic !== activeRate))
      throw new PaymentFailure("TermsChanged");
  }
  function recordFor(p: Payment): RecoveryRecord {
    verifyPayment(p, scope);
    const result = outcome(p);
    const stage = result.kind === "pending" ? "purchase-dispatched" : result.kind === "paid" ? "paid" : "quote-dispatched";
    return {version: 1, scope, stage, id: paymentId(p), context: encodeVaultRecoveryContext(p.request, p)};
  }
  function journal(id: string, stages: RecoveryRecord["stage"][]) {
    const r = store.list(scope)[0];
    if (!r || r.id !== id || !stages.includes(r.stage)) throw new PaymentFailure("AccountChanged");
    return r;
  }
  async function status(record: RecoveryRecord) {
    const previous = decodeVaultRecoveryRecord(record, scope);
    const p = (await access.status(previous.request.operation))[0];
    if (p) verifyPayment(p, scope, previous);
    return p;
  }
  async function terms(p: Payment) {
    const terms = await readTerms({host: scope.host, ledger: scope.ledger, owner: scope.payer.owner, spender: scope.spender});
    checkCurrent(current);
    if (terms.decimals !== 8 || terms.allowanceE8s < 0n || terms.balanceE8s < 0n) return invalid();
    assertLedgerFee(terms.feeE8s, p.fee);
    return terms;
  }
  function enoughAllowance(p: Payment, t: LedgerTerms) {
    return t.allowanceE8s >= p.request.amount_e8s + p.fee
      && (t.allowanceExpiresAtNs === null || t.allowanceExpiresAtNs >= p.created_at_time + lifetimeNs);
  }
  function prepareTerms(p: Payment, t: LedgerTerms, approved: boolean) {
    const approvalRequired = !approved;
    const allowanceE8s = p.request.amount_e8s + p.fee;
    const context = Object.freeze({payment: p, operation: p.request.operation, expectedAllowance: t.allowanceE8s});
    return freezeTerms({
      id: paymentId(p), scope, context, recipient: p.config.recipient.toText(), amountE8s: p.request.amount_e8s,
      transferFeeE8s: p.fee, approvalFeeE8s: p.fee, allowanceE8s, approvalRequired, credits: p.credits,
      expiresAtNs: p.created_at_time + lifetimeNs,
    }, JSON.stringify([encodeVaultRecoveryContext(p.request, p), approvalRequired ? t.allowanceE8s.toString() : null]));
  }
  function preflight(p: Payment, t: LedgerTerms, needsApproval: boolean) {
    if (nowNs() >= p.created_at_time + lifetimeNs) throw new PaymentFailure("Expired");
    if (t.balanceE8s < p.request.amount_e8s + p.fee + (needsApproval ? p.fee : 0n)) throw new PaymentFailure("InsufficientFunds");
  }
  function savedPayment(p: PreparedPayment<VaultFundingContext>, stages: RecoveryRecord["stage"][]) {
    if (!samePaymentScope(p.scope, scope)) return invalid();
    const r = journal(p.id, stages);
    const saved = decodeVaultRecoveryRecord(r, scope);
    if (!saved.quote) return invalid();
    verifyPayment(p.context.payment, scope, saved);
    return r;
  }
  return {
    scope, fundingEnabled,
    // Status checks and scans use the beneficiary session, so no wallet prompt is involved.
    capabilities: {get silentCheck() {return current();}, cancelUnsubmitted: true, scan: true},
    list: () => history(config, access),
    recordFor,
    async prepare(amount) {
      allowMoney();
      if (nat(amount, maxI64) === 0n || amount * activeRate! / kinic < minCredits || amount * activeRate! / kinic > maxI64) return invalid();
      if (store.hasTargetConflict(scope) || store.list(scope).length) throw new PaymentFailure("AccountChanged");
      const prior = await history(config, access);
      // Resolve possible ledger dispatch before any unsubmitted quote for this beneficiary.
      const outstanding = prior.find(p => outcome(p).kind === "pending") ?? prior.find(p => outcome(p).kind === "unsubmitted");
      if (outstanding) {
        if (outstanding.config.ledger.toText() === ledger) store.put(recordFor(outstanding));
        throw new PaymentFailure("Unavailable");
      }
      // Confirm the connected payer before asking it to sign the quote.
      await validate();
      checkCurrent(current);
      const request: PurchaseRequest = {
        operation: crypto.getRandomValues(new Uint8Array(16)), beneficiary: Principal.fromText(beneficiary),
        amount_e8s: amount, created_at_time: nat(nowNs()), min_credits: minCredits,
      };
      const record: RecoveryRecord = {version: 1, scope, stage: "quote-dispatched", id: hex(request.operation, 16),
        context: encodeVaultRecoveryContext(request, null)};
      store.put(record);
      const reply = await access.callResult("quote_purchase", [request]);
      if ("Err" in reply) {
        // Admission rejects capacity, authorization and invalid requests before saving a Payment.
        // An invalid/failed fee lookup also returns before finish_quote saves its Payment.
        const error = reply.Err;
        if ("Busy" in error || "QuotaExceeded" in error || "Unauthorized" in error || "InvalidInput" in error || "KeyService" in error) {
          checkCurrent(current);
          const slot = store.list(scope)[0];
          if (slot?.id === record.id && slot.stage === "quote-dispatched") {
            const saved = decodeVaultRecoveryRecord(slot, scope);
            if (saved.quote === null && JSON.stringify(encodeRequest(saved.request)) === JSON.stringify(encodeRequest(request)))
              store.remove(scope, record.id);
          }
          throw new PaymentFailure("InvalidInput" in error ? "PaymentRejected" : "Unavailable");
        }
        throw new PaymentFailure(classifyPaymentFailure("preparing", error).code);
      }
      const payment = reply.Ok;
      verifyPayment(payment, scope, {request, quote: null});
      store.put(recordFor(payment));
      allowMoney(payment);
      if (outcome(payment).kind !== "unsubmitted") return unavailable();
      const runtime = await terms(payment);
      const p = prepareTerms(payment, runtime, false);
      preflight(payment, runtime, p.approvalRequired);
      return p;
    },
    async revalidate(prepared) {
      allowMoney();
      const record = savedPayment(prepared, ["quote-dispatched", "approved"]);
      const needsApproval = prepared.approvalRequired && record.stage !== "approved";
      // Only the approval needs the payer's wallet. Submission uses the beneficiary session.
      if (needsApproval) await validate();
      const p = await status(record);
      if (!p || outcome(p).kind !== "unsubmitted") return "changed";
      allowMoney(p);
      const live = unwrap(await ownerClient.actor.get_funding_config())[0];
      checkCurrent(current);
      if (!live) return unavailable();
      validateFunding(config, live);
      if (live.ledger.toText() !== ledger || live.recipient.toText() !== activeRecipient || live.cycles_per_kinic !== activeRate)
        return "changed";
      const t = await terms(p);
      if (needsApproval ? t.allowanceE8s !== prepared.context.expectedAllowance : !enoughAllowance(p, t))
        return "changed";
      preflight(p, t, needsApproval);
      return "unchanged";
    },
    async approve(prepared) {
      const p = prepared.context.payment;
      allowMoney(p);
      savedPayment(prepared, ["approval-dispatched"]);
      if (!prepared.approvalRequired) return invalid();
      const deadline = p.created_at_time + lifetimeNs;
      await access.transport.approve(ledger, {
        from_subaccount: [], spender: {owner: Principal.fromText(scope.spender), subaccount: []},
        amount: p.request.amount_e8s + p.fee, expected_allowance: [prepared.context.expectedAllowance], fee: [p.fee],
        memo: [Uint8Array.from(p.memo)], created_at_time: [p.created_at_time], expires_at: [deadline],
      }, {isCurrent: () => current() && nowNs() < deadline});
      checkCurrent(current);
    },
    async submit(prepared) {
      allowMoney(prepared.context.payment);
      const record = savedPayment(prepared, ["purchase-dispatched"]);
      const previous = decodeVaultRecoveryRecord(record, scope);
      const deadline = prepared.context.payment.created_at_time + lifetimeNs;
      const p = await access.pay(previous.request.operation, () => current() && nowNs() < deadline);
      verifyPayment(p, scope, previous);
      const result = outcome(p);
      return result.kind === "unsubmitted" ? pending(record.id) : result;
    },
    async check(record) {
      const p = await status(record);
      if (!p) return pending(record.id);
      const result = outcome(p);
      if (result.kind === "unsubmitted" && record.stage !== "quote-dispatched" && record.stage !== "approved")
        return pending(record.id);
      return result;
    },
    async restore(record) {
      const p = await status(record);
      if (!p || outcome(p).kind !== "unsubmitted" || (record.stage !== "quote-dispatched" && record.stage !== "approved")) return null;
      // Make the acknowledged terms durable even when the original quote response was lost.
      store.put({...record, context: encodeVaultRecoveryContext(p.request, p)});
      return prepareTerms(p, await terms(p), record.stage === "approved");
    },
    async refreshCredit() {
      checkCurrent(current);
      const balance = unwrap(await ownerClient.actor.account_balance());
      checkCurrent(current);
      return nat(balance);
    },
    encode(p) {
      if (!samePaymentScope(p.scope, scope)) return invalid();
      verifyPayment(p.context.payment, scope);
      return encodeVaultRecoveryContext(p.context.payment.request, p.context.payment);
    },
    async cancel(prepared) {
      const r = savedPayment(prepared, ["quote-dispatched", "approved"]);
      const saved = decodeVaultRecoveryRecord(r, scope);
      const p = await access.cancel(saved.request.operation);
      verifyPayment(p, scope, saved);
      if (!("Expired" in p.status) || p.uncertain || p.preparing) return invalid();
    },
    async scan(record) {
      const saved = decodeVaultRecoveryRecord(record, scope);
      const before = await status(record);
      if (!before || (!("Unknown" in before.status) && !("InFlight" in before.status) && !("Paid" in before.status))) return unavailable();
      const progress = await access.reconcile(saved.request.operation);
      verifyPayment(progress.payment, scope, {request: before.request, quote: encodeQuote(before)});
      return progress;
    },
  };
}
