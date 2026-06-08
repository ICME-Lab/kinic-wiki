// Where: wikibrowser/scripts/check-cycles-wallet.mjs
// What: exercises cycles wallet helpers through a small TypeScript VM harness.
// Why: keep wallet behavior checks separate from /cycles page structure guards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const cborMock = { decoded: {} };
let lastBalanceAccount = null;
let lastConfigCanister = null;
let ledgerAllowanceMock = { allowance: 0n, expires_at: [] };
let approveCalls = 0;
let purchaseCalls = 0;
let kinicDepositCalls = 0;
let marketPurchaseCalls = 0;
let identityKinicDepositCalls = 0;
let lastApproveArgs = null;
let lastKinicDepositRequest = null;
let lastMarketPurchaseRequest = null;
let lastIdentityKinicDeposit = null;
const ledgerActorMock = {
  icrc1_balance_of: async (account) => {
    lastBalanceAccount = account;
    return 123_456_789n;
  },
  icrc2_allowance: async () => ledgerAllowanceMock,
  icrc2_approve: async (args) => {
    approveCalls += 1;
    lastApproveArgs = args;
    return { Ok: 1n };
  }
};
const vfsActorMock = {
  purchase_database_cycles: async () => {
    purchaseCalls += 1;
    return { Ok: { block_index: 7n, amount_cycles: 1000n, balance_cycles: 2000n } };
  },
  kinic_deposit_balance: async (request) => {
    kinicDepositCalls += 1;
    lastKinicDepositRequest = request;
    return { Ok: { block_index: 9n, amount_e8s: request.amount_e8s, balance_e8s: 300_000_000n } };
  },
  market_purchase_access: async (request) => {
    marketPurchaseCalls += 1;
    lastMarketPurchaseRequest = request;
    return {
      Ok: {
        order_id: "order_1",
        listing_id: request.listing_id,
        database_id: "db_market",
        buyer_principal: "plug-principal",
        seller_principal: "seller-principal",
        price_e8s: request.price_e8s,
        listing_revision: 2n,
        created_at_ms: 123n
      }
    };
  }
};
const plugMock = {
  requestConnect: async () => true,
  agent: { getPrincipal: async () => ({ toText: () => "plug-principal" }) },
  createActor: async ({ canisterId }) => (canisterId === "ledger" ? ledgerActorMock : vfsActorMock)
};

const walletModule = loadTsModule(
  "../lib/kinic-wallet.ts",
  {
    "@dfinity/oisy-wallet-signer/icrc-wallet": { IcrcWallet: class {} },
    "@dfinity/utils": {
      base64ToUint8Array: (value) => new Uint8Array(Buffer.from(value, "base64")),
      uint8ArrayToBase64: (value) => Buffer.from(value).toString("base64")
    },
    "@icp-sdk/core/agent": {
      Actor: { createActor: () => ledgerActorMock },
      AnonymousIdentity: class {},
      Cbor: { decode: () => cborMock.decoded },
      Certificate: { create: async () => ({}) },
      HttpAgent: { createSync: () => ({ isLocal: () => false, rootKey: new Uint8Array([1]) }) },
      lookupResultToBuffer: () => null,
      requestIdOf: () => new Uint8Array([1])
    },
    "@icp-sdk/core/candid": { IDL: {} },
    "@icp-sdk/core/principal": {
      Principal: {
        fromText: (value) => ({ toText: () => value }),
        fromUint8Array: (value) => ({ toText: () => `bytes:${Array.from(value).join(",")}` })
      }
    },
    "@/lib/vfs-client": {
      getCyclesBillingConfig: async (canisterId) => {
        lastConfigCanister = canisterId;
        return { kinicLedgerCanisterId: "ledger", cyclesPerKinic: "1000" };
      },
      kinicDepositBalance: async (canisterId, identity, amountE8s, expectedFeeE8s) => {
        identityKinicDepositCalls += 1;
        lastIdentityKinicDeposit = {
          canisterId,
          principal: identity.getPrincipal().toText(),
          amountE8s,
          expectedFeeE8s
        };
        return { blockIndex: "19", amountE8s, balanceE8s: "400000000" };
      }
    },
    "@/lib/vfs-idl": { idlFactory: () => ({}) },
    "@/lib/cycles": {
      cyclesForPaymentAmountE8s: (amountE8s, cyclesPerKinic) => (amountE8s * cyclesPerKinic) / 100_000_000n,
      formatRawCycles: (value) => value.toString(),
      KINIC_LEDGER_FEE_E8S: 100_000n,
      MAX_CANISTER_I64: 9_223_372_036_854_775_807n,
      MAX_LEDGER_U64: 18_446_744_073_709_551_615n,
    },
    "@/lib/kinic-amount": { formatTokenAmountFromE8s }
  },
  "Object.assign(exports, { __test: { allowanceForKinicTransfer, assertCanisterPaymentAmountE8s, assertConfiguredCyclesCanister, callAfterApprove, decodeOisyCyclesPurchaseResult, decodeOisyKinicDepositResult, decodeOisyMarketPurchaseResult, formatLedgerApproveError } });"
);
const walletTest = walletModule.__test;

