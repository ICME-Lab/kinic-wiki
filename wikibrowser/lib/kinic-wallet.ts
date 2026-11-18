import { Actor, AnonymousIdentity, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { createAuthenticatedActor } from "@/lib/vfs-client/actor";
import { getCyclesBillingConfig, type DatabaseCyclesPurchaseRequest } from "@/lib/vfs-client";
import type { FundingTransport } from "@kinic/payments/wallet-types";
import type { WalletSessionManager } from "@kinic/payments/wallet-session";
import { cyclesForPaymentAmountE8s, formatRawCycles, KINIC_LEDGER_FEE_E8S, MAX_CANISTER_I64, MAX_LEDGER_U64 } from "@/lib/cycles";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { callWikiWithPayer, createWikiWalletSession, wikiPaymentScopes } from "@/lib/wallet-runtime";

type WalletProvider = "oisy" | "plug";
export type FundingProvider = "ii" | WalletProvider;

type CyclesPurchaseRequest = {
  canisterId: string;
  databaseId: string;
  paymentAmountE8s: bigint;
};

type CyclesPurchaseResult = {
  provider: FundingProvider;
  approveBlockIndex: string | null;
  approvedAllowanceE8s: string;
  purchasedCycles: string;
  paymentAmountE8s: string;
  transferFeeE8s: string;
  purchaseBlockIndex: string | null;
  balanceCycles: string | null;
};

type MarketPurchaseRequest = {
  canisterId: string;
  listingId: string;
  priceE8s: bigint;
  accessPrincipal: string;
};

type MarketPurchaseResult = {
  provider: FundingProvider;
  approveBlockIndex: string | null;
  approvedAllowanceE8s: string;
  orderId: string;
  listingId: string;
  databaseId: string;
  buyerPrincipal: string;
  sellerPrincipal: string;
  payoutPrincipal: string;
  priceE8s: string;
  ledgerBlockIndex: string;
  createdAtMs: string;
};

type MarketPurchaseCanisterRequest = {
  listing_id: string;
  price_e8s: bigint;
  access_principal: string;
};

type KinicTransferRequest = {
  canisterId: string;
  identity: Identity;
  toPrincipal: string;
  amountE8s: bigint;
};

export class KinicAfterApproveError extends Error {
  approveBlockIndex: string | null;
  causeMessage: string;

  constructor(input: { approveBlockIndex: string | null; causeMessage: string; expiresAt: bigint | null }) {
    const approvalText =
      input.expiresAt === null
        ? "approval remains without expiry"
        : `approval remains until ${new Date(Number(input.expiresAt / 1_000_000n)).toISOString()}`;
    super(`Purchase did not complete after KINIC approval; temporary allowance may remain until expiry (${approvalText}): ${input.causeMessage}`);
    this.name = "KinicAfterApproveError";
    this.approveBlockIndex = input.approveBlockIndex;
    this.causeMessage = input.causeMessage;
  }
}

type PreparedKinicAllowance = {
  kinicLedgerCanisterId: string;
  transferFeeE8s: bigint;
  approvedAllowanceE8s: bigint;
  currentAllowance: LedgerAllowance;
  approvalExpiresAt: bigint | null;
  approvalRequired: boolean;
  expiresAt: bigint;
};

type PreparedCyclesPurchase = PreparedKinicAllowance & {
  purchaseRequest: DatabaseCyclesPurchaseRequest;
  paymentAmountE8s: bigint;
};

type AllowanceCallResult<T> = {
  value: T;
  approveBlockIndex: string | null;
};

type PlugVfsActor = {
  purchase_database_cycles: (request: DatabaseCyclesPurchaseRequest) => Promise<{ Ok: { block_index: bigint; amount_cycles: bigint; balance_cycles: bigint } } | { Err: string }>;
  market_purchase_access: (request: MarketPurchaseCanisterRequest) => Promise<{ Ok: RawMarketOrder } | { Err: string }>;
};

type RawMarketOrder = {
  order_id: string;
  listing_id: string;
  database_id: string;
  buyer_principal: string;
  seller_principal: string;
  payout_principal: string;
  price_e8s: bigint;
  ledger_block_index: bigint;
  created_at_ms: bigint;
};

type LedgerActor = {
  icrc1_balance_of: (request: LedgerAccount) => Promise<bigint>;
  icrc1_transfer: (request: LedgerTransferArgs) => Promise<{ Ok: bigint } | { Err: LedgerTransferError }>;
  icrc2_allowance: (request: LedgerAllowanceArgs) => Promise<LedgerAllowance>;
  icrc2_approve: (request: LedgerApproveArgs) => Promise<{ Ok: bigint } | { Err: unknown }>;
};



type LedgerAllowanceArgs = {
  account: LedgerAccount;
  spender: LedgerAccount;
};

type LedgerAllowance = {
  allowance: bigint;
  expires_at: [] | [bigint];
};

type LedgerApproveArgs = {
  fee: [] | [bigint];
  memo: [] | [Uint8Array];
  from_subaccount: [] | [Uint8Array];
  created_at_time: [] | [bigint];
  amount: bigint;
  expected_allowance: [] | [bigint];
  expires_at: [] | [bigint];
  spender: LedgerAccount;
};

type LedgerTransferArgs = {
  from_subaccount: [] | [Uint8Array];
  to: LedgerAccount;
  amount: bigint;
  fee: [] | [bigint];
  memo: [] | [Uint8Array];
  created_at_time: [] | [bigint];
};

type LedgerTransferError = object;

type LedgerAccount = {
  owner: Principal;
  subaccount: [] | [Uint8Array];
};

export type ConnectedOisyWallet = {
  owner: string;
  session?: WalletSessionManager;
  transport?: FundingTransport;
};

export type ConnectedPlugWallet = {
  principal: string;
  session?: WalletSessionManager;
  transport?: FundingTransport;
};

export type ConnectedKinicWallet = { provider: "oisy"; connection: ConnectedOisyWallet } | { provider: "plug"; connection: ConnectedPlugWallet };
export type KinicFundingSource = { provider: "ii"; identity: Identity } | ConnectedKinicWallet;

const APPROVE_EXPIRES_IN_MS = 30 * 60 * 1000;
type ActorInterfaceFactory = Parameters<typeof Actor.createActor>[0];

export async function connectOisyWallet(): Promise<ConnectedOisyWallet> {
  const manager = createWikiWalletSession(true);
  try {
    const transport = await manager.connect("oisy", []);
    return { owner: transport.account.owner };
  } finally {
    await manager.disconnect().catch(() => {});
  }
}

export async function connectPlugWallet(): Promise<ConnectedPlugWallet> {
  const manager = createWikiWalletSession(true);
  try {
    const transport = await manager.connect("plug", []);
    return { principal: transport.account.owner };
  } finally {
    manager.destroy();
  }
}

function assertDefaultWallet(connection: ConnectedOisyWallet | ConnectedPlugWallet) {
  const subaccount = Reflect.get(connection, "subaccount");
  if (subaccount !== undefined && subaccount !== null && subaccount !== "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    && !(subaccount instanceof Uint8Array && subaccount.length === 32 && subaccount.every(byte => byte === 0)))
    throw new Error("Use a default ledger account for funding.");
}

export async function getConnectedWalletKinicBalance(canisterId: string, wallet: ConnectedKinicWallet): Promise<string> {
  assertConfiguredCyclesCanister(canisterId);
  assertDefaultWallet(wallet.connection);
  const config = await getCyclesBillingConfig(canisterId);
  const balance = await getLedgerBalance(config.kinicLedgerCanisterId, connectedWalletPrincipal(wallet));
  return balance.toString();
}

export async function getPrincipalKinicLedgerBalance(canisterId: string, principal: string): Promise<string> {
  assertConfiguredCyclesCanister(canisterId);
  const config = await getCyclesBillingConfig(canisterId);
  const balance = await getLedgerBalance(config.kinicLedgerCanisterId, principal);
  return balance.toString();
}

export async function transferKinicFromIdentity(request: KinicTransferRequest): Promise<string> {
  assertConfiguredCyclesCanister(request.canisterId);
  assertCanisterPaymentAmountE8s(request.amountE8s);
  const config = await getCyclesBillingConfig(request.canisterId);
  const actor = await createLedgerActor(config.kinicLedgerCanisterId, request.identity);
  const transfer = await actor.icrc1_transfer({
    from_subaccount: [],
    to: defaultAccount(request.toPrincipal),
    amount: request.amountE8s,
    fee: [KINIC_LEDGER_FEE_E8S],
    memo: [],
    created_at_time: []
  });
  if ("Err" in transfer) throw new Error(`ledger transfer failed: ${formatLedgerTransferError(transfer.Err)}`);
  return transfer.Ok.toString();
}

export async function purchaseCyclesWithFundingSource(request: CyclesPurchaseRequest, source: KinicFundingSource): Promise<CyclesPurchaseResult> {
  if (source.provider === "ii") return purchaseCyclesWithIdentity(request, source.identity);
  return source.provider === "oisy"
    ? purchaseCyclesWithOisy(request, source.connection)
    : purchaseCyclesWithPlug(request, source.connection);
}

export async function purchaseMarketAccessWithFundingSource(request: MarketPurchaseRequest, source: KinicFundingSource): Promise<MarketPurchaseResult> {
  if (source.provider === "ii") return purchaseMarketAccessWithIdentity(request, source.identity);
  return source.provider === "oisy"
    ? purchaseMarketAccessWithOisy(request, source.connection)
    : purchaseMarketAccessWithPlug(request, source.connection);
}

export async function purchaseCyclesWithIdentity(request: CyclesPurchaseRequest, identity: Identity): Promise<CyclesPurchaseResult> {
  const prepared = await prepareCyclesPurchase(request, identity.getPrincipal().toText());
  const { value: purchase, approveBlockIndex } = await runIdentityAllowanceCall(prepared, request.canisterId, identity, async (vfsActor) => {
    const result = await vfsActor.purchase_database_cycles(prepared.purchaseRequest);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  });
  return {
    provider: "ii",
    approveBlockIndex,
    approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    purchasedCycles: formatRawCycles(purchase.amount_cycles),
    paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(),
    purchaseBlockIndex: purchase.block_index.toString(),
    balanceCycles: formatRawCycles(purchase.balance_cycles)
  };
}

export async function purchaseMarketAccessWithIdentity(request: MarketPurchaseRequest, identity: Identity): Promise<MarketPurchaseResult> {
  const prepared = await prepareMarketPurchase(request, identity.getPrincipal().toText());
  const { value: order, approveBlockIndex } = await runIdentityAllowanceCall(prepared, request.canisterId, identity, async (vfsActor) => {
    const result = await vfsActor.market_purchase_access(rawMarketPurchaseRequest(request));
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  });
  return normalizeMarketOrder(order, "ii", approveBlockIndex, prepared.approvedAllowanceE8s.toString());
}

export async function purchaseCyclesWithOisy(request: CyclesPurchaseRequest, connection: ConnectedOisyWallet): Promise<CyclesPurchaseResult> {
  return purchaseExternalCycles(request, { provider: "oisy", connection });
}

export async function purchaseCyclesWithPlug(request: CyclesPurchaseRequest, connection: ConnectedPlugWallet): Promise<CyclesPurchaseResult> {
  return purchaseExternalCycles(request, { provider: "plug", connection });
}

async function purchaseExternalCycles(request: CyclesPurchaseRequest, wallet: ConnectedKinicWallet): Promise<CyclesPurchaseResult> {
  assertDefaultWallet(wallet.connection);
  const prepared = await prepareCyclesPurchase(request, connectedWalletPrincipal(wallet));
  const { value: purchase, approveBlockIndex } = await runExternalAllowanceCall(prepared, request.canisterId, wallet, async transport => {
    const result = await callWikiWithPayer(transport, request.canisterId, "purchase_database_cycles", [prepared.purchaseRequest]);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  });
  return { provider: wallet.provider, approveBlockIndex, approvedAllowanceE8s: prepared.approvedAllowanceE8s.toString(),
    purchasedCycles: formatRawCycles(purchase.amount_cycles), paymentAmountE8s: prepared.paymentAmountE8s.toString(),
    transferFeeE8s: prepared.transferFeeE8s.toString(), purchaseBlockIndex: purchase.block_index.toString(),
    balanceCycles: formatRawCycles(purchase.balance_cycles) };
}

export async function purchaseMarketAccessWithOisy(request: MarketPurchaseRequest, connection: ConnectedOisyWallet): Promise<MarketPurchaseResult> {
  return purchaseExternalMarketAccess(request, { provider: "oisy", connection });
}

export async function purchaseMarketAccessWithPlug(request: MarketPurchaseRequest, connection: ConnectedPlugWallet): Promise<MarketPurchaseResult> {
  return purchaseExternalMarketAccess(request, { provider: "plug", connection });
}

async function purchaseExternalMarketAccess(request: MarketPurchaseRequest, wallet: ConnectedKinicWallet): Promise<MarketPurchaseResult> {
  assertDefaultWallet(wallet.connection);
  const prepared = await prepareMarketPurchase(request, connectedWalletPrincipal(wallet));
  const { value: order, approveBlockIndex } = await runExternalAllowanceCall(prepared, request.canisterId, wallet, async transport => {
    const result = await callWikiWithPayer(transport, request.canisterId, "market_purchase_access", [rawMarketPurchaseRequest(request)]);
    if ("Err" in result) throw new Error(result.Err);
    return result.Ok;
  });
  return normalizeMarketOrder(order, wallet.provider, approveBlockIndex, prepared.approvedAllowanceE8s.toString());
}

async function runExternalAllowanceCall<T>(
  prepared: PreparedKinicAllowance, canisterId: string, wallet: ConnectedKinicWallet, call: (transport: FundingTransport) => Promise<T>
): Promise<AllowanceCallResult<T>> {
  const session = wallet.connection.session;
  const manager = session ?? createWikiWalletSession(true);
  const scopes = wikiPaymentScopes(canisterId, prepared.kinicLedgerCanisterId);
  try {
    const transport = session ? await manager.revalidate(scopes) : await manager.connect(wallet.provider, scopes);
    if (transport.account.provider !== wallet.provider || transport.account.owner !== connectedWalletPrincipal(wallet)
      || (session && wallet.connection.transport !== transport)) throw new Error("Wallet account changed; reconnect the wallet.");
    let approveBlockIndex: string | null = null;
    if (prepared.approvalRequired) {
      const args = rawApproveArgs(canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowance.allowance, prepared.expiresAt);
      try { approveBlockIndex = (await transport.approve(prepared.kinicLedgerCanisterId, args)).toString(); }
      catch (error) { throw new Error(`ledger approve failed: ${errorMessage(error)}`); }
    }
    const value = await callAfterApprove(() => call(transport), { approveBlockIndex, expiresAt: prepared.approvalExpiresAt });
    return { value, approveBlockIndex };
  } finally {
    if (!session) {
      if (wallet.provider === "oisy") await manager.disconnect().catch(() => {});
      manager.destroy();
    }
  }
}

async function runIdentityAllowanceCall<T>(
  prepared: PreparedKinicAllowance,
  canisterId: string,
  identity: Identity,
  callCanister: (vfsActor: PlugVfsActor) => Promise<T>
): Promise<AllowanceCallResult<T>> {
  let approveBlockIndex: string | null = null;
  if (prepared.approvalRequired) {
    const ledgerActor = await createLedgerActor(prepared.kinicLedgerCanisterId, identity);
    const approve = await ledgerActor.icrc2_approve(
      rawApproveArgs(canisterId, prepared.approvedAllowanceE8s, prepared.currentAllowance.allowance, prepared.expiresAt)
    );
    if ("Err" in approve) throw new Error(`ledger approve failed: ${formatLedgerApproveError(approve.Err)}`);
    approveBlockIndex = approve.Ok.toString();
  }
  const vfsActor = (await createAuthenticatedActor(canisterId, identity)) as unknown as PlugVfsActor;
  const value = await callAfterApprove(() => callCanister(vfsActor), { approveBlockIndex, expiresAt: prepared.approvalExpiresAt });
  return { value, approveBlockIndex };
}

function rawApproveArgs(canisterId: string, allowanceE8s: bigint, expectedAllowanceE8s: bigint, expiresAt: bigint): LedgerApproveArgs {
  return {
    fee: [],
    memo: [],
    from_subaccount: [],
    created_at_time: [BigInt(Date.now()) * 1_000_000n],
    amount: allowanceE8s,
    expected_allowance: [expectedAllowanceE8s],
    expires_at: [expiresAt],
    spender: { owner: Principal.fromText(canisterId), subaccount: [] }
  };
}

async function prepareCyclesPurchase(request: CyclesPurchaseRequest, payer: string): Promise<PreparedCyclesPurchase> {
  const paymentAmountE8s = request.paymentAmountE8s;
  const allowance = await prepareKinicAllowance(request.canisterId, payer, paymentAmountE8s);
  const config = await getCyclesBillingConfig(request.canisterId);
  const minExpectedCycles = cyclesForPaymentAmountE8s(paymentAmountE8s, BigInt(config.cyclesPerKinic));
  return {
    ...allowance,
    purchaseRequest: {
      database_id: request.databaseId,
      payment_amount_e8s: paymentAmountE8s,
      min_expected_cycles: minExpectedCycles,
    },
    paymentAmountE8s
  };
}

async function prepareMarketPurchase(request: MarketPurchaseRequest, payer: string): Promise<PreparedKinicAllowance> {
  return prepareKinicAllowance(request.canisterId, payer, request.priceE8s);
}

async function prepareKinicAllowance(canisterId: string, payer: string, amountE8s: bigint): Promise<PreparedKinicAllowance> {
  assertConfiguredCyclesCanister(canisterId);
  assertCanisterPaymentAmountE8s(amountE8s);
  const config = await getCyclesBillingConfig(canisterId);
  const transferFeeE8s = KINIC_LEDGER_FEE_E8S;
  const approvedAllowanceE8s = allowanceForKinicTransfer(amountE8s, transferFeeE8s);
  const expiresAt = approveExpiresAt();
  const currentAllowance = await getLedgerAllowance(config.kinicLedgerCanisterId, payer, canisterId);
  const approvalRequired = !allowanceIsUsable(currentAllowance, approvedAllowanceE8s, nowNs());
  return {
    kinicLedgerCanisterId: config.kinicLedgerCanisterId,
    transferFeeE8s,
    approvedAllowanceE8s,
    currentAllowance,
    approvalExpiresAt: approvalRequired ? expiresAt : allowanceExpiresAt(currentAllowance),
    approvalRequired,
    expiresAt
  };
}

function allowanceForKinicTransfer(amountE8s: bigint, transferFeeE8s: bigint): bigint {
  const allowance = amountE8s + transferFeeE8s;
  if (allowance > MAX_LEDGER_U64) throw new Error("approved allowance exceeds u64::MAX");
  return allowance;
}

function assertCanisterPaymentAmountE8s(amountE8s: bigint): void {
  if (amountE8s <= 0n) throw new Error("KINIC amount must be positive");
  if (amountE8s > MAX_CANISTER_I64) throw new Error("KINIC amount e8s exceeds canister limit");
}

function allowanceIsUsable(allowance: LedgerAllowance, requiredAllowanceE8s: bigint, currentTimeNs: bigint): boolean {
  if (allowance.allowance < requiredAllowanceE8s) return false;
  const expiresAt = allowanceExpiresAt(allowance);
  return expiresAt === null || expiresAt > currentTimeNs;
}

function allowanceExpiresAt(allowance: LedgerAllowance): bigint | null {
  return allowance.expires_at[0] ?? null;
}

function approveExpiresAt(): bigint {
  return nowNs() + BigInt(APPROVE_EXPIRES_IN_MS) * 1_000_000n;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function assertConfiguredCyclesCanister(canisterId: string): void {
  const configured = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID;
  if (!configured) throw new Error("VITE_KINIC_WIKI_CANISTER_ID is not configured");
  if (Principal.fromText(canisterId).toText() !== Principal.fromText(configured).toText()) {
    throw new Error("VFS canister does not match VITE_KINIC_WIKI_CANISTER_ID");
  }
}

async function getLedgerAllowance(ledgerCanisterId: string, owner: string, spender: string): Promise<LedgerAllowance> {
  const host = import.meta.env.VITE_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
  return actor.icrc2_allowance(allowanceArgs(owner, spender));
}

async function getLedgerBalance(ledgerCanisterId: string, owner: string): Promise<bigint> {
  const host = import.meta.env.VITE_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity: new AnonymousIdentity(), host });
  if (agent.isLocal()) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
  return actor.icrc1_balance_of(defaultAccount(owner));
}

async function createLedgerActor(ledgerCanisterId: string, identity: Identity): Promise<LedgerActor> {
  const host = import.meta.env.VITE_WIKI_IC_HOST ?? "https://icp0.io";
  const agent = HttpAgent.createSync({ identity, host });
  if (agent.isLocal()) await agent.fetchRootKey();
  return Actor.createActor<LedgerActor>(ledgerIdlFactory, {
    agent,
    canisterId: Principal.fromText(ledgerCanisterId)
  });
}

function allowanceArgs(owner: string, spender: string): LedgerAllowanceArgs {
  return {
    account: defaultAccount(owner),
    spender: defaultAccount(spender)
  };
}

function defaultAccount(owner: string): LedgerAccount {
  return { owner: Principal.fromText(owner), subaccount: [] };
}

function connectedWalletPrincipal(wallet: ConnectedKinicWallet): string {
  return wallet.provider === "oisy" ? wallet.connection.owner : wallet.connection.principal;
}

async function callAfterApprove<T>(run: () => Promise<T>, context: { approveBlockIndex: string | null; expiresAt: bigint | null }): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new KinicAfterApproveError({
      approveBlockIndex: context.approveBlockIndex,
      causeMessage: errorMessage(cause),
      expiresAt: context.expiresAt
    });
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isObject(cause)) {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string") return message;
    return safeJsonWithBigInts(cause);
  }
  return String(cause);
}

