// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { fixtureNetwork } from "../../fixtures/network";
import { VaultSettings } from "./management";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("collects without a root and treats no-work NotFound as complete", async () => {
  const x = fixtureNetwork();
  vi.spyOn(x.actor, "mutate").mockResolvedValue({ Err: { NotFound: null } });
  const client = new VaultClient({
    actor: x.actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  const changed = vi.fn(async () => {});
  render(
    <VaultSettings
      scope="account"
      client={client}
      vaultName="Vault 1"
      onBack={() => {}}
      selected={x.headers[0]}
      disabled={false}
      run={(f) => {
        void f();
      }}
      onChanged={changed}
    />,
  );
  fireEvent.click(screen.getByText("Free up unused storage"));
  await screen.findByText("Storage maintenance complete");
  expect(changed).toHaveBeenCalledOnce();
  expect(client.session.root).toBeUndefined();
});
it("incomplete confirmation never dispatches deletion", async () => {
  const x = fixtureNetwork();
  const client = new VaultClient({
    actor: x.actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  render(
    <VaultSettings
      client={client}
      vaultName="Vault 1"
      onBack={() => {}}
      selected={x.headers[0]}
      disabled={false}
      run={(f) => {
        void f();
      }}
      onChanged={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Type Vault 1 to confirm"), { target: { value: "wrong vault" } });
  expect(screen.getByText("Permanently delete this Vault").closest("button")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByText("Permanently delete this Vault"));
  await waitFor(() => expect(x.calls).toHaveLength(0));
});
