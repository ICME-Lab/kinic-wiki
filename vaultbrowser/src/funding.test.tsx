// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as renderReact, screen, waitFor } from "@testing-library/react";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { createWalletSessionManager } from "@kinic/payments/wallet-session";
import { createRecoveryStore } from "@kinic/payments/recovery-store";
import type { VaultClient } from "@kinic/vault-client";
import type { Payment, PurchaseRequest } from "@kinic/vault-candid";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Funding } from "./funding";
import { VaultFundingProvider, useVaultFundingSession } from "./funding/session";
import { encodeVaultRecoveryContext, vaultFundingScopes } from "./funding/adapter";

const identity = Ed25519KeyIdentity.generate(), owner = identity.getPrincipal();
const ledger = Principal.fromUint8Array(Uint8Array.of(5,1));
const funding = {ledger,recipient:owner,cycles_per_kinic:1_000_000_000n};
const config = {canister:"aaaaa-aa",origin:location.origin,host:"http://localhost:4943",local:true,
  derivationOrigin:"http://aaaaa-aa.localhost",identityProvider:"http://id.localhost",fundingMode:"synthetic-test-only" as const};
function quoted(req?:PurchaseRequest): Payment {
  const now = BigInt(Date.now()) * 1_000_000n;
  const request = req ?? {operation:new Uint8Array(16).fill(4),beneficiary:owner,amount_e8s:100_000_000n,
    min_credits:20_000_000n,created_at_time:now};
  return {request, wallet:owner, status:{Quoted:null},config:funding,fee:10n,credits:request.amount_e8s * 10n,
    memo:new Uint8Array(32).fill(3),created_at_time:now,generation:1n,sent_at:0n,attempt:0n,uncertain:false,preparing:false,reconciliation:[]};
}
const payment: Payment = {...quoted(),status:{Unknown:null},uncertain:true};
let saved: Payment[];
let allowance: bigint, generation: number, funds: bigint;
const actor = {list_payments:vi.fn(),payment_status:vi.fn(),quote_purchase:vi.fn(),pay_purchase:vi.fn(),cancel_quote:vi.fn(),
  reconcile_purchase:vi.fn(), account_balance:vi.fn(),
  beneficiary_payments:vi.fn(), beneficiary_payment_status:vi.fn(), beneficiary_pay_purchase:vi.fn(),
  beneficiary_cancel_quote:vi.fn(), beneficiary_reconcile_purchase:vi.fn(), get_funding_config:vi.fn(), icrc2_approve:vi.fn(),
  icrc1_decimals:async()=>8,icrc1_fee:async()=>10n,icrc1_balance_of:async()=>funds,
  icrc2_allowance:async()=>({allowance,expires_at:[]})};
