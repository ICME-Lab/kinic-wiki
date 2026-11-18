// Synthetic UI gate entry only: this is not II/vetKD acceptance.
import { useEffect } from "react";
import { VaultChrome } from "../src/chrome";
import { createRoot } from "react-dom/client";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient, ok, bytes } from "@kinic/vault-client";
import { importKey } from "@kinic/vault-crypto";
import { Funding } from "../src/funding";
import type { Payment, VaultActor } from "@kinic/vault-client/contracts";
import type { Header } from "@kinic/vault-client/contracts";
import { VaultWorkspace } from "../src/vault/workspace";
import { fixtureNetwork } from "./network";
import { EditorView } from "../../packages/ui/node_modules/@codemirror/view";
import "../src/style.css";
const fixtureIdentity = Ed25519KeyIdentity.generate();
const network = fixtureNetwork(fixtureIdentity.getPrincipal());
class UIFixtureClient extends VaultClient {
  override async open(h: Header) {
    this.selectOwnedVault(h);
    const ticket = this.session.capture();
    const root = await importKey(new Uint8Array(32).fill(8));
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
  identity: fixtureIdentity,
  canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  local: true,
});
await client.open(network.headers[0]);
await client.save(
  { kind: "note", title: "Synthetic private note" },
  new TextEncoder().encode("Private fixture text"),
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
        <h1 className="text-xl font-semibold">Synthetic funding fixture</h1>
        <p className="my-4 text-sm">
          Simulated ledger responses only. No real ledger, funds, or
          authoritative payment evidence.
        </p>
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
    if (new URLSearchParams(location.search).get("state") !== "opened") return;
    const timer = window.setInterval(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Vault 1 · Active",
      );
      if (button && !button.disabled) {
        window.clearInterval(timer);
        button.click();
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <VaultChrome />
      <main className="vault-page">
        <VaultWorkspace client={client} />
        <p className="mt-4 text-xs text-muted">
          Synthetic data fixture — no private data or remote canister.
        </p>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("state") === "funding" ? (
    <FundingFixture />
  ) : (
    <Fixture />
  ),
);