function rawMarketPurchaseRequest(request: MarketPurchaseRequest): MarketPurchaseCanisterRequest {
  return {
    listing_id: request.listingId,
    price_e8s: request.priceE8s,
    access_principal: request.accessPrincipal
  };
}

function normalizeMarketOrder(raw: RawMarketOrder, provider: FundingProvider, approveBlockIndex: string | null, approvedAllowanceE8s: string): MarketPurchaseResult {
  return {
    provider,
    approveBlockIndex,
    approvedAllowanceE8s,
    orderId: raw.order_id,
    listingId: raw.listing_id,
    databaseId: raw.database_id,
    buyerPrincipal: raw.buyer_principal,
    sellerPrincipal: raw.seller_principal,
    payoutPrincipal: raw.payout_principal,
    priceE8s: raw.price_e8s.toString(),
    ledgerBlockIndex: raw.ledger_block_index.toString(),
    createdAtMs: raw.created_at_ms.toString()
  };
}

function formatLedgerApproveError(error: unknown): string {
  const known = formatKnownLedgerApproveError(error);
  return known ?? safeJsonWithBigInts(error);
}

function formatLedgerTransferError(error: LedgerTransferError): string {
  const known = formatKnownLedgerTransferError(error);
  return known ?? safeJsonWithBigInts(error);
}