const manager = () => createWalletSessionManager({origin:location.origin,host:config.host,signerUrl:location.origin + "/sign",identity});
let wallet: ReturnType<typeof manager>;
let mode: "synthetic-test-only" | "unavailable";
function client(p?: Payment) {
  if (p) saved = [p];
  return {identity,canister:config.canister,session:{capture:()=>generation},actor} as unknown as VaultClient;
}
function render(node:React.ReactNode) {
  const settings = {...config,fundingMode:mode};
  return renderReact(<VaultFundingProvider config={settings} identity={identity} manager={wallet}>{node}</VaultFundingProvider>);
}
function mount() { return render(<Funding client={client()} onFunded={async()=>{}}/>); }
const button = (name:string) => screen.findByRole("button",{name}) as Promise<HTMLButtonElement>;
async function click(name:string) {
  const el = await button(name);
  await waitFor(()=>expect(el.disabled).toBe(false));
  fireEvent.click(el);
}
async function review() { await click("Review payment"); await button("Pay 1 KINIC"); }
beforeEach(()=>{
  vi.resetAllMocks(); localStorage.clear();
  Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async(_name:string,_options:object,run:(lock:object)=>Promise<void>)=>run({})}});
  const agent=HttpAgent.createSync({host:config.host});
  vi.spyOn(agent,"fetchRootKey").mockResolvedValue(new Uint8Array());
  vi.spyOn(HttpAgent,"createSync").mockReturnValue(agent);
  vi.spyOn(Actor,"createActor").mockReturnValue(actor as never);
  mode="synthetic-test-only"; allowance=0n; funds=100_000_020n; generation=0; saved=[];
  actor.get_funding_config.mockResolvedValue({Ok:[funding]});
  actor.list_payments.mockImplementation(async()=>({Ok:saved}));
  actor.quote_purchase.mockImplementation(async(req:PurchaseRequest)=>{saved=[quoted(req)];return {Ok:saved[0]};});
  actor.payment_status.mockImplementation(async(id:Uint8Array)=>({Ok:saved.filter(p=>String(p.request.operation)===String(id))}));
  actor.icrc2_approve.mockImplementation(async(args)=>{allowance=args.amount;funds-=10n;return {Ok:1n};});
  actor.pay_purchase.mockImplementation(async()=>{saved[0].status={Paid:8n};return {Ok:saved[0]};});
  actor.cancel_quote.mockImplementation(async()=>{saved[0].status={Expired:null};return {Ok:saved[0]};});
  actor.account_balance.mockResolvedValue({Ok:1_000_000_000n});
  // The signed-in beneficiary reads and submits payer-signed quotes; reuse the
  // payer-side mocks so each test still counts one logical operation.
  const mine = (payer:Principal) => (result:{Ok:Payment[]}) =>
    ({Ok:result.Ok.filter(p=>p.wallet.toText()===payer.toText() && p.request.beneficiary.toText()===owner.toText())});
  actor.beneficiary_payments.mockImplementation(async(payer:Principal)=>mine(payer)(await actor.list_payments()));
  actor.beneficiary_payment_status.mockImplementation(async(payer:Principal,id:Uint8Array)=>mine(payer)(await actor.payment_status(id)));
  actor.beneficiary_pay_purchase.mockImplementation(async(_payer:Principal,id:Uint8Array)=>actor.pay_purchase(id));
  actor.beneficiary_cancel_quote.mockImplementation(async(_payer:Principal,id:Uint8Array)=>actor.cancel_quote(id));
  actor.beneficiary_reconcile_purchase.mockImplementation(async(_payer:Principal,id:Uint8Array)=>actor.reconcile_purchase(id));
  wallet=manager();
});
afterEach(()=>{cleanup();wallet.destroy();vi.restoreAllMocks();});
it("offers all three funding sources and shows the synthetic notice", async()=>{
  mount();
  for(const name of ["Internet Identity","OISY","Plug"]) expect(await screen.findByRole("radio",{name})).toBeTruthy();
  expect(screen.getByText(/Synthetic test funding/)).toBeTruthy();
});
it("reviews exact amount, fees and beneficiary before submitting the frozen operation once",async()=>{
  mount(); await review();
  expect(screen.getByText("1.0000002 KINIC")).toBeTruthy();
  expect(actor.icrc2_approve).not.toHaveBeenCalled();
  expect(screen.getByRole("radio",{name:"OISY"})).toHaveProperty("disabled",true);
  await click("Pay 1 KINIC");
  expect(await screen.findByText("Payment complete")).toBeTruthy();
  const p=saved[0];
  expect(actor.icrc2_approve).toHaveBeenCalledWith(expect.objectContaining({amount:100000010n,fee:[10n],memo:[p.memo],
    created_at_time:[p.created_at_time],expires_at:[p.created_at_time+300000000000n]}));
  expect(actor.pay_purchase).toHaveBeenCalledExactlyOnceWith(p.request.operation);
  expect(actor.quote_purchase).toHaveBeenCalledTimes(1);
});
it("keeps disabled funding history readable and checks the original Unknown operation",async()=>{
  mode="unavailable"; saved=[{...payment}]; mount();
  await click("Check payment status");
  await waitFor(()=>expect(actor.payment_status).toHaveBeenCalledWith(payment.request.operation));
  expect(screen.getByText(/Funding is unavailable/)).toBeTruthy();
  expect(actor.icrc2_approve).not.toHaveBeenCalled(); expect(actor.quote_purchase).not.toHaveBeenCalled();
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("reports each completed check of an unchanged unpaid payment",async()=>{
  saved=[quoted()]; mount(); await click("Check payment status");
  expect(await screen.findByText(/Status checked. This payment is still unpaid/)).toBeTruthy();
  await click("Check payment status");
  await waitFor(()=>expect(actor.payment_status.mock.calls.length).toBeGreaterThanOrEqual(4));
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("expires and cancels a verified unpaid quote only on request",async()=>{
  const p=quoted();p.created_at_time-=301_000_000_000n;saved=[p];mount();await click("Check payment status");
  expect(await screen.findByText(/quote has expired/)).toBeTruthy();
  await click("Cancel unpaid payment");
  expect(await screen.findByText(/existing ledger allowance remains active/)).toBeTruthy();
  expect(actor.cancel_quote).toHaveBeenCalledOnce();expect(actor.quote_purchase).not.toHaveBeenCalled();
});
it("uses a validated saved ledger when funding is disabled and history cannot load",async()=>{
  mode="unavailable";saved=[payment];
  const scope={origin:location.origin,host:config.host,spender:config.canister,ledger:ledger.toText(),
    payer:{provider:"ii" as const,owner:owner.toText()},target:{kind:"vault" as const,beneficiary:owner.toText()}};
  createRecoveryStore(localStorage).put({version:1,scope,id:"04".repeat(16),stage:"purchase-dispatched",
    context:encodeVaultRecoveryContext(payment.request,payment)});
  actor.list_payments.mockRejectedValue(Error("offline"));mount();await click("Check payment status");
  await waitFor(()=>expect(actor.payment_status).toHaveBeenCalledWith(payment.request.operation));
  expect(actor.quote_purchase).not.toHaveBeenCalled();
});
it("shows confirmation even if refreshing prepaid credit fails",async()=>{
  actor.account_balance.mockRejectedValue(Error("offline"));
  mount(); await review(); await click("Pay 1 KINIC");
  expect(await screen.findByText(/Balance unavailable. Your payment was confirmed/)).toBeTruthy();
  expect(screen.getByText("Payment complete")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"New payment"})).toBeNull();
  actor.account_balance.mockResolvedValue({Ok:100n});
  await click("Refresh credit balance");await button("New payment");
  expect(actor.pay_purchase).toHaveBeenCalledOnce();
});
it("never replaces an uncertain approval after a status check",async()=>{
  actor.icrc2_approve.mockRejectedValue(Error("lost"));mount();await review();await click("Pay 1 KINIC");
  await screen.findByText("Payment needs a status check");await click("Check payment status");
  await waitFor(()=>expect(actor.payment_status).toHaveBeenCalled());
  expect(screen.queryByRole("button",{name:"Pay 1 KINIC"})).toBeNull();
  expect(actor.icrc2_approve).toHaveBeenCalledOnce();expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("does not dispatch a purchase after unmount during approval",async()=>{
  let finish!:(value:unknown)=>void;
  actor.icrc2_approve.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=mount();await review();await click("Pay 1 KINIC");await screen.findByText("Approving");
  await waitFor(()=>expect(actor.icrc2_approve).toHaveBeenCalled());view.unmount();
  await act(async()=>finish({Ok:1n}));
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("shows the actionable failure when Web Locks is missing",async()=>{
  Object.defineProperty(navigator,"locks",{configurable:true,value:null});
  mount();await click("Review payment");
  expect(await screen.findByText(/Web Locks support/)).toBeTruthy();expect(actor.quote_purchase).not.toHaveBeenCalled();
});
it("preserves corrupt local recovery and blocks a new quote",async()=>{
  const target={kind:"vault",beneficiary:owner.toText()};
  const key="kinic.payments.v1:"+JSON.stringify([location.origin,config.host,ledger.toText(),config.canister,target]);
  saved=[payment];
  actor.payment_status.mockResolvedValue({Ok:[{...payment,status:{Quoted:null},uncertain:false}]});
  localStorage.setItem(key,"{");mount();
  expect(await screen.findByText(/payment record could not be saved or read/)).toBeTruthy();
  expect((await button("Review payment")).disabled).toBe(true);
  await click("Check payment status");
  await screen.findByText(/Status checked.*quote.*original payment/i);
  expect(screen.queryByText(/still unpaid/i)).toBeNull();
  expect(actor.payment_status).toHaveBeenCalledExactlyOnceWith(payment.request.operation);
  expect(localStorage.getItem(key)).toBe("{");
  for(const call of [actor.quote_purchase,actor.icrc2_approve,actor.pay_purchase,actor.reconcile_purchase,actor.cancel_quote])
    expect(call).not.toHaveBeenCalled();
});
it("resumes the original ledger cursor without an extra payment",async()=>{
  saved=[{...payment}]; let cursor=0n;
  actor.reconcile_purchase.mockImplementation(async()=>({Ok:{payment:saved[0],next:++cursor,end:12n,scanned:1n,can_continue:cursor<12n}}));
  mount();await click("Scan ledger for this payment");await screen.findByText("Ledger scan: next 10 of 12.");
  await click("Resume ledger scan");await screen.findByText("Ledger scan: next 12 of 12.");
  expect(actor.reconcile_purchase.mock.calls.every(([id])=>String(id)===String(payment.request.operation))).toBe(true);
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("checks an unknown payment without another approval, quote or purchase", async () => {
  saved=[{...payment}];mount();await click("Check payment status");
  await screen.findByText("Payment needs a status check");
  expect(actor.payment_status).toHaveBeenCalledWith(payment.request.operation);
  expect(actor.icrc2_approve).not.toHaveBeenCalled();
  expect(actor.pay_purchase).not.toHaveBeenCalled();
  expect(actor.quote_purchase).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"Pay 1 KINIC"})).toBeNull();
});
it("starts a second payment after a confirmed receipt only on request",async()=>{
  mount();await review();await click("Pay 1 KINIC");await screen.findByText("Payment complete");
  const original=saved[0].request.operation;
  expect(actor.quote_purchase).toHaveBeenCalledTimes(1);
  await click("New payment");
  funds=100_000_020n;
  await review();await click("Pay 1 KINIC");await screen.findByText("Payment complete");
  expect(actor.quote_purchase).toHaveBeenCalledTimes(2);
  expect(String(saved[0].request.operation)).not.toBe(String(original));
  expect(actor.pay_purchase).toHaveBeenCalledTimes(2);
});
it("releases rejected historical payment selection only for an explicit new payment",async()=>{
  saved=[quoted()];mount();await click("Check payment status");await button("Pay 1 KINIC");
  actor.pay_purchase.mockImplementation(async()=>{saved[0].status={Rejected:null};return {Ok:saved[0]};});
  await click("Pay 1 KINIC");await screen.findByText(/service rejected the payment/);
  expect(actor.quote_purchase).not.toHaveBeenCalled();
  await click("New payment");funds=100_000_020n;
  await review();expect(actor.quote_purchase).toHaveBeenCalledOnce();
});
it("ignores a pending scan reply after Stop without checking or showing its cursor",async()=>{
  saved=[{...payment}];let finish!:(value:unknown)=>void;
  actor.reconcile_purchase.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  mount();await click("Scan ledger for this payment");
  await waitFor(()=>expect(actor.reconcile_purchase).toHaveBeenCalledOnce());
  const statusCalls=actor.payment_status.mock.calls.length;
  await click("Stop ledger scan");
  await act(async()=>finish({Ok:{payment:{...payment,status:{Paid:8n}},next:1n,end:12n,scanned:1n,can_continue:false}}));
  expect(actor.payment_status).toHaveBeenCalledTimes(statusCalls);
  expect(screen.queryByText(/Ledger scan: next/)).toBeNull();
  expect(screen.queryByText("Payment complete")).toBeNull();
});
it("does not publish a delayed scan failure after the client session locks",async()=>{
  saved=[{...payment}];let finish!:(value:unknown)=>void;
  actor.reconcile_purchase.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  mount();await click("Scan ledger for this payment");
  await waitFor(()=>expect(actor.reconcile_purchase).toHaveBeenCalledOnce());
  generation++;
  await act(async()=>finish({Ok:{payment,next:1n,end:12n,scanned:1n,can_continue:false}}));
  expect(screen.queryByText(/funding account changed/i)).toBeNull();
  expect(screen.queryByText(/Ledger scan: next/)).toBeNull();
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("keeps a lost purchase reply unresolved after reload even when status is Quoted",async()=>{
  actor.pay_purchase.mockRejectedValue(Error("private lost reply"));
  const view=mount();await review();await click("Pay 1 KINIC");
  await screen.findByText("Payment needs a status check");
  view.unmount();wallet.destroy();wallet=manager();mount();
  await click("Check payment status");await screen.findByText("Payment needs a status check");
  expect(screen.queryByRole("button",{name:"Pay 1 KINIC"})).toBeNull();
  expect(screen.queryByRole("button",{name:"New payment"})).toBeNull();
  expect(screen.queryByText(/private lost reply/)).toBeNull();
  expect(actor.pay_purchase).toHaveBeenCalledOnce();expect(actor.icrc2_approve).toHaveBeenCalledOnce();
  expect(actor.quote_purchase).toHaveBeenCalledOnce();
});
it("blocks dispatch when authoritative quote terms change before confirmation",async()=>{
  mount();await review();saved[0]={...saved[0],fee:20n};await click("Pay 1 KINIC");
  await screen.findByText(/unexpected reply/);
  expect(actor.icrc2_approve).not.toHaveBeenCalled();expect(actor.pay_purchase).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"New payment"})).toBeNull();
});
it("does not purchase when approval finishes after the displayed deadline",async()=>{
  let finish!:(value:unknown)=>void;
  const time=Date.now();vi.spyOn(Date,"now").mockReturnValue(time);
  actor.icrc2_approve.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  mount();await review();await click("Pay 1 KINIC");
  await waitFor(()=>expect(actor.icrc2_approve).toHaveBeenCalledOnce());
  vi.mocked(Date.now).mockReturnValue(time+300_001);
  await act(async()=>finish({Ok:1n}));await screen.findByText(/quote has expired/);
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("does not purchase or publish completion after lock during approval",async()=>{
  let finish!:(value:unknown)=>void;
  actor.icrc2_approve.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  mount();await review();await click("Pay 1 KINIC");
  await waitFor(()=>expect(actor.icrc2_approve).toHaveBeenCalledOnce());generation++;
  await act(async()=>finish({Ok:1n}));
  expect(actor.pay_purchase).not.toHaveBeenCalled();expect(screen.queryByText("Payment complete")).toBeNull();
});
it("preserves a definitive approval refusal without submitting or replacing the quote",async()=>{
  actor.icrc2_approve.mockResolvedValue({Err:{InsufficientFunds:{balance:0n}}});
  mount();await review();await click("Pay 1 KINIC");await screen.findByText(/not enough KINIC/);
  expect(actor.pay_purchase).not.toHaveBeenCalled();expect(actor.quote_purchase).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button",{name:"New payment"})).toBeNull();
});
it("does not request a replacement when prior history cannot be read",async()=>{
  actor.list_payments.mockRejectedValue(Error("offline"));mount();
  await screen.findByText(/Could not load previous payments/);
  expect((await button("Review payment")).disabled).toBe(true);expect(actor.quote_purchase).not.toHaveBeenCalled();
});
it("shows the selected historical quote amount and pays only that operation",async()=>{
  const first=quoted();const second=quoted({...first.request,operation:new Uint8Array(16).fill(5),amount_e8s:123_456_789n});
  saved=[first,second];funds=200_000_000n;mount();
  fireEvent.change(await screen.findByRole("combobox",{name:"Saved payment"}),{target:{value:"05".repeat(16)}});
  expect(screen.getByRole("textbox",{name:"KINIC amount"})).toHaveProperty("value","1.23456789");
  await click("Check payment status");await button("Pay 1.23456789 KINIC");
  actor.pay_purchase.mockImplementation(async()=>({Ok:{...second,status:{Paid:9n}}}));
  await click("Pay 1.23456789 KINIC");await screen.findByText("Payment complete");
  expect(actor.pay_purchase).toHaveBeenCalledExactlyOnceWith(second.request.operation);
  expect(actor.quote_purchase).not.toHaveBeenCalled();
});
it("renders an actionable amount correction without requesting a quote",async()=>{
  mount();await waitFor(()=>expect(screen.getByRole("button",{name:"Review payment"})).toHaveProperty("disabled",false));
  fireEvent.change(screen.getByRole("textbox",{name:"KINIC amount"}),{target:{value:"0.000000001"}});
  expect(screen.getByRole("alert").textContent).toMatch(/up to 8 decimal places/);
  expect(screen.getByRole("button",{name:"Review payment"})).toHaveProperty("disabled",true);
  expect(actor.quote_purchase).not.toHaveBeenCalled();
});
it("restores the same uncertain approval after selecting another source and returning to II",async()=>{
  actor.icrc2_approve.mockRejectedValue(Error("lost"));mount();await review();await click("Pay 1 KINIC");
  await screen.findByText("Payment needs a status check");
  fireEvent.click(screen.getByRole("radio",{name:"OISY"}));
  expect(await button("Connect OISY")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio",{name:"Internet Identity"}));
  await click("Check payment status");await screen.findByText("Payment needs a status check");
  expect(screen.queryByRole("button",{name:"Pay 1 KINIC"})).toBeNull();
  expect(screen.queryByRole("button",{name:"New payment"})).toBeNull();
  expect(actor.icrc2_approve).toHaveBeenCalledOnce();expect(actor.quote_purchase).toHaveBeenCalledOnce();
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});
it("retries confirmed-payment journal cleanup before allowing another payment",async()=>{
  mount();await review();
  const remove=Storage.prototype.removeItem;let refuse=true;
  vi.spyOn(Storage.prototype,"removeItem").mockImplementation(function(this:Storage,key:string){
    if(key.startsWith("kinic.payments.v1:") && refuse){refuse=false;throw Error("storage offline");}
    remove.call(this,key);
  });
  await click("Pay 1 KINIC");await screen.findByText("Payment complete");
  expect(screen.queryByRole("button",{name:"New payment"})).toBeNull();
  const statusCalls=actor.payment_status.mock.calls.length;
  await click("Check payment status");await button("New payment");
  expect(actor.payment_status).toHaveBeenCalledTimes(statusCalls);
  expect(actor.pay_purchase).toHaveBeenCalledOnce();
});

it("restores an OISY preference without prompting for permission or history", async () => {
  const openSigner = vi.fn();
  wallet = createWalletSessionManager({origin:location.origin, host:config.host, signerUrl:location.origin + "/sign",
    identity, transports:{openSigner}});
  const key = "kinic.payments.wallet.v1:" + JSON.stringify([location.origin,config.host]);
  localStorage.setItem(key,JSON.stringify({version:1,origin:location.origin,host:config.host,provider:"oisy",owner:owner.toText()}));
  mount();
  expect(await button("Reconnect OISY")).toBeTruthy();
  expect((await button("Review payment")).disabled).toBe(true);
  expect(openSigner).not.toHaveBeenCalled();
  expect(wallet.getSnapshot().state).toBe("remembered");
});

it("waits for the active ledger before offering an OISY connection", async () => {
  let finish!: () => void;
  actor.get_funding_config.mockReturnValue(new Promise(resolve => {finish = () => resolve({Ok:[funding]});}));
  mount();
  fireEvent.click(screen.getByRole("radio", {name:"OISY"}));
  const connect = await button("Connect OISY");
  expect(connect.disabled).toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(connect.disabled).toBe(false));
});

it("requires a restored Plug to grant scopes, keeps it connected through an II payment, and releases it on sign-out", async () => {
  const externalOwner = Principal.fromUint8Array(Uint8Array.of(33,1));
  const plug = {isConnected:vi.fn(async()=>true),requestConnect:vi.fn(async()=>true),
    agent:{getPrincipal:async()=>externalOwner},disconnect:vi.fn(async()=>{}),createActor:vi.fn(async()=>({
      list_payments:async()=>({Ok:[]}),
    }))};
  wallet = createWalletSessionManager({origin:location.origin,host:config.host,signerUrl:location.origin + "/sign",
    identity,transports:{getPlug:()=>plug}});
  localStorage.setItem("kinic.payments.wallet.v1:" + JSON.stringify([location.origin,config.host]),
    JSON.stringify({version:1,origin:location.origin,host:config.host,provider:"plug",owner:externalOwner.toText()}));
  let finishDiscovery!: () => void;
  const discovery = new Promise(resolve => {finishDiscovery = () => resolve({Ok:[funding]});});
  actor.get_funding_config.mockReturnValue(discovery);
  const c=client(quoted());
  const funded=vi.fn(async()=>{});
  const view=renderReact(<VaultFundingProvider config={config} identity={identity} manager={wallet}><Funding client={c} onFunded={funded}/></VaultFundingProvider>);
  const authorize = await button("Authorize Plug");
  await act(async () => { fireEvent.click(authorize); });
  expect(plug.requestConnect).not.toHaveBeenCalled();
  await act(async () => finishDiscovery());
  expect((await button("Review payment")).disabled).toBe(true);
  await click("Authorize Plug");
  await waitFor(()=>expect(wallet.getSnapshot().state).toBe("connected"));
  await waitFor(()=>expect(plug.requestConnect).toHaveBeenCalledWith(expect.objectContaining({whitelist:[config.canister,ledger.toText()]})));
  expect(wallet.hasScopes(vaultFundingScopes(config.canister,ledger.toText()))).toBe(true);
  fireEvent.click(screen.getByRole("radio",{name:"Internet Identity"}));
  await click("Check payment status");await click("Pay 1 KINIC");await screen.findByText("Payment complete");
  expect(actor.pay_purchase).toHaveBeenCalledExactlyOnceWith(saved[0].request.operation);
  expect(wallet.getSnapshot().account?.owner).toBe(externalOwner.toText());
  view.rerender(<VaultFundingProvider config={config} identity={identity} manager={wallet}><p>Another route</p></VaultFundingProvider>);
  expect(plug.disconnect).not.toHaveBeenCalled();
  view.rerender(<VaultFundingProvider config={config} manager={wallet}><p>Signed out</p></VaultFundingProvider>);
  await waitFor(()=>expect(plug.disconnect).toHaveBeenCalledOnce());
});

it("displays and scans the journaled operation when another is first in history",async()=>{
  const other=quoted({...payment.request,operation:new Uint8Array(16).fill(5),amount_e8s:120_000_000n});
  other.status={Unknown:null};other.uncertain=true;
  const p={...payment,reconciliation:[{start:0n,next:3n,end:10n,spender:Principal.fromText(config.canister),
    lease:0n,lease_until:0n,lease_generation:0n}]} as Payment;
  saved=[other,p];
  const scope={origin:location.origin,host:config.host,spender:config.canister,ledger:ledger.toText(),payer:{provider:"ii" as const,
    owner:owner.toText()},target:{kind:"vault" as const,beneficiary:owner.toText()}};
  createRecoveryStore(localStorage).put({version:1,scope,id:"04".repeat(16),stage:"purchase-dispatched",context:encodeVaultRecoveryContext(p.request,p)});
  actor.reconcile_purchase.mockResolvedValue({Ok:{payment:p,next:4n,end:10n,scanned:1n,can_continue:false}});
  mount();const select=await screen.findByRole("combobox",{name:"Saved payment"});
  expect(select).toHaveProperty("value","04".repeat(16));
  expect(select).toHaveProperty("disabled",true);
  expect(screen.getByText("Ledger scan: next 3 of 10.")).toBeTruthy();
  await click("Check payment status");await click("Resume ledger scan");
  await screen.findByText("Ledger scan: next 4 of 10.");
  expect(actor.payment_status.mock.calls.every(([id])=>String(id)===String(p.request.operation))).toBe(true);
  expect(actor.reconcile_purchase).toHaveBeenCalledExactlyOnceWith(p.request.operation);
  expect(actor.pay_purchase).not.toHaveBeenCalled();
});

it("never checks a replacement journal while the original payment is displayed",async()=>{
  const c=client(), funded=async()=>{};
  const view=renderReact(<VaultFundingProvider config={config} identity={identity} manager={wallet}><Funding client={c} onFunded={funded}/><span>Initial</span></VaultFundingProvider>);
  await review();
  const original=saved[0];
  const scope={origin:location.origin,host:config.host,spender:config.canister,ledger:ledger.toText(),
    payer:{provider:"ii" as const,owner:owner.toText()},target:{kind:"vault" as const,beneficiary:owner.toText()}};
  const store=createRecoveryStore(localStorage), [record]=store.list(scope);
  const other={...quoted({...original.request,operation:new Uint8Array(16).fill(5)}),status:{Unknown:null},uncertain:true};
  store.remove(scope,record.id);
  store.put({version:1,scope,id:"05".repeat(16),stage:"purchase-dispatched",context:encodeVaultRecoveryContext(other.request,other)});
  saved=[other];
  view.rerender(<VaultFundingProvider config={config} identity={identity} manager={wallet}><Funding client={c} onFunded={funded}/><span>Updated</span></VaultFundingProvider>);
  await click("Check payment status");
  await waitFor(()=>expect(screen.getByText(/account changed/i)).toBeTruthy());
  expect(actor.payment_status).not.toHaveBeenCalled();
  expect(actor.pay_purchase).not.toHaveBeenCalled();
  expect(actor.reconcile_purchase).not.toHaveBeenCalled();
  expect(store.list(scope)[0].id).toBe("05".repeat(16));
});

it("opens the SDK local signer at the verified replica gateway", async () => {
  // The pinned SDK accepts HTTP on bare localhost, including nondefault ports.
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  function Connect() {
    const {session} = useVaultFundingSession();
    return <button onClick={() => void session!.manager.connect("oisy", []).catch(() => {})}>Connect test signer</button>;
  }
  renderReact(<VaultFundingProvider config={config} identity={identity}><Connect/></VaultFundingProvider>);
  fireEvent.click(screen.getByRole("button",{name:"Connect test signer"}));
  await waitFor(()=>expect(open).toHaveBeenCalledWith(new URL("/sign",config.host).href,
    "relyingPartyWindow",expect.any(String)));
});
