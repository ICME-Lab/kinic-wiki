// Synthetic UI gate entry only: this is not II/vetKD acceptance.
import { useEffect } from "react";
import { VaultChrome } from "../src/chrome";
import { createRoot } from "react-dom/client";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient, ok, bytes } from "@kinic/vault-client";
import { importKey } from "@kinic/vault-crypto";
import type { Header } from "@kinic/vault-client/contracts";
import { VaultWorkspace } from "../src/vault/workspace";
import { fixtureNetwork } from "./network";
import { EditorView } from "../../packages/ui/node_modules/@codemirror/view";
import "../src/style.css";
const network = fixtureNetwork();
class UIFixtureClient extends VaultClient {
  override async open(h: Header) {
    if (!this.header || String(this.header.id) !== String(h.id))
      this.session.lock();
    const ticket = this.session.capture();
    const root = await importKey(new Uint8Array(32).fill(8));
    this.session.check(ticket);
    this.header = structuredClone(h);
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
createRoot(document.getElementById("root")!).render(<Fixture />);
