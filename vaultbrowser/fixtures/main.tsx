import { EditorView } from "../../packages/ui/node_modules/@codemirror/view";
// Synthetic actor and identity exist only in this separate fixture entry, never in the product route.
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { importKey } from "@kinic/vault-crypto";
import type {
  Header,
  Revision,
  VaultActor,
} from "@kinic/vault-client/contracts";
import { VaultWorkspace } from "../src/vault/workspace";
import "../src/style.css";
const fixtureIdentity = Ed25519KeyIdentity.generate();
const header: Header = {
  published_slot: [],
  generation: [
    {
      version: 2,
      canister: Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
      owner: fixtureIdentity.getPrincipal(),
      vault: new Uint8Array(16),
      nonce: new Uint8Array(32).fill(1),
      epoch: 0n,
      key_name: "test_key_1",
    },
  ],
  recovery_verifier: [],
  id: new Uint8Array(16),
  epoch: 0n,
  sequence: 1n,
  key_name: "test_key_1",
  state: { Active: null },
  normal: [],
  recovery: [],
  backup_at: [],
  backup_sequence: [],
};
const revision: Revision = {
  vault: header.id,
  object: new Uint8Array(16).fill(1),
  revision: 1n,
  sequence: 1n,
  plain_size: 30n,
  manifest: new Uint8Array(),
  chunk_hashes: [],
  deleted: false,
};
const actor = {
  get_config: async () => ({
    Ok: [
      {
        origin: location.origin,
        rp_id: "localhost",
        key_name: "test_key_1",
        minimum_cycles: 0n,
      },
    ],
  }),
  global_capacity: async () => ({
    Ok: {
      used: 16777216n,
      limit: 209715200n,
      accounting_reserved: 16777216n,
      overcommitted: false,
      overage: 0n,
      legacy_excess: 0n,
    },
  }),
  account_balance: async () => ({ Ok: 1_000_000_000n }),
  cleanup_status: async () => ({ Ok: [] }),
  list_payments: async () => ({ Ok: [] }),
  list_vaults: async () => ({ Ok: [header] }),
  list_unfinished_vaults: async () => ({ Ok: [] }),
  list_pending_uploads: async () => ({ Ok: { entries: [], next: [] } }),
  get_vault_header: async () => ({ Ok: header }),
  get_quota: async () => ({
    Ok: { current: 30n, charged: 100n, reserved: 0n, limit: 104857600n },
  }),
  list_history: async () => ({ Ok: { entries: [revision], next: [] } }),
  list_credentials: async () => ({
    Ok: [{ id: new Uint8Array([1]) }, { id: new Uint8Array([2]) }],
  }),
  list_objects: async () => ({ Ok: { entries: [revision], next: [] } }),
  get_active_export_for_vault: async () => ({ Ok: [] }),
} as unknown as VaultActor;
class SyntheticClient extends VaultClient {
  override async unlock(value: Header) {
    this.session.lock();
    this.header = value;
    const raw = new Uint8Array(32);
    this.session.bindRoot(await importKey(raw), value.generation[0]!, raw);
  }
  override async items() {
    return [
      {
        revision,
        metadata: {
          kind: "note" as const,
          title: "Synthetic travel checklist",
        },
        searchText: "Synthetic travel checklist",
      },
    ];
  }
  override async read() {
    return {
      metadata: { kind: "note" as const, title: "Synthetic travel checklist" },
      plaintext: new TextEncoder().encode(
        "# Synthetic checklist\n\n- Keep backup offline\n- Verify recovery secret",
      ),
    };
  }
}
const client = new SyntheticClient({
  actor,
  identity: fixtureIdentity,
  canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  local: true,
});
Object.assign(window, {
  vaultFixture: {
    editor: () => {
      const el = document.querySelector(".cm-content");
      return el ? EditorView.findFromDOM(el as HTMLElement) : undefined;
    },
    session: client.session,
  },
});
function Fixture() {
  useEffect(() => {
    if (new URLSearchParams(location.search).get("state") !== "unlocked")
      return;
    let step = 0;
    const timer = setInterval(() => {
      const target = [
        "Vault 1",
        "Unlock with passkey",
        "Synthetic travel checklist",
      ][step];
      const button = [...document.querySelectorAll("button")].find(
        (el) => el.textContent?.trim() === target,
      );
      if (button && !button.disabled) {
        button.click();
        step++;
      }
      if (step === 3) clearInterval(timer);
    }, 30);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="mx-auto max-w-6xl p-4">
      <p className="mb-4 text-sm">
        Synthetic data fixture — no private data or remote canister.
      </p>
      <VaultWorkspace client={client} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