assert.equal(walletTest.allowanceForKinicTransfer(100_000_000n, 100_000n), 100_100_000n);
assert.throws(() => walletTest.assertCanisterPaymentAmountE8s(9_223_372_036_854_775_808n), /KINIC amount e8s exceeds canister limit/);
assert.throws(() => walletTest.allowanceForKinicTransfer(18_446_744_073_709_551_615n, 1n), /approved allowance exceeds u64::MAX/);
assert.throws(() => walletTest.assertConfiguredCyclesCanister("aaaaa-aa"), /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured/);
walletModule.__context.process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID = "aaaaa-aa";
assert.throws(() => walletTest.assertConfiguredCyclesCanister("bbbbb-bb"), /VFS canister does not match NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
await assert.rejects(
  () => walletTest.callAfterApprove(async () => {
    throw new Error("purchase rejected");
  }, { approveBlockIndex: "11", expiresAt: 1_700_000_000_000_000_000n }),
  /KINIC canister call failed after approval; approval remains until .*purchase rejected/
);
await assert.rejects(
  () => walletTest.callAfterApprove(async () => {
    throw new Error("purchase rejected");
  }, { approveBlockIndex: null, expiresAt: null }),
  /KINIC canister call failed after approval; approval remains without expiry: purchase rejected/
);
await walletTest.callAfterApprove(async () => "ok", { approveBlockIndex: "11", expiresAt: 1_700_000_000_000_000_000n });
assert.equal(
  walletTest.formatLedgerApproveError({ InsufficientFunds: { balance: 100_000n } }),
  "InsufficientFunds: balance 0.001 KINIC"
);
assert.equal(
  walletTest.formatLedgerApproveError({ BadFee: { expected_fee: 100_000n } }),
  "BadFee: expected_fee 0.001 KINIC"
);
assert.equal(
  walletTest.formatLedgerApproveError({ AllowanceChanged: { current_allowance: 100_000n } }),
  "AllowanceChanged: current_allowance 0.001 KINIC"
);
assert.doesNotThrow(() => walletTest.formatLedgerApproveError({ Unknown: { nested: { value: 42n } } }));
assert.match(walletTest.formatLedgerApproveError({ Unknown: { nested: { value: 42n } } }), /"value":"42"/);

assert.equal(
  await walletModule.getConnectedWalletKinicBalance("aaaaa-aa", { provider: "oisy", connection: { owner: "oisy-principal" } }),
  "123456789"
);
assert.equal(lastConfigCanister, "aaaaa-aa");
assert.equal(lastBalanceAccount.owner.toText(), "oisy-principal");
assert.equal(Array.isArray(lastBalanceAccount.subaccount), true);
assert.equal(lastBalanceAccount.subaccount.length, 0);
assert.equal(
  await walletModule.getConnectedWalletKinicBalance("aaaaa-aa", { provider: "plug", connection: { principal: "plug-principal" } }),
  "123456789"
);
assert.equal(lastBalanceAccount.owner.toText(), "plug-principal");
assert.equal(Array.isArray(lastBalanceAccount.subaccount), true);
assert.equal(lastBalanceAccount.subaccount.length, 0);

ledgerAllowanceMock = { allowance: 0n, expires_at: [] };
approveCalls = 0;
purchaseCalls = 0;
lastApproveArgs = null;
assert.equal(
  (
    await walletModule.purchaseCyclesWithPlug(
      { canisterId: "aaaaa-aa", databaseId: "db_alpha", paymentAmountE8s: 100_000_000n },
      { principal: "plug-principal" }
    )
  ).approveBlockIndex,
  "1"
);
assert.equal(approveCalls, 1);
assert.equal(lastApproveArgs.expected_allowance[0], 0n);
assert.equal(purchaseCalls, 1);

ledgerAllowanceMock = { allowance: 100_100_000n, expires_at: [] };
approveCalls = 0;
purchaseCalls = 0;
assert.equal(
  (
    await walletModule.purchaseCyclesWithPlug(
      { canisterId: "aaaaa-aa", databaseId: "db_alpha", paymentAmountE8s: 100_000_000n },
      { principal: "plug-principal" }
    )
  ).approveBlockIndex,
  null
);
assert.equal(approveCalls, 0);
assert.equal(purchaseCalls, 1);

ledgerAllowanceMock = { allowance: 100_100_000n, expires_at: [BigInt(Date.now() + 60_000) * 1_000_000n] };
approveCalls = 0;
assert.equal(
  (
    await walletModule.purchaseCyclesWithPlug(
      { canisterId: "aaaaa-aa", databaseId: "db_alpha", paymentAmountE8s: 100_000_000n },
      { principal: "plug-principal" }
    )
  ).approveBlockIndex,
  null
);
assert.equal(approveCalls, 0);

ledgerAllowanceMock = { allowance: 100_100_000n, expires_at: [BigInt(Date.now() - 60_000) * 1_000_000n] };
approveCalls = 0;
await walletModule.purchaseCyclesWithPlug(
  { canisterId: "aaaaa-aa", databaseId: "db_alpha", paymentAmountE8s: 100_000_000n },
  { principal: "plug-principal" }
);
assert.equal(approveCalls, 1);

ledgerAllowanceMock = { allowance: 0n, expires_at: [] };
approveCalls = 0;
kinicDepositCalls = 0;
lastKinicDepositRequest = null;
const kinicDeposit = await walletModule.depositKinicBalanceWithPlug(
  { canisterId: "aaaaa-aa", amountE8s: 200_000_000n },
  { principal: "plug-principal" }
);
assert.equal(kinicDeposit.approveBlockIndex, "1");
assert.equal(kinicDeposit.depositBlockIndex, "9");
assert.equal(kinicDepositCalls, 1);
assert.equal(lastKinicDepositRequest.amount_e8s, 200_000_000n);
assert.equal(lastKinicDepositRequest.expected_fee_e8s, 100_000n);

ledgerAllowanceMock = { allowance: 0n, expires_at: [] };
approveCalls = 0;
identityKinicDepositCalls = 0;
lastIdentityKinicDeposit = null;
const identityDeposit = await walletModule.depositKinicBalanceWithIdentity(
  { canisterId: "aaaaa-aa", amountE8s: 300_000_000n },
  { getPrincipal: () => ({ toText: () => "ii-principal" }) }
);
assert.equal(identityDeposit.provider, "ii");
assert.equal(identityDeposit.approveBlockIndex, "1");
assert.equal(identityDeposit.depositBlockIndex, "19");
assert.equal(identityDeposit.balanceE8s, "400000000");
assert.equal(approveCalls, 1);
assert.equal(identityKinicDepositCalls, 1);
assert.equal(lastIdentityKinicDeposit.canisterId, "aaaaa-aa");
assert.equal(lastIdentityKinicDeposit.principal, "ii-principal");
assert.equal(lastIdentityKinicDeposit.amountE8s, "300000000");
assert.equal(lastIdentityKinicDeposit.expectedFeeE8s, "100000");

marketPurchaseCalls = 0;
lastMarketPurchaseRequest = null;
const marketPurchase = await walletModule.purchaseMarketAccessWithPlug(
  { canisterId: "aaaaa-aa", listingId: "market1", priceE8s: 50_000_000n },
  { principal: "plug-principal" }
);
assert.equal(marketPurchase.provider, "plug");
assert.equal(marketPurchase.orderId, "order_1");
assert.equal(marketPurchase.buyerPrincipal, "plug-principal");
assert.equal(marketPurchase.priceE8s, "50000000");
assert.equal(marketPurchase.listingRevision, "2");
assert.equal(marketPurchaseCalls, 1);
assert.equal(lastMarketPurchaseRequest.listing_id, "market1");
assert.equal(lastMarketPurchaseRequest.price_e8s, 50_000_000n);
assert.equal("expected_revision" in lastMarketPurchaseRequest, false);

cborMock.decoded = { method_name: "write_node" };
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "aaaaa-aa",
    sender: "bytes:7",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response method mismatch/
);
cborMock.decoded = {
  method_name: "purchase_database_cycles",
  canister_id: new Uint8Array([2]),
  sender: new Uint8Array([7]),
  arg: new Uint8Array([1])
};
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "aaaaa-aa",
    sender: "bytes:7",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response canister mismatch/
);
cborMock.decoded = {
  method_name: "purchase_database_cycles",
  canister_id: new Uint8Array([]),
  sender: new Uint8Array([7]),
  arg: new Uint8Array([9])
};
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "bytes:",
    sender: "bytes:7",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response argument mismatch/
);
cborMock.decoded = {
  method_name: "purchase_database_cycles",
  canister_id: new Uint8Array([]),
  sender: new Uint8Array([8]),
  arg: new Uint8Array([1])
};
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "bytes:",
    sender: "bytes:7",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response sender mismatch/
);

