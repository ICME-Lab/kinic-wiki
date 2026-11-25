// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { fixtureNetwork } from "../../fixtures/network";
import { VaultSettings } from "./management";

// jsdom lacks modal dialogs; the confirmation only needs open/close state.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
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
  fireEvent.click(screen.getByRole("button", { name: "Free up storage" }));
  await screen.findByText("Storage maintenance complete");
  expect(changed).toHaveBeenCalledOnce();
  expect(client.session.root).toBeUndefined();
});
it("runs destructive maintenance only after the confirmation is accepted", async () => {
  const x = fixtureNetwork();
  const client = new VaultClient({
    actor: x.actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  const collect = vi.spyOn(client, "collect").mockResolvedValue(undefined as never);
  const forget = vi.fn();
  render(
    <VaultSettings
      scope="account"
      client={client}
      vaultName="Vault 1"
      onBack={() => {}}
      disabled={false}
      run={(f) => {
        void f();
      }}
      onChanged={async () => {}}
      onForgetKeys={forget}
    />,
  );
  fireEvent.click(screen.getByText("Free up unused storage"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Free up unused storage?" })).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByText("Delete saved keys from this browser"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Delete saved keys from this browser?" })).getByRole("button", { name: "Cancel" }));
  await Promise.resolve();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(collect).not.toHaveBeenCalled();
  expect(forget).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Delete saved keys from this browser"));
  fireEvent.click(screen.getByRole("button", { name: "Delete keys" }));
  await waitFor(() => expect(forget).toHaveBeenCalledOnce());
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
