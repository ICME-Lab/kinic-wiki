// Synthetic UI gate entry only: this is not II/vetKD acceptance.
import {VaultRouter} from "../src/navigation";
import {DraftGuardProvider} from "../src/draft-guard";
import { useEffect } from "react";
import { VaultChrome } from "../src/chrome";
import { VaultButton } from "../src/vault/ui";
import { createRoot } from "react-dom/client";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient, ok, bytes } from "@kinic/vault-client";
import { importKey } from "@kinic/vault-crypto";
import { Funding } from "../src/funding";
import type { Payment, VaultActor } from "@kinic/vault-client/contracts";
import type { Header } from "@kinic/vault-client/contracts";
import { VaultWorkspace } from "../src/vault/workspace";
import { VaultWelcome } from "../src/vault/page";
import { fixtureNetwork } from "./network";
import { EditorView } from "../../packages/ui/node_modules/@codemirror/view";
import "../src/style.css";
const network = fixtureNetwork();
if (new URLSearchParams(location.search).get("state") === "setup") {
  network.setBalance(0n);
}
class UIFixtureClient extends VaultClient {
  override async open(h: Header, options: Parameters<VaultClient["open"]>[1] = {}) {
    if (!this.header || String(this.header.id) !== String(h.id))
      this.session.lock();
    const ticket = this.session.capture();
    await options.beforeDerive?.(h);
    this.session.check(ticket);
    const root = await importKey(new Uint8Array(32).fill(8));
    network.setFirstKeyFree(false);
    this.session.check(ticket);
    this.header = structuredClone(h);
    // Synthetic derivation only: mirror the pin installed by production open().
    Object.assign(this, { pinnedPublicKey: bytes(h.public_key) });
    this.session.bindRoot(root, {
      canister: this.canister,
      owner: this.identity.getPrincipal().toText(),
      vault: bytes(h.id),
      nonce: bytes(h.nonce),
      key_name: h.key_name,
    });
  }
  override async refreshHeader() {
    const ticket = this.session.capture();
    const h = ok(await this.actor.get_vault_header(this.header!.id));
    this.session.check(ticket);
    this.session.requireContext({
      canister: this.canister,
      owner: this.identity.getPrincipal().toText(),
      vault: bytes(h.id),
      nonce: bytes(h.nonce),
      key_name: h.key_name,
    });
    return h;
  }
}
const client = new UIFixtureClient({
  actor: network.actor,
  identity: Ed25519KeyIdentity.generate(),
  canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  local: true,
});
await client.open(network.headers[0]);
await client.save(
  { kind: "note", title: "Welcome note" },
  new TextEncoder().encode("Your private notes belong here."),
);
client.session.lock();
Object.assign(window, {
  syntheticVault: client,
  syntheticNetwork: network,
  syntheticEditor: () =>
    EditorView.findFromDOM(document.querySelector(".cm-editor")!),
});
// Keep the ordinary workspace fixture's funding policy unavailable. Only this
// explicit synthetic surface requests the fixture-only funding configuration.
if (new URLSearchParams(location.search).get("state") === "funding") {
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) =>
    fetch(
      input === "/config.json" ? "/config.json?fixture=funding" : input,
      init,
    );
}
const fundingState = { calls: 0, funded: 0 };
const fundingIdentity = Ed25519KeyIdentity.generate();
let fundingPayment: Payment = {
  preparing: false,
  reconciliation: [],
  wallet: fundingIdentity.getPrincipal(),
  request: {
    operation: new Uint8Array(16).fill(4),
    beneficiary: fundingIdentity.getPrincipal(),
    amount_e8s: 100_000_000n,
    min_credits: 20_000_000n,
    created_at_time: 100n,
  },
  config: {
    ledger: fundingIdentity.getPrincipal(),
    recipient: fundingIdentity.getPrincipal(),
    cycles_per_kinic: 100_000_000n,
  },
  fee: 10n,
  credits: 100_000_000n,
  memo: new Uint8Array(32).fill(3),
  created_at_time: 100n,
  status: { Unknown: null },
  generation: 1n,
  attempt: 1n,
  sent_at: 100n,
  uncertain: true,
};
let fundingNext = 0n;
const fundingClient = new VaultClient({
  identity: fundingIdentity,
  canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  local: true,
  actor: {
    list_payments: async () => ({ Ok: [fundingPayment] }),
    payment_status: async () => ({ Ok: [fundingPayment] }),
    pay_purchase: async () => ({ Ok: fundingPayment }),
    reconcile_purchase: async () => {
      fundingState.calls++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      fundingNext += 100n;
      fundingPayment = {
        ...fundingPayment,
        reconciliation: [
          {
            start: 0n,
            next: fundingNext,
            end: 1500n,
            spender: fundingIdentity.getPrincipal(),
            lease: 0n,
            lease_until: 0n,
            lease_generation: 0n,
          },
        ],
        status: fundingNext >= 1500n ? { Paid: 15n } : { Unknown: null },
      };
      return {
        Ok: {
          payment: fundingPayment,
          scanned: 100n,
          next: fundingNext,
          end: 1500n,
          can_continue: fundingNext < 1500n,
        },
      };
    },
  } as unknown as VaultActor,
});
Object.assign(window, { syntheticFunding: fundingState });
function FundingFixture() {
  return (
    <>
      <VaultChrome />
      <main className="vault-page">
        <Funding
          client={fundingClient}
          onFunded={async () => {
            fundingState.funded++;
          }}
        />
      </main>
    </>
  );
}
function Fixture() {
  useEffect(() => {
    const state = new URLSearchParams(location.search).get("state");
    if (state !== "opened" && state !== "key-funding-preview" && state !== "settings") return;
    const timer = window.setInterval(() => {
      if (state === "settings") {
        const title = document.querySelector<HTMLInputElement>('input[placeholder="Untitled"]');
        if (title && !title.disabled) {
          if(location.pathname!=="/settings") document.getElementById("vault-settings-toggle")?.click();
          window.clearInterval(timer);
          return;
        }
      }
      const button = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Vault 1",
      );
      if (button && !button.disabled) {
        if (state !== "settings") window.clearInterval(timer);
        button.click();
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <VaultChrome actions={<VaultButton>Sign out</VaultButton>} />
      <main className="vault-page">
        <VaultWorkspace client={client} />
      </main>
    </>
  );
}
const fixtureState = new URLSearchParams(location.search).get("state");
if (fixtureState === "key-funding" || fixtureState === "key-funding-preview") network.setBalance(23_000_000_000n);
if (fixtureState === "fresh") {
  network.headers.length = 0;
  network.setFirstKeyFree(true);
  network.setBalance(10_000_000_000n);
  Object.assign(network.actor, {
    initialize_vault_account: async () => ({ Ok: { balance: 10_000_000_000n, grant_cycles: 10_000_000_000n } }),
  });
}
createRoot(document.getElementById("root")!).render(
  <VaultRouter><DraftGuardProvider>{
  fixtureState === "welcome" ? (
    <>
      <VaultChrome />
      <main className="vault-page">
        <VaultWelcome onSignIn={() => {}} />
      </main>
    </>
  ) : fixtureState === "funding" ? (
    <FundingFixture />
  ) : (
    <Fixture />
  )}</DraftGuardProvider></VaultRouter>,
);
