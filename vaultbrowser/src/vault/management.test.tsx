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
import { VaultEncryptedCleanup } from "./management";
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
    <VaultEncryptedCleanup
      client={client}
      selected={x.headers[0]}
      disabled={false}
      run={(f) => {
        void f();
      }}
      onChanged={changed}
    />,
  );
  fireEvent.click(screen.getByText("Encrypted storage cleanup"));
  fireEvent.click(screen.getByText("Collect expired data"));
  await screen.findByText("Cleanup complete");
  expect(changed).toHaveBeenCalledOnce();
  expect(client.session.root).toBeUndefined();
});
it("confirmation cancellation never dispatches deletion", async () => {
  const x = fixtureNetwork();
  const client = new VaultClient({
    actor: x.actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <VaultEncryptedCleanup
      client={client}
      selected={x.headers[0]}
      disabled={false}
      run={(f) => {
        void f();
      }}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("Encrypted storage cleanup"));
  fireEvent.click(screen.getByText("Permanently purge entire Vault"));
  await waitFor(() => expect(x.calls).toHaveLength(0));
});