function formatKnownLedgerTransferError(error: unknown): string | null {
  if (!isObject(error)) return null;
  if (hasOwn(error, "InsufficientFunds")) {
    return formatApproveErrorField(error, "InsufficientFunds", "balance", "kinic");
  }
  if (hasOwn(error, "BadFee")) {
    return formatApproveErrorField(error, "BadFee", "expected_fee", "kinic");
  }
  if (hasOwn(error, "Duplicate")) {
    return formatApproveErrorField(error, "Duplicate", "duplicate_of", null);
  }
  if (hasOwn(error, "CreatedInFuture")) {
    return formatApproveErrorField(error, "CreatedInFuture", "ledger_time", null);
  }
  if (hasOwn(error, "BadBurn")) {
    return formatApproveErrorField(error, "BadBurn", "min_burn_amount", "kinic");
  }
  if (hasOwn(error, "GenericError")) {
    const generic = Reflect.get(error, "GenericError");
    if (!isObject(generic)) return "GenericError";
    const message = Reflect.get(generic, "message");
    const errorCode = Reflect.get(generic, "error_code");
    const messageText = typeof message === "string" ? message : "unknown ledger error";
    const codeText = scalarText(errorCode);
    return codeText ? `GenericError: ${messageText} (code ${codeText})` : `GenericError: ${messageText}`;
  }
  if (hasOwn(error, "TemporarilyUnavailable")) return "TemporarilyUnavailable";
  if (hasOwn(error, "TooOld")) return "TooOld";
  return null;
}

