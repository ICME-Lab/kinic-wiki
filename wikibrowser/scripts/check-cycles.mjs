import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const page = readFileSync(new URL("../app/cycles/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/cycles/cycles-client.tsx", import.meta.url), "utf8");
const wallet = readFileSync(new URL("../lib/cycles-wallet.ts", import.meta.url), "utf8");
const url = readFileSync(new URL("../lib/cycles-url.ts", import.meta.url), "utf8");
const idl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const connectOisy = sliceBetween(wallet, "export async function connectOisyWallet", "export async function connectPlugWallet");
const connectPlug = sliceBetween(wallet, "export async function connectPlugWallet", "export async function purchaseCyclesWithOisy");
const purchaseOisy = sliceBetween(wallet, "export async function purchaseCyclesWithOisy", "export async function purchaseCyclesWithPlug");
const purchasePlug = sliceBetween(wallet, "export async function purchaseCyclesWithPlug", "function approveParams");

assert.match(page, /\/cycles/);
assert.doesNotMatch(page, /canister_id \?\? params\.canisterId/);
assert.doesNotMatch(page, /amount_e8s \?\? params\.amountE8s/);
assert.match(page, /initialKinic=\{first\(params\.kinic\)\}/);
assert.match(client, /purchaseCyclesWithOisy/);
assert.match(client, /purchaseCyclesWithPlug/);
assert.match(client, /connectOisyWallet/);
assert.match(client, /connectPlugWallet/);
assert.doesNotMatch(client, /AuthClient|AUTH_CLIENT_CREATE_OPTIONS|authLoginOptions|notifyPrincipal|notifyIdentity/);
assert.match(client, /Connect OISY/);
assert.match(client, /Connect Plug/);
assert.match(client, /Purchase cycles with OISY/);
assert.match(client, /Purchase cycles with Plug/);
assert.match(client, /const purchaseDisabled = !selectedProvider \|\| Boolean\(error\) \|\| Boolean\(amountError\) \|\| busy/);
assert.match(client, /function WalletConnect/);
assert.match(client, /onClick=\{\(\) => void purchase\(\)\}/);
assert.doesNotMatch(client, /onCycles/);
assert.match(client, /parseKinicAmountE8sInput/);
assert.match(client, /parseCyclesTarget/);
assert.match(client, /initialKinic\?: string/);
assert.match(client, /useState\(\(\) => \(initialKinic\?\.trim\(\) \? initialKinic : "1"\)\)/);
assert.match(client, /KINIC/);
assert.doesNotMatch(client, /Login with Internet Identity|Notify identity/);
assert.match(wallet, /export async function connectOisyWallet/);
assert.match(wallet, /export async function connectPlugWallet/);
assert.match(wallet, /class CyclesPurchaseIcrcWallet extends IcrcWallet/);
assert.match(wallet, /async callCyclesPurchase\(params: IcrcCallCanisterRequestParams\)/);
assert.match(wallet, /export async function purchaseCyclesWithOisy\(request: CyclesPurchaseRequest, connection: ConnectedOisyWallet\)/);
assert.match(wallet, /export async function purchaseCyclesWithPlug\(request: CyclesPurchaseRequest, connection: ConnectedPlugWallet\)/);
assert.match(connectOisy, /CyclesPurchaseIcrcWallet\.connect/);
assert.match(connectOisy, /wallet\.accounts\(\)/);
assert.doesNotMatch(connectOisy, /getCyclesBillingConfig|previewDatabaseCyclesPurchase|whitelist/);
assert.match(connectPlug, /plug\.requestConnect\(\{\s*host:/);
assert.doesNotMatch(connectPlug, /getCyclesBillingConfig|previewDatabaseCyclesPurchase|whitelist/);
assert.match(purchaseOisy, /prepareCyclesPurchase\(request, connection\.owner\)/);
assert.match(purchasePlug, /prepareCyclesPurchase\(request, connection\.principal\)/);
assert.match(purchasePlug, /whitelist: \[request\.canisterId, prepared\.kinicLedgerCanisterId\]/);
assert.match(wallet, /icrc2_approve/);
assert.match(wallet, /icrc2_allowance/);
assert.doesNotMatch(wallet, /icrc1_fee/);
assert.match(wallet, /async function prepareCyclesPurchase/);
assert.match(wallet, /icrc2_allowance: idl\.Func\(\[allowanceArgs\], \[allowance\], \["query"\]\)/);
assert.match(wallet, /icrc2_approve: idl\.Func\(\[approveArgs\], \[idl\.Variant\(\{ Ok: idl\.Nat, Err: approveError \}\)\], \[\]\)/);
assert.doesNotMatch(wallet, /purchaseDatabaseCyclesFrom|notifyIdentity|wallet as unknown|OisyCanisterCaller/);
assert.doesNotMatch(wallet, /previewDatabaseCyclesPurchase/);
assert.match(wallet, /KINIC_LEDGER_FEE_E8S/);
assert.match(wallet, /function allowanceForCyclesPurchase\(amountE8s: bigint, transferFeeE8s: bigint\)/);
assert.match(wallet, /return amountE8s \+ transferFeeE8s/);
assert.doesNotMatch(wallet, /function paymentAmountE8sForCycles/);
assert.match(wallet, /payment_amount_e8s: paymentAmountE8s/);
assert.doesNotMatch(wallet, /expected_cycles|expected_config_version/);
assert.match(wallet, /amount_cycles/);
assert.match(wallet, /approveParams\(request\.canisterId, prepared\.approvedAllowanceE8s, prepared\.currentAllowanceE8s, prepared\.expiresAt\)/);
assert.match(wallet, /rawApproveArgs\(request\.canisterId, prepared\.approvedAllowanceE8s, prepared\.currentAllowanceE8s, prepared\.expiresAt\)/);
assert.match(wallet, /expected_allowance: \[expectedAllowanceE8s\]/);
assert.match(wallet, /expires_at: \[expiresAt\]/);
assert.match(wallet, /APPROVE_EXPIRES_IN_MS = 30 \* 60 \* 1000/);
assert.match(wallet, /assertConfiguredCyclesCanister\(request\.canisterId\)/);
assert.match(wallet, /oisyCallCyclesPurchase\(connection\.wallet, connection\.owner, request\.canisterId, prepared\.purchaseRequest\)/);
assert.match(wallet, /contentMap|Certificate|requestIdOf/);
assert.match(wallet, /purchase_database_cycles\(prepared\.purchaseRequest\)/);
assert.match(wallet, /encodeCyclesPurchaseArgs\(request: DatabaseCyclesPurchaseRequest\)/);
assert.match(wallet, /whitelist: \[request\.canisterId, prepared\.kinicLedgerCanisterId\]/);
assert.match(wallet, /spender: \{ owner: Principal\.fromText\(canisterId\), subaccount: \[\] \}/);
assert.match(wallet, /DEFAULT_OISY_SIGNER_URL/);
assert.match(wallet, /cycles purchase failed after approve; approval remains until/);
assert.match(client, /purchased cycles/);
assert.match(client, /purchasedCycles/);
assert.match(client, /approved allowance/);
assert.doesNotMatch(client, /Wallet approval uses the DB cycle amount plus the ledger transfer fee/);
assert.match(client, /transfer fee/);
assert.match(client, /Any authenticated wallet can purchase non-refundable cycles/);
assert.doesNotMatch(client, /withdraw KINIC|database balance/);
assert.doesNotMatch(client, /cycles canister does not match NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.match(url, /KINIC_DECIMALS/);
assert.match(url, /kinicBaseUnitsPerToken/);
assert.match(url, /KINIC must be a positive number with up to \$\{KINIC_DECIMALS\} decimals/);
assert.match(url, /KINIC amount e8s must be <= u64::MAX/);
assert.match(url, /database_id is required/);
assert.doesNotMatch(url, /params\.set\("amount_e8s"/);
assert.match(idl, /get_cycles_billing_config/);
assert.doesNotMatch(idl, /preview_database_cycles_purchase/);
assert.match(idl, /purchase_database_cycles/);
assert.match(idl, /icrc10_supported_standards/);
assert.match(idl, /icrc21_canister_call_consent_message/);
assert.doesNotMatch(idl, /purchase_database_cycles_from/);
assert.match(vfsClient, /export async function getCyclesBillingConfig/);
assert.doesNotMatch(vfsClient, /previewDatabaseCyclesPurchase/);
assert.doesNotMatch(vfsClient, /purchaseDatabaseCyclesFrom/);

const cyclesUrlModule = loadTsModule("../lib/cycles-url.ts", {
  "@/lib/cycles": {
    KINIC_DECIMALS: 8,
    kinicBaseUnitsPerToken: () => 100_000_000n
  }
});
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams("database_id=db_ok-1")).databaseId, "db_ok-1");
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams("databaseId=dbLegacy")).databaseId, "dbLegacy");
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams()), "database_id is required");
assert.equal(cyclesUrlModule.parseCyclesTarget(new URLSearchParams("database_id=bad/path")), "database_id contains unsupported characters");
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("1"), 100_000_000n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("0.00000001"), 1n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("1.23456789"), 123_456_789n);
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("0"), "KINIC amount must be positive");
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("1.000000001"), "KINIC must be a positive number with up to 8 decimals");
assert.equal(cyclesUrlModule.parseKinicAmountE8sInput("184467440737.09551616"), "KINIC amount e8s must be <= u64::MAX");

