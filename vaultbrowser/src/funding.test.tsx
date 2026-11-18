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
import { VaultFundingProvider } from "./funding/session";
import { encodeVaultRecoveryContext } from "./funding/adapter";

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
  reconcile_purchase:vi.fn(), account_balance:vi.fn(), get_funding_config:vi.fn(), icrc2_approve:vi.fn(),
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
  localStorage.setItem(key,"{");mount();
  expect(await screen.findByText(/payment record could not be saved or read/)).toBeTruthy();
  expect((await button("Review payment")).disabled).toBe(true);expect(localStorage.getItem(key)).toBe("{");
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