cborMock.decoded = { method_name: "kinic_deposit_balance" };
await assert.rejects(
  () => walletTest.decodeOisyMarketPurchaseResult({
    canisterId: "aaaaa-aa",
    sender: "bytes:7",
    method: "market_purchase_access",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response method mismatch/
);

const sessionModule = loadTsModule(
  "../app/app-session-provider.tsx",
  {
    "@icp-sdk/auth/client": { AuthClient: { create: async () => ({}) } },
    "react": {
      createContext: () => ({}),
      useCallback: (run) => run,
      useContext: () => null,
      useEffect: () => undefined,
      useRef: (current) => ({ current }),
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined]
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "@/lib/auth": { AUTH_CLIENT_CREATE_OPTIONS: {}, authLoginOptions: () => ({}) },
    "@/lib/kinic-wallet": {
      connectOisyWallet: async () => ({ owner: "oisy-principal" }),
      connectPlugWallet: async () => ({ principal: "plug-principal" }),
      getConnectedWalletKinicBalance: async () => "123456789"
    },
    "@/lib/vfs-client": { kinicGetBalance: async () => ({ balanceE8s: "0" }) }
  },
  "Object.assign(exports, { __test: { readStoredWallet, safeSessionStorageGet, safeSessionStorageSet, safeSessionStorageRemove } });"
);
const sessionTest = sessionModule.__test;
sessionModule.__context.sessionStorage = {
  getItem: () => {
    throw new Error("get blocked");
  },
  setItem: () => {
    throw new Error("set blocked");
  },
  removeItem: () => {
    throw new Error("remove blocked");
  }
};
assert.equal(sessionTest.safeSessionStorageGet("wallet"), null);
assert.doesNotThrow(() => sessionTest.safeSessionStorageSet("wallet", "value"));
assert.doesNotThrow(() => sessionTest.safeSessionStorageRemove("wallet"));
assert.equal(sessionTest.readStoredWallet(), null);
sessionModule.__context.sessionStorage = {
  getItem: () => JSON.stringify({ provider: "plug", principal: "plug-principal" }),
  setItem: () => undefined,
  removeItem: () => undefined
};
const restoredSessionWallet = sessionTest.readStoredWallet();
assert.equal(restoredSessionWallet.provider, "plug");
assert.equal(restoredSessionWallet.connection.principal, "plug-principal");

console.log("Cycles wallet checks OK");

function formatTokenAmountFromE8s(value) {
  const e8s = typeof value === "bigint" ? value : BigInt(value);
  if (e8s === 0n) return "0.000 KINIC";
  const whole = e8s / 100_000_000n;
  const thousandths = (e8s % 100_000_000n) / 100_000n;
  if (whole === 0n && thousandths === 0n) return "<0.001 KINIC";
  return `${whole.toString()}.${thousandths.toString().padStart(3, "0")} KINIC`;
}

function loadTsModule(relativePath, mocks, append = "") {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(`${source}\n${append}`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const commonjsModule = { exports: {} };
  const context = {
    Buffer,
    Date,
    TextEncoder,
    Uint8Array,
    URLSearchParams,
    console,
    exports: commonjsModule.exports,
    module: commonjsModule,
    process: { env: {} },
    window: { ic: { plug: plugMock } },
    require: (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      throw new Error(`unexpected module import: ${id}`);
    }
  };
  vm.runInNewContext(transpiled, context, { filename: relativePath });
  return Object.assign(commonjsModule.exports, { __context: context });
}