const cborMock = { decoded: {} };
const walletModule = loadTsModule(
  "../lib/cycles-wallet.ts",
  {
    "@dfinity/oisy-wallet-signer/icrc-wallet": { IcrcWallet: class {} },
    "@dfinity/utils": {
      base64ToUint8Array: (value) => new Uint8Array(Buffer.from(value, "base64")),
      uint8ArrayToBase64: (value) => Buffer.from(value).toString("base64")
    },
    "@icp-sdk/core/agent": {
      Actor: { createActor: () => ({}) },
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
    "@/lib/vfs-client": { getCyclesBillingConfig: async () => ({ kinicLedgerCanisterId: "ledger" }) },
    "@/lib/vfs-idl": { idlFactory: () => ({}) },
    "@/lib/cycles": { formatRawCycles: (value) => value.toString(), KINIC_LEDGER_FEE_E8S: 10_000n }
  },
  "Object.assign(exports, { __test: { allowanceForCyclesPurchase, assertConfiguredCyclesCanister, purchaseAfterApprove, decodeOisyCyclesPurchaseResult } });"
);
const walletTest = walletModule.__test;
assert.equal(walletTest.allowanceForCyclesPurchase(100_000_000n, 10_000n), 100_010_000n);
assert.throws(() => walletTest.assertConfiguredCyclesCanister("aaaaa-aa"), /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured/);
walletModule.__context.process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID = "aaaaa-aa";
assert.throws(() => walletTest.assertConfiguredCyclesCanister("bbbbb-bb"), /VFS canister does not match NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
await assert.rejects(
  () => walletTest.purchaseAfterApprove(async () => {
    throw new Error("purchase rejected");
  }, 1_700_000_000_000_000_000n),
  /cycles purchase failed after approve; approval remains until .*purchase rejected/
);
cborMock.decoded = { method_name: "write_node" };
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "aaaaa-aa",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response method mismatch/
);
cborMock.decoded = {
  method_name: "purchase_database_cycles",
  canister_id: new Uint8Array([2]),
  arg: new Uint8Array([1])
};
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "aaaaa-aa",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response canister mismatch/
);
cborMock.decoded = {
  method_name: "purchase_database_cycles",
  canister_id: new Uint8Array([]),
  arg: new Uint8Array([9])
};
await assert.rejects(
  () => walletTest.decodeOisyCyclesPurchaseResult({
    canisterId: "bytes:",
    method: "purchase_database_cycles",
    arg: Buffer.from([1]).toString("base64"),
    result: { contentMap: "unused", certificate: "unused" }
  }),
  /wallet response argument mismatch/
);

console.log("Cycles checks OK");

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `${startText} not found`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${endText} not found`);
  return source.slice(start, end);
}

function loadTsModule(relativePath, mocks, append = "") {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(`${source}\n${append}`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
  const module = { exports: {} };
  const context = {
    Buffer,
    Date,
    TextEncoder,
    Uint8Array,
    URLSearchParams,
    console,
    exports: module.exports,
    module,
    process: { env: {} },
    require: (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      throw new Error(`unexpected module import: ${id}`);
    }
  };
  vm.runInNewContext(transpiled, context, { filename: relativePath });
  return Object.assign(module.exports, { __context: context });
}