function formatKnownLedgerApproveError(error: unknown): string | null {
  if (!isObject(error)) return null;
  if (hasOwn(error, "InsufficientFunds")) {
    return formatApproveErrorField(error, "InsufficientFunds", "balance", "kinic");
  }
  if (hasOwn(error, "BadFee")) {
    return formatApproveErrorField(error, "BadFee", "expected_fee", "kinic");
  }
  if (hasOwn(error, "AllowanceChanged")) {
    return formatApproveErrorField(error, "AllowanceChanged", "current_allowance", "kinic");
  }
  if (hasOwn(error, "Duplicate")) {
    return formatApproveErrorField(error, "Duplicate", "duplicate_of", null);
  }
  if (hasOwn(error, "CreatedInFuture")) {
    return formatApproveErrorField(error, "CreatedInFuture", "ledger_time", null);
  }
  if (hasOwn(error, "Expired")) {
    return formatApproveErrorField(error, "Expired", "ledger_time", null);
  }
  if (hasOwn(error, "GenericError")) {
    const generic = Reflect.get(error, "GenericError");
    if (!isObject(generic)) return "GenericError";
    const message = Reflect.get(generic, "message");
    const errorCode = Reflect.get(generic, "error_code");
    const messageText = typeof message === "string" ? message : "unknown ledger error";
    const codeText = scalarText(errorCode);
    return codeText ? `GenericError: ${messageText} (code ${codeText})` : `GenericError: ${messageText}`;
  }
  if (hasOwn(error, "TemporarilyUnavailable")) return "TemporarilyUnavailable";
  if (hasOwn(error, "TooOld")) return "TooOld";
  return null;
}

function formatApproveErrorField(error: object, variant: string, field: string, unit: "kinic" | null): string {
  const details = Reflect.get(error, variant);
  if (!isObject(details)) return variant;
  const value = Reflect.get(details, field);
  const text = scalarText(value);
  if (!text) return variant;
  const display = unit === "kinic" ? formatTokenAmountFromE8s(text) : text;
  return `${variant}: ${field} ${display}`;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return value.toString();
  }
  return null;
}

function safeJsonWithBigInts(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const ledgerIdlFactory: ActorInterfaceFactory = ({ IDL: idl }) => {
  const account = idl.Record({ owner: idl.Principal, subaccount: idl.Opt(idl.Vec(idl.Nat8)) });
  const allowanceArgs = idl.Record({ account, spender: account });
  const allowance = idl.Record({ allowance: idl.Nat, expires_at: idl.Opt(idl.Nat64) });
  const transferArgs = idl.Record({
    from_subaccount: idl.Opt(idl.Vec(idl.Nat8)),
    to: account,
    amount: idl.Nat,
    fee: idl.Opt(idl.Nat),
    memo: idl.Opt(idl.Vec(idl.Nat8)),
    created_at_time: idl.Opt(idl.Nat64)
  });
  const transferError = idl.Variant({
    GenericError: idl.Record({ message: idl.Text, error_code: idl.Nat }),
    TemporarilyUnavailable: idl.Null,
    BadBurn: idl.Record({ min_burn_amount: idl.Nat }),
    Duplicate: idl.Record({ duplicate_of: idl.Nat }),
    BadFee: idl.Record({ expected_fee: idl.Nat }),
    CreatedInFuture: idl.Record({ ledger_time: idl.Nat64 }),
    TooOld: idl.Null,
    InsufficientFunds: idl.Record({ balance: idl.Nat })
  });
  const approveArgs = idl.Record({
    fee: idl.Opt(idl.Nat),
    memo: idl.Opt(idl.Vec(idl.Nat8)),
    from_subaccount: idl.Opt(idl.Vec(idl.Nat8)),
    created_at_time: idl.Opt(idl.Nat64),
    amount: idl.Nat,
    expected_allowance: idl.Opt(idl.Nat),
    expires_at: idl.Opt(idl.Nat64),
    spender: account
  });
  const approveError = idl.Variant({
    GenericError: idl.Record({ message: idl.Text, error_code: idl.Nat }),
    TemporarilyUnavailable: idl.Null,
    Duplicate: idl.Record({ duplicate_of: idl.Nat }),
    BadFee: idl.Record({ expected_fee: idl.Nat }),
    AllowanceChanged: idl.Record({ current_allowance: idl.Nat }),
    CreatedInFuture: idl.Record({ ledger_time: idl.Nat64 }),
    TooOld: idl.Null,
    Expired: idl.Record({ ledger_time: idl.Nat64 }),
    InsufficientFunds: idl.Record({ balance: idl.Nat })
  });
  return idl.Service({
    icrc1_balance_of: idl.Func([account], [idl.Nat], ["query"]),
    icrc1_transfer: idl.Func([transferArgs], [idl.Variant({ Ok: idl.Nat, Err: transferError })], []),
    icrc2_allowance: idl.Func([allowanceArgs], [allowance], ["query"]),
    icrc2_approve: idl.Func([approveArgs], [idl.Variant({ Ok: idl.Nat, Err: approveError })], [])
  });
};
